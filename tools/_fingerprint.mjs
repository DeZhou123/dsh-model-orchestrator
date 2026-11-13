#!/usr/bin/env node
/**
 * _fingerprint.mjs — 渠道模型指纹鉴定器（dsh-model-orchestrator/tools）
 *
 * 目的：把免费/聚合渠道里「非语义命名」的模型 id（gmodel / sn-xxx-1017 / *_latest / auto…）
 *       映射到真实模型家族，并留下可复核的证据（自述、家族校准题、usage/响应头/分词数）。
 *
 * 为什么默认走 peershare 而不是直连上游：
 *   本机 DSH 进程已经持有全部渠道凭据与各自的私有协议（Qoder 是加密推理端点、Cline 是
 *   WorkOS 前缀头、Loomy/Raccoon 是各自的代理层）。model-orchestrator 的**渠道互借**端点
 *   （/peershare/v1/stream）把这些统一暴露成一条 NDJSON 线，于是探针不必重写任何一家协议，
 *   也不需要把 key 复制到探针里；它读的是 $DSH_HOME 里已经存在的凭据。
 *
 * 用法：
 *   node tools/_fingerprint.mjs --provider loomy --model GLM-5.3-Flash
 *   node tools/_fingerprint.mjs --batch targets.json --out result.json
 *   node tools/_fingerprint.mjs --provider qoder --model gfmodel --request p1,p2
 *   node tools/_fingerprint.mjs --transport direct --base-url https://api.example.com/v1 --api-key-env MY_KEY --provider example --model some-model
 *
 * 参数（默认值见 DEFAULTS）：
 *   --provider X --model Y      单点鉴定
 *   --batch FILE                批量：{"targets":[{"provider","model","label"?}]}
 *   --out FILE                  结果落盘（JSON）；不传则打到 stdout
 *   --raw FILE                  NDJSON 原始帧日志（默认 <out>.raw.ndjson）
 *   --request p1,p2,p3          要跑哪些探针（默认全跑）
 *   --endpoint URL              peershare 端点（默认 $FP_ENDPOINT 或 http://127.0.0.1:18326）
 *   --token-file PATH           peershare token 文件（默认 $DSH_HOME/model-orchestrator/peer-token）
 *   --token VALUE               直接给 token（不写进结果，只记来源）
 *   --transport peershare|direct
 *   --base-url URL  --api-key-env NAME    direct 传输的端点与 key 来源（环境变量名）
 *   --max-requests N            总请求上限（默认 60）
 *   --min-gap-ms N              两次请求最小间隔（默认 1200）
 *   --timeout-ms N              单请求超时（默认 90000）
 *
 * 纪律（写在代码里，不靠调用者自觉）：
 *   · 串行：任何时刻只有一个请求在飞；
 *   · 429 / 区域封锁 / 402 / quota / 传输失败 → 记 unreachable，**不重试**；
 *   · 计费渠道黑名单（deepseek-official / deepseek-account）默认拒绝发请求；
 *   · 结果文件绝不写 key，只写 key 的来源路径或环境变量名。
 *
 * @module tools/_fingerprint
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'

const PROTOCOL = 'dsh-model-orchestrator/peershare-v1'

const DEFAULTS = {
  endpoint: 'http://127.0.0.1:18326',
  streamPath: '/peershare/v1/stream',
  transport: 'peershare',
  minGapMs: 1200,
  maxRequests: 60,
  timeoutMs: 90000,
  requests: ['p1', 'p2', 'p3'],
}

/** 计费渠道：一个请求都不发。 */
const BILLING_PROVIDERS = new Set(['deepseek-official', 'deepseek-account'])

