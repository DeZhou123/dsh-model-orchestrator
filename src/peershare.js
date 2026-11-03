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

/**
 * 攒头阶段的总等待上限：上游一帧都不吐时最多等这么久，然后回 504。
 *
 * 数值不是新拍的，是照抄借用方 adapter 的 IDLE_TIMEOUT_MS（120s）——旧写法在请求发出
 * 的瞬间就 writeHead(200)，那条空闲看门狗从「收到响应头」开始计时，所以「上游首块挂死」
 * 的失败上限一直是 120s。现在头要等首帧输出才发，看门狗还没开始计时；不在中继这一侧
 * 补同一把尺子，挂死就会从「120s 记一次失败」退化成「无限等下去」。
 */
const HEAD_WAIT_MS = 120_000

/** Promise.race 的哨兵：区分「拿到帧」与「超时」。 */
const HEAD_TIMEOUT = Symbol('peershare-head-timeout')

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
 * @param {number} [options.headTimeoutMs] - 攒头阶段的空闲上限（默认 HEAD_WAIT_MS；只为测试可调）
 * @param {(message: string) => void} [options.log]
 */
export async function startPeerShareServer(options) {
  const config = typeof options.config === 'function' ? options.config : () => ({})
  const models = typeof options.models === 'function' ? options.models : () => []
  const stream = options.stream
  const selfProvider = String(options.selfProvider ?? '').toLowerCase()
  const log = typeof options.log === 'function' ? options.log : () => {}
  const headWaitMs = Number.isFinite(Number(options.headTimeoutMs)) && Number(options.headTimeoutMs) > 0
    ? Math.trunc(Number(options.headTimeoutMs))
    : HEAD_WAIT_MS

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

      // ── 首块即失败不再以 HTTP 200 开局（2026-11-03）───────────────────────────
      //
      // 旧写法在**还不知道上游能不能出货**时就 `writeHead(200)`，于是「上游一上来就
      // 失败」和「正常出货」在线上是同一个状态码，失败只藏在 NDJSON 里。实测后果
      // （_supervisor/_tmp/probe-peer-200-vs-error.mjs，2026-11-03 基线）分三种：
      //   · 上游抛错            → 借用方 adapter 解析到 {type:'error'} 才抛出来，账本记 rate；
      //   · 上游回 in-band error finish（workbuddy 的 `transport error: fetch failed` 就是这个形状）
      //                          → 借用方 agent 环路的调用在账本里**一条记录都没有**；
      //   · 上游 0 帧直接结束    → 借用方记成 calls+1 / errors=0 / **status=ok**，
      //                          也就是「成功但 0 输出」—— 一条死车道在健康账本里看着完全健康。
      //
      // 规则只有一条：**还没出货的失败体现在 HTTP 状态上，已经出过货的失败只体现在 NDJSON 里**
      // （finish 块 + end 帧的 outcome 标记）。两边都报会双计 —— 借用方 observe.js 对 thrown
      // 记一次，in-band finish 又经 agent/request-error 记一次，一条故障在账本里变成两条。
      //
      // 所以：先把上游开头的帧攒在内存里（上限 MAX_HEAD_FRAMES 帧，都是有界的控制帧），
      // 直到出现第一帧**真输出**才把 200 钉下去；在那之前失败还来得及回真状态码。
      // 只等控制帧不会推迟首字延迟：攒到的帧在决定开局的那一刻原样刷出去。
      //
      // 必须一起补的副作用：头不再在 t=0 发出，借用方 adapter 的 120s 空闲看门狗（从
      // 「收到响应头」起算）就管不到首帧之前了 —— 挂死的上游会从「120s 记一次失败」退化成
      // 「等到调用方自己的超时」。所以攒头阶段自带 HEAD_WAIT_MS 上限，超时回 504。
      const MAX_HEAD_FRAMES = 32
      /** 「出货」的口径与 observe.js 的 isFirstFrame 一致：block-start / usage 这类控制帧不算。 */
      const isOutput = (chunk) => chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' || chunk?.type === 'tool-call-delta'
      /** 上游把失败当成一个普通 finish 块送出来（in-band error），这是线上最常见的一种形状。 */
      const inBandFailure = (chunk) => {
        if (chunk?.type !== 'finish') return null
        const kind = String(chunk?.reason?.kind ?? '')
        if (kind !== 'error' && kind !== 'aborted') return null
        return chunk.reason?.failure ?? { code: kind, message: kind }
      }
      /** 上游给的 status 只有落在 4xx/5xx 才能当 HTTP 状态码用，否则一律 502。 */
      const httpStatusOf = (value) => {
        const status = Number(value?.status)
        return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502
      }
      const failureFrame = (error, fallbackCode) => ({
        code: String(error?.code ?? fallbackCode),
        status: httpStatusOf(error),
        message: (error instanceof Error ? error.message : String(error?.message ?? error)).slice(0, 500),
        source: 'upstream',
      })

      const openHead = () => {
        if (headSent) return
        headSent = true
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-peershare-protocol': PEERSHARE_PROTOCOL,
        })
      }

      const pending = []
      let headSent = false
      let failedEarly = null
      let upstreamDone = false
      let iterator
      // 攒头阶段的空闲计时：每拿到一帧就重新起算（老口径是「多久没有新数据」，不是「总共多久」），
      // 到期还没等到首帧输出就回 504 —— 见 HEAD_WAIT_MS 那段注释。
      let headDeadline = Date.now() + headWaitMs
      const nextFrame = () => {
        let timer
        const guard = new Promise((resolve) => {
          timer = setTimeout(() => resolve(HEAD_TIMEOUT), Math.max(0, headDeadline - Date.now()))
          timer.unref?.()
        })
        const pendingNext = iterator.next()
        // 超时先返回之后，这条 next() 仍可能因为 abort 而 reject；先挂个吞口，
        // 否则 Node 会把「无人处理的拒绝」升级成进程退出。
        pendingNext.catch(() => {})
        return Promise.race([pendingNext, guard]).finally(() => clearTimeout(timer))
      }
      try {
        iterator = stream(request)[Symbol.asyncIterator]()
      } catch (error) {
        // llm 服务还没就绪时这里是同步抛的，旧写法也一样进不了流。
        failedEarly = failureFrame(error, 'PEERSHARE_STREAM_FAILED')
      }
      while (failedEarly === null && !headSent && pending.length < MAX_HEAD_FRAMES) {
        let next
        try {
          next = await nextFrame()
        } catch (error) {
          failedEarly = failureFrame(error, 'PEERSHARE_STREAM_FAILED')
          break
        }
        if (next === HEAD_TIMEOUT) {
          failedEarly = {
            code: 'UPSTREAM_SILENT',
            status: 504,
            message: '上游 ' + headWaitMs + 'ms 内没有吐任何帧，按不可达处理：' + provider + '/' + model,
            source: 'relay',
          }
          controller.abort('peershare head timeout')
          break
        }
        headDeadline = Date.now() + headWaitMs
        if (next.done === true) {
          upstreamDone = true
          break
        }
        pending.push(next.value)
        const failure = inBandFailure(next.value)
        if (failure !== null) {
          failedEarly = failureFrame(failure, 'UPSTREAM_ERROR')
          break
        }
        if (isOutput(next.value)) openHead()
      }
      // 攒到帧数上限仍没出货（一长串控制帧）：照常开局，别把「慢」写成「死」。
      if (failedEarly === null && !headSent && upstreamDone) {
        // 一帧输出都没有就结束：旧协议回 200 + end，借用方记成成功。现在它是一条 502。
        // 代价说清楚：真·合法空回复也会被记一次 transient，但借用方拿到 0 token 本来就
        // 等于这次调用没用，账本把它当失败比当成功诚实。
        failedEarly = {
          code: 'UPSTREAM_EMPTY',
          status: 502,
          message: '上游没有产生任何输出就结束了：' + provider + '/' + model + '（0 输出无法与失败区分）',
          source: 'relay',
        }
      }
      if (failedEarly !== null && !headSent) {
        // 对侧已经断开时（res.close 里已经 abort 过）不再往一个死连接上写错误体，
        // 也不把它记成「上游首块失败」—— 那是取消，不是故障。
        if (!res.destroyed && !res.writableEnded) {
          log('互借中继上游首块失败：' + provider + '/' + model + ' → ' + failedEarly.code + ' ' + failedEarly.message)
          sendJson(res, failedEarly.status, { protocol: PEERSHARE_PROTOCOL, error: failedEarly })
        }
        return
      }
      openHead()
      let pipe = true
      for (const chunk of pending) {
        if (!write({ type: 'chunk', chunk })) {
          pipe = false // 对侧已经断开：别再往下游要块（abort 已在 close 监听里发过）
          break
        }
      }

      let outcome = 'ok'
      let failure = null
      if (pipe && !res.writableEnded) {
        try {
          for (;;) {
            const next = await iterator.next()
            if (next.done === true) break
            const band = inBandFailure(next.value)
            if (!write({ type: 'chunk', chunk: next.value })) break
            if (band !== null) {
              // 已经出过货，撤不回 200 了：in-band 失败原样转发，由借用方的 finish 块记账，
              // 这里只把它记进 end 帧的 outcome，让线上协议本身可判定。
              outcome = 'error'
              failure = { ...failureFrame(band, 'UPSTREAM_ERROR'), kind: String(next.value?.reason?.kind ?? 'error') }
            }
          }
        } catch (error) {
          outcome = 'error'
          failure = failureFrame(error, 'PEERSHARE_STREAM_FAILED')
          write({ type: 'error', error: failure })
        }
      }
      write({ type: 'end', outcome, ...(failure === null ? {} : { error: failure }) })
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
