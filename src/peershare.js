/**
 * 渠道互借 · 出借方（Host 半）。
 *
 * 为什么是「线路级中继」而不是「共享配置文件」：A 与 B 注册的 provider 列表几乎一样
 * （同一个 channel-pack），真正不同的是账号与额度。要让一次调用消耗**对侧**的额度，
 * 请求就必须在对侧进程里发出去。于是：出借方把 ctx.llm.stream 暴露成一个端点，
 * 借用方把它注册成一条普通 provider（见 peershare-adapter.js）。
 *
 * 为什么线上协议不是 OpenAI wire：两端是同一个插件版本，可以直接收发 harness 自己的
 * GenerateOptions / StreamChunk（都可无损 JSON 化）。走 OpenAI wire 要多写一遍
 * messages/tool_calls/SSE 的双向翻译，多出来的每行都是「翻译错了但看起来通了」的风险。
 * 协议带 protocol 字段，不匹配就明确拒绝。
 *
 * 安全模型三条：
 * 1. 只有 token 持有者能用（token 落 $DSH_HOME/model-orchestrator/peer-token，timingSafeEqual）；
 * 2. 只借「车道」不借「权限」：只能调本机当前可路由且未 denied 的 provider/model，
 *    allow/deny 可再收窄；开了互借不会多出一条本机没有的渠道；
 * 3. 拒绝回环：请求带 x-peershare-hop，或 provider 名等于本机借用车道，直接 508。
 *
 * @module src/peershare
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { timingSafeEqual, randomBytes } from 'node:crypto'

/** 线上协议标识；两端版本不一致时明确拒绝，不做兼容猜测。 */
export const PEERSHARE_PROTOCOL = 'dsh-model-orchestrator/peershare-v1'

/** 请求体上限（一次 agent 请求的 messages 可以很大，但必须有界）。 */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** 回环标记头：出现即说明这条请求已经被中继过一次。 */
const HOP_HEADER = 'x-peershare-hop'

/** 读 token 文件；不存在就生成一把（32 字节 base64url）。 */
export function loadOrCreateToken(userDir, fileName = 'peer-token') {
  const file = path.join(userDir, fileName)
  try {
    const stored = fs.readFileSync(file, 'utf8').trim()
    if (stored !== '') return { token: stored, created: false, path: file }
  } catch {
    /* 还没生成过 */
  }
  const token = randomBytes(32).toString('base64url')
  try {
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* 只读 home 仍可在内存里用这一次 */
  }
  return { token, created: true, path: file }
}

/** 常量时间比较；长度不同直接 false（不泄露长度）。 */
export function tokenMatches(candidate, expected) {
  const a = String(candidate ?? '')
  const b = String(expected ?? '')
  if (a === '' || b === '') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

/** 从请求头取 bearer（或 x-peershare-token）。 */
function bearerOf(req) {
  const header = String(req.headers?.authorization ?? '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return String(req.headers?.['x-peershare-token'] ?? '').trim()
}

/** 读请求体，带硬上限。 */
async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体超过上限 ' + limit + ' 字节')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 一条 JSON 响应。 */
function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 出借清单：本机当前**可以**借出去的车道。
 *
 * 只从实时目录挑，且要求 denied !== true —— 一条在本机被屏蔽/冷却的车道，借给对侧
 * 只会把同一堵墙转嫁过去。allow/deny 按 provider 名二次收窄。
 *
 * **借来的车道不再借出去**（2026-10-29 修）：目录里 provider 等于本机借用车道名
 * （默认 'peer'）的行是**对侧**的车道，把它放进出借清单等于把「A 借给 B 的东西
 * 再借回给 A」——两端都是 both 时会形成环路，请求在两端之间来回中继，直到某一边
 * 的 hop 守卫或超时把它掐断。实测 B 侧一度把 1201 条对侧车道挂进了自己的出借清单。
 */
export function lendableRows(rows, options = {}) {
  const allow = new Set((options.allowProviders ?? []).map(value => String(value).toLowerCase()).filter(Boolean))
  const deny = new Set((options.denyProviders ?? []).map(value => String(value).toLowerCase()).filter(Boolean))
  const selfProvider = String(options.selfProvider ?? '').toLowerCase()
  const out = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const provider = String(row?.provider ?? '')
    const model = String(row?.model ?? '')
    if (provider === '' || model === '') continue
    const key = provider.toLowerCase()
    // 借来的车道：provider 名就是本机的借用车道，或目录层已经打了 borrowed 标记。
    if (row.borrowed === true) continue
    if (selfProvider !== '' && key === selfProvider) continue
    if (deny.has(key)) continue
    if (allow.size > 0 && !allow.has(key)) continue
    if (row.denied === true) continue
    const id = provider + '/' + model
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      provider,
      model,
      id,
      name: String(row.modelName ?? model),
      family: row.family ?? null,
      contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : null,
      vision: row.vision === true,
      free: row.freeLane === true,
      multiplier: Number.isFinite(row.multiplier) ? row.multiplier : null,
      quality: Number.isFinite(row.quality) ? Math.round(row.quality * 1000) / 1000 : null,
      tags: Array.isArray(row.tags) ? [...row.tags] : [],
    })
  }
  return out
}

/**
 * 起中继服务。
 *
 * config() 每次请求现读（改 allow/deny 不用重新 bind）；host/port 变了由调用方关掉重开。
 *
 * @param {object} options
 * @param {() => object} options.config - {enabled, host, port, token, label, version, allowProviders, denyProviders}
 * @param {() => object[]} options.models - 可出借的行
 * @param {(request: object) => AsyncIterable<object>} options.stream - 本机的 llm.stream
 * @param {string} options.selfProvider - 本机借用车道名（回环守卫）
 * @param {(message: string) => void} [options.log]
 */