/** 探针定义：短、确定、可比较。 */
export const PROBES = Object.freeze({
  p1: {
    id: 'p1',
    name: '自述',
    // 思考型模型会把预算先花在 reasoning 上；给小值会只拿到思考、拿不到答案。
    maxTokens: 1200,
    prompt: '只回答一行：你的模型名称、厂商、参数规模。不要解释。',
  },
  p2: {
    id: 'p2',
    name: '家族校准',
    maxTokens: 1000,
    prompt: [
      '回答下面两个问题，严格按格式，不要解释：',
      'A) Which number is larger: 9.11 or 9.9? Answer with the number only.',
      'B) 用恰好 5 个字说明什么是 HTTP。只输出那 5 个字。',
      '输出格式：A=<答案> B=<5个字>',
    ].join('\n'),
  },
  p3: {
    id: 'p3',
    name: '元信息/分词',
    maxTokens: 12,
    prompt: '请只回复字符：OK',
    tokenizerSample:
      '中华人民共和国国务院新闻办公室发布的白皮书指出，人工智能治理需要国际协作。' +
      'The quick brown fox jumps over the lazy dog. ' +
      '模型指纹鉴定样本 paragraph 3: 1234567890 !@#$%^&*()',
  },
})

/** 极简参数解析：--key value / --flag；重复项取最后一个。 */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

/** $DSH_HOME 解析：空则用 ~/.dsh（与 DSH 一致）。 */
export function resolveDshHome(env = process.env) {
  const raw = String(env.DSH_HOME ?? '').trim()
  return raw === '' ? path.join(os.homedir(), '.dsh') : raw
}

/**
 * 解析传输配置。**只返回来源描述，不把明文写进结果**（明文仅在内存里用于发请求）。
 */
export function resolveTransportConfig(args, env = process.env) {
  const transport = String(args.transport ?? DEFAULTS.transport)
  if (transport === 'direct') {
    const baseUrl = String(args['base-url'] ?? env.FP_BASE_URL ?? '').trim()
    const keyEnv = String(args['api-key-env'] ?? env.FP_API_KEY_ENV ?? '').trim()
    if (baseUrl === '') throw new Error('direct 传输需要 --base-url（或 FP_BASE_URL）')
    const key = keyEnv === '' ? '' : String(env[keyEnv] ?? '')
    return {
      transport: 'direct',
      baseUrl,
      keyEnvName: keyEnv,
      key,
      keySource: keyEnv === '' ? '(未提供 key)' : 'env:' + keyEnv,
      endpointSource: args['base-url'] !== undefined ? 'cli:--base-url' : 'env:FP_BASE_URL',
      streamPath: '/chat/completions',
    }
  }
  const tokenFile = String(args['token-file'] ?? env.FP_TOKEN_FILE ?? path.join(resolveDshHome(env), 'model-orchestrator', 'peer-token'))
  const inline = args.token ?? env.FP_TOKEN
  let token = inline === undefined ? '' : String(inline)
  let source = inline === undefined ? '' : 'cli:--token'
  if (token === '') {
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); source = 'file:' + tokenFile }
    catch (error) { throw new Error('读不到 peershare token：' + tokenFile + '（' + String(error && error.message) + '）') }
  }
  const endpoint = String(args.endpoint ?? env.FP_ENDPOINT ?? DEFAULTS.endpoint).replace(/\/+$/, '')
  return {
    transport: 'peershare',
    endpoint,
    endpointSource: args.endpoint !== undefined ? 'cli:--endpoint' : (env.FP_ENDPOINT ? 'env:FP_ENDPOINT' : 'default'),
    tokenFile, token, keySource: source,
    streamPath: String(args['stream-path'] ?? DEFAULTS.streamPath),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 把 NDJSON 帧收敛成 {text, reasoning, kinds, meta, finishReason}。 */
export function digestFrames(lines) {
  const texts = []; const reasoning = []; const kinds = []; const meta = {}
  let finishReason = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let json
    try { json = JSON.parse(trimmed) } catch { continue }
    if (json.error !== undefined && json.error !== null) {
      meta.error = { code: String(json.error.code ?? ''), status: json.error.status ?? null, message: String(json.error.message ?? '') }
      continue
    }
    const chunk = json.chunk ?? json
    const type = String(chunk.type ?? '')
    if (type !== '' && type !== 'chunk') kinds.push(type)
    if (type === 'text-delta') texts.push(String(chunk.text ?? chunk.delta ?? ''))
    else if (type === 'reasoning-delta') reasoning.push(String(chunk.text ?? chunk.delta ?? ''))
    else if (type === 'usage') {
      // usage 帧的形状在不同适配器下有两种：字段平铺，或整体挂在 chunk.usage 下。
      const u = chunk.usage !== undefined && chunk.usage !== null ? chunk.usage : chunk
      meta.usage = {
        inputTokens: u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens ?? null,
        outputTokens: u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens ?? null,
        cachedInputTokens: u.cachedInputTokens ?? u.cached_input_tokens ?? null,
        totalTokens: u.totalTokens ?? u.total_tokens ?? null,
      }
      meta.usageRaw = JSON.stringify(chunk).slice(0, 240)
    } else if (type === 'finish') {
      finishReason = chunk.reason ?? null
      if (chunk.usage !== undefined) meta.usage = chunk.usage
    }
  }
  return { text: texts.join(''), reasoning: reasoning.join(''), kinds, meta, finishReason }
}