export async function startPeerShareServer(options) {
  const config = typeof options.config === 'function' ? options.config : () => ({})
  const models = typeof options.models === 'function' ? options.models : () => []
  const stream = options.stream
  const selfProvider = String(options.selfProvider ?? '').toLowerCase()
  const log = typeof options.log === 'function' ? options.log : () => {}

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      log('互借中继请求失败：' + (error instanceof Error ? error.message : String(error)))
      if (!res.headersSent) {
        sendJson(res, 502, { protocol: PEERSHARE_PROTOCOL, error: { code: 'RELAY_FAILED', message: String(error?.message ?? error) } })
      } else {
        res.end()
      }
    })
  })

  async function handle(req, res) {
    const settings = config()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const routePath = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-peershare-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      })
      res.end()
      return
    }
    if (settings.enabled === false) {
      sendJson(res, 503, { protocol: PEERSHARE_PROTOCOL, error: { code: 'SHARE_OFF', message: '本机未开启渠道互借（出借方关闭）' } })
      return
    }
    if (!tokenMatches(bearerOf(req), settings.token)) {
      sendJson(res, 401, { protocol: PEERSHARE_PROTOCOL, error: { code: 'UNAUTHORIZED', message: 'token 不匹配' } })
      return
    }
    if (req.headers[HOP_HEADER] !== undefined) {
      sendJson(res, 508, { protocol: PEERSHARE_PROTOCOL, error: { code: 'RELAY_LOOP', message: '这条请求已被中继过一次，拒绝再次中继（互借不能指向自己）' } })
      return
    }

    if (routePath === '/peershare/v1/hello' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, {
        protocol: PEERSHARE_PROTOCOL,
        label: String(settings.label ?? ''),
        version: String(settings.version ?? ''),
        models: models().length,
        at: Date.now(),
      })
      return
    }

    if (routePath === '/peershare/v1/models' && req.method === 'GET') {
      const list = models()
      sendJson(res, 200, { protocol: PEERSHARE_PROTOCOL, count: list.length, models: list })
      return
    }

    if (routePath === '/peershare/v1/stream') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { protocol: PEERSHARE_PROTOCOL, error: { code: 'METHOD', message: '只接受 POST' } })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        sendJson(res, 400, { protocol: PEERSHARE_PROTOCOL, error: { code: 'BAD_BODY', message: error instanceof Error ? error.message : String(error) } })
        return
      }
      if (body?.protocol !== PEERSHARE_PROTOCOL) {
        sendJson(res, 400, {
          protocol: PEERSHARE_PROTOCOL,
          error: { code: 'PROTOCOL_MISMATCH', message: '协议不匹配：期望 ' + PEERSHARE_PROTOCOL + '，收到 ' + String(body?.protocol ?? '(缺失)') },
        })
        return
      }
      const provider = String(body.provider ?? '')
      const model = String(body.model ?? '')
      if (provider === '' || model === '') {
        sendJson(res, 400, { protocol: PEERSHARE_PROTOCOL, error: { code: 'BAD_REQUEST', message: 'provider/model 不能为空' } })
        return
      }
      if (selfProvider !== '' && provider.toLowerCase() === selfProvider) {
        sendJson(res, 508, { protocol: PEERSHARE_PROTOCOL, error: { code: 'RELAY_LOOP', message: 'provider ' + provider + ' 是本机的借用车道，不能再借出去' } })
        return
      }
      const lendable = models()
      if (!lendable.some(row => row.provider === provider && row.model === model)) {
        sendJson(res, 404, {
          protocol: PEERSHARE_PROTOCOL,
          error: { code: 'NOT_LENDABLE', message: '这条车道不在本机出借清单里：' + provider + '/' + model },
        })
        return
      }

      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-peershare-protocol': PEERSHARE_PROTOCOL,
      })
      const write = (value) => {
        if (res.writableEnded || res.destroyed) return false
        res.write(JSON.stringify(value) + '\n')
        return true
      }

      const controller = new AbortController()
      res.once('close', () => {
        if (!res.writableEnded) controller.abort('peershare client closed')
      })

      const request = {
        ...(body.options ?? {}),
        provider,
        model,
        signal: controller.signal,
        // 不带 sessionId：这不是本机的任何会话；purpose 非空让观察器按「非 agent 调用」
        // 记账（健康、延迟、token 照记，但不计入任何会话的单轮预算）。
        purpose: 'peershare',
      }
      delete request.sessionId
      try {
        for await (const chunk of stream(request)) {
          if (!write({ type: 'chunk', chunk })) break
        }
        write({ type: 'end' })
      } catch (error) {
        write({
          type: 'error',
          error: {
            code: String(error?.code ?? 'PEERSHARE_STREAM_FAILED'),
            status: Number.isFinite(Number(error?.status)) ? Number(error.status) : undefined,
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
      if (!res.writableEnded) res.end()
      return
    }

    sendJson(res, 404, { protocol: PEERSHARE_PROTOCOL, error: { code: 'NOT_FOUND', message: '没有这个路由：' + routePath } })
  }

  const boot = config()
  // 兜底也走回环：配置层已经默认 127.0.0.1，这里空值不能反而放宽到全网可达。
  const host = String(boot.host ?? '').trim() || '127.0.0.1'
  const wantedPort = Number.isFinite(Number(boot.port)) && Number(boot.port) > 0 ? Math.trunc(Number(boot.port)) : 0
  const address = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(wantedPort, host, () => resolve(server.address()))
  })
  return {
    host: address?.address ?? host,
    port: address?.port ?? 0,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export default startPeerShareServer