/** 发一次请求；不重试（429/封锁由上层记 unreachable）。 */
export async function sendOnce(config, target, probe, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULTS.timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('fingerprint timeout'), timeoutMs)
  const prompt = probe.id === 'p3' ? probe.tokenizerSample : probe.prompt
  const started = Date.now()
  try {
    let url; let headers; let body
    if (config.transport === 'peershare') {
      url = config.endpoint + config.streamPath
      headers = { 'content-type': 'application/json', authorization: 'Bearer ' + config.token }
      body = JSON.stringify({
        protocol: PROTOCOL, provider: target.provider, model: target.model,
        options: { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: probe.maxTokens },
      })
    } else {
      url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions'
      headers = { 'content-type': 'application/json' }
      if (config.key !== '') headers.authorization = 'Bearer ' + config.key
      body = JSON.stringify({ model: target.model, messages: [{ role: 'user', content: prompt }], max_tokens: probe.maxTokens, stream: true, stream_options: { include_usage: true } })
    }
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    const responseHeaders = {}
    for (const [k, v] of res.headers.entries()) responseHeaders[k] = v
    const raw = await res.text()
    if (config.transport === 'direct') {
      const dataLines = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter((l) => l !== '[DONE]')
      const texts = []; let usage = null; let finish = null
      for (const line of dataLines) {
        try {
          const j = JSON.parse(line)
          const choice = j.choices && j.choices[0]
          const piece = choice && choice.delta ? choice.delta.content : undefined
          if (typeof piece === 'string') texts.push(piece)
          if (choice && choice.finish_reason) finish = choice.finish_reason
          if (j.usage) usage = { inputTokens: j.usage.prompt_tokens ?? null, outputTokens: j.usage.completion_tokens ?? null }
        } catch { /* 非 JSON 行忽略 */ }
      }
      return { ok: res.status === 200, status: res.status, text: texts.join(''), reasoning: '', usage, headers: responseHeaders, finishReason: finish, error: res.status === 200 ? null : { code: 'HTTP_' + res.status, message: raw.slice(0, 400) }, ms: Date.now() - started }
    }
    const digest = digestFrames(raw.split('\n'))
    return {
      ok: res.status === 200 && digest.meta.error === undefined,
      status: res.status,
      text: digest.text,
      reasoning: digest.reasoning,
      usage: digest.meta.usage ?? null,
      usageRaw: digest.meta.usageRaw ?? null,
      kinds: digest.kinds.slice(0, 12),
      headers: responseHeaders,
      finishReason: digest.finishReason,
      error: digest.meta.error ?? (res.status === 200 ? null : { code: 'HTTP_' + res.status, message: raw.slice(0, 400) }),
      ms: Date.now() - started,
    }
  } catch (error) {
    return { ok: false, status: 0, text: '', reasoning: '', usage: null, headers: {}, error: { code: 'THROW', message: String(error && error.message ? error.message : error) }, ms: Date.now() - started }
  } finally { clearTimeout(timer) }
}

/** 只保留「非生成侧」对证头，且不可能带上游凭据。 */
export function pickHeaders(headers) {
  const keep = ['date', 'server', 'content-type', 'x-request-id', 'x-trace-id', 'cf-ray', 'cf-cache-status', 'via', 'x-model', 'x-upstream', 'x-served-by', 'retry-after']
  const out = {}
  for (const key of keep) {
    const value = headers ? headers[key] : undefined
    if (value !== undefined && value !== null && String(value).length <= 200) out[key] = String(value)
  }
  return out
}

/** 单目标：串行跑探针，遇「不可达」即停（省额度）。返回结构化结果，不抛错。 */
export async function fingerprintOne(config, target, options = {}) {
  const requests = Array.isArray(options.requests) && options.requests.length > 0 ? options.requests : DEFAULTS.requests
  const gapMs = Number(options.minGapMs ?? DEFAULTS.minGapMs)
  const budget = options.budget
  const probes = {}
  const notes = []
  let spent = 0
  let blocked = null
  for (const id of requests) {
    const probe = PROBES[id]
    if (probe === undefined) { notes.push('未知探针：' + id); continue }
    if (budget !== undefined && budget.remaining() <= 0) { blocked = blocked ?? '请求预算耗尽'; break }
    if (spent > 0) await sleep(gapMs)
    const result = await sendOnce(config, target, probe, options)
    spent++
    if (budget !== undefined) budget.spend()
    probes[id] = {
      ok: result.ok, status: result.status, ms: result.ms, usage: result.usage, usageRaw: result.usageRaw ?? null,
      text: String(result.text ?? '').slice(0, 800),
      reasoningHead: String(result.reasoning ?? '').slice(0, 400),
      kinds: result.kinds ?? null,
      headersSubset: pickHeaders(result.headers),
      error: result.error,
      prompt: probe.id === 'p3' ? '(固定分词样本 ' + probe.tokenizerSample.length + ' 字符)' : probe.prompt,
    }
    if (!result.ok) {
      const code = String(result.error ? result.error.code : '')
      const http = Number(result.status ?? 0)
      if (http === 429 || http === 402 || http === 403 || code === 'RATE_LIMIT' || code === 'QUOTA_EXCEEDED' || code === 'TRANSPORT' || code === 'AUTH') {
        blocked = String(result.error && result.error.message ? result.error.message : code).slice(0, 200)
        break
      }
    }
  }
  return {
    id: target.provider + '/' + target.model, provider: target.provider, model: target.model,
    label: target.label ?? null, transport: config.transport,
    credentialSource: config.keySource, endpointSource: config.endpointSource ?? null,
    requestsSpent: spent, unreachable: blocked, notes, probes, verdict: target.verdict ?? null,
  }
}

/** 线索合并（只给提示，判定由报告复核）。 */
export function suggestFamily(entry) {
  const selfText = String(entry.probes && entry.probes.p1 ? entry.probes.p1.text : '') + '\n' + String(entry.probes && entry.probes.p1 ? entry.probes.p1.reasoningHead : '')
  const calibration = String(entry.probes && entry.probes.p2 ? entry.probes.p2.text : '')
  const hints = []
  const families = [
    ['glm', /glm|智谱|zhipu|z-ai/i], ['qwen', /qwen|通义|阿里|alibaba|千问/i],
    ['deepseek', /deepseek|深度求索|幻方/i], ['kimi', /kimi|moonshot|月之暗面/i],
    ['minimax', /minimax|海螺|abab/i], ['hunyuan', /hunyuan|混元|腾讯|tencent/i],
    ['doubao', /doubao|豆包|字节|bytedance|seed/i], ['spark', /spark|星火|讯飞|iflytek|xunfei/i],
    ['sensenova', /sensenova|商汤/i], ['gemini', /gemini|google|谷歌/i], ['gpt', /gpt|openai|chatgpt/i],
  ]
  for (const pair of families) if (pair[1].test(selfText)) hints.push('自述命中 ' + pair[0])
  if (/(flash|flashx|turbo|mini|lite|highspeed)/i.test(selfText)) hints.push('自述含低档词')
  if (/(pro|ultra|prime|opus)/i.test(selfText)) hints.push('自述含高档词')
  if (/9\.9/.test(calibration)) hints.push('校准题出现 9.9')
  const providerClue = {
    qoder: 'qoder 目录（pack.js）把该 id 标为 GLM/Qwen/Kimi/DeepSeek/MiniMax 之一 —— 需实测确认',
    qodercn: 'qodercn 目录（CN 表）同上',
    zcode: 'zcode = 智谱 z.ai（Anthropic 协议）',
    trae: 'trae = 字节；目录里同名 id 通常就是真身',
    cline: 'cline = 聚合商，厂商前缀常在 id 里',
    loomy: 'loomy = 讯飞代理层，id 多为借来的名字',
    raccoon: 'raccoon = 商汤，sn- 前缀',
    minimax: 'minimax 直系',
    'our-free-model': 'our-free-model 是匿名化免费桶，id 被改写',
    workbuddy: 'workbuddy = 角色位（default/fast/balanced/primary/deep），需靠指纹还原',
  }[entry.provider]
  if (providerClue !== undefined) hints.push(providerClue)
  return hints
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = resolveTransportConfig(args, process.env)
  const targets = []
  if (args.batch !== undefined) {
    const parsed = JSON.parse(fs.readFileSync(String(args.batch), 'utf8'))
    const list = Array.isArray(parsed) ? parsed : parsed.targets
    for (const row of list ?? []) targets.push({ provider: String(row.provider), model: String(row.model), label: row.label, verdict: row.verdict })
  }
  if (args.provider !== undefined && args.model !== undefined) targets.push({ provider: String(args.provider), model: String(args.model) })
  if (targets.length === 0) { process.stderr.write('用法：node tools/_fingerprint.mjs --provider X --model Y | --batch targets.json\n'); process.exit(2) }
  const minGapMs = Number(args['min-gap-ms'] ?? DEFAULTS.minGapMs)
  const timeoutMs = Number(args['timeout-ms'] ?? DEFAULTS.timeoutMs)
  const maxRequests = Number(args['max-requests'] ?? DEFAULTS.maxRequests)
  const requests = String(args.request ?? DEFAULTS.requests.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
  let used = 0
  const budget = { remaining: () => maxRequests - used, spend: () => { used++ } }
  const results = []; const raw = []
  for (const target of targets) {
    if (BILLING_PROVIDERS.has(target.provider)) {
      results.push({ id: target.provider + '/' + target.model, provider: target.provider, model: target.model, unreachable: '计费渠道：按纪律不发请求', probes: {}, requestsSpent: 0 })
      continue
    }
    if (budget.remaining() <= 0) {
      results.push({ id: target.provider + '/' + target.model, provider: target.provider, model: target.model, unreachable: '总预算耗尽', probes: {}, requestsSpent: 0 })
      continue
    }
    const entry = await fingerprintOne(config, target, { requests, minGapMs, timeoutMs, budget })
    entry.hints = suggestFamily(entry)
    entry.requestsRemaining = budget.remaining()
    results.push(entry); raw.push(entry)
    process.stdout.write('· ' + entry.id + ' [' + entry.requestsSpent + 'req] ' + (entry.unreachable ? '不可达: ' + String(entry.unreachable).slice(0, 90) : 'p1=' + JSON.stringify(String(entry.probes && entry.probes.p1 ? entry.probes.p1.text : '').slice(0, 100))) + '\n')
  }
  const payload = {
    version: 1, at: new Date().toISOString(), transport: config.transport,
    endpoint: config.transport === 'peershare' ? config.endpoint + config.streamPath : config.baseUrl,
    credentialSource: config.keySource, requestsUsed: used, requestsBudget: maxRequests, results,
  }
  const outPath = args.out !== undefined ? String(args.out) : null
  if (outPath !== null) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8')
    const rawPath = args.raw !== undefined ? String(args.raw) : outPath.replace(/\.json$/i, '') + '.raw.ndjson'
    fs.writeFileSync(rawPath, raw.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    process.stdout.write('已写 ' + outPath + '\n')
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  }
}

const entryPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1])
if (entryPath.endsWith('_fingerprint.mjs')) {
  main().catch((error) => { process.stderr.write('失败：' + String(error && error.stack ? error.stack : error) + '\n'); process.exit(1) })
}
