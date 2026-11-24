/**
 * Model Orchestrator — Host half.
 *
 * One job: keep every model request on the best available lane, using live
 * evidence first and the measured priority report second, and switch by itself
 * when a lane runs out of quota or starts refusing traffic.
 *
 * How a switch actually happens matters, so it is spelled out once here:
 *
 * - The kernel's `agent/request` waterfall re-runs on **every attempt**, and its
 *   result is the proposed call config. `agent/request-error` may return
 *   `{ kind: 'retry' }` to re-run the failed step, which re-resolves that config
 *   — so a failure can legitimately land on a different model in the same step.
 * - This plugin drives the kernel's own per-session model selection (the same
 *   `ModelSelectionRef` the composer's model picker uses) **and** appends the
 *   durable `model/selection` event through `sessionController`. The event is
 *   what keeps the browser picker, the session log, the model's change notice
 *   and the panel's model name all agreeing with what was actually dispatched.
 *   Writing only the object (the old behaviour) left the picker showing a model
 *   that was no longer being called.
 * - A failure first retries the **same model on another channel**. Only when the
 *   whole model group is unusable does the router change model. That is the
 *   difference between "switch the quota" and "switch the brain".
 * - When no session controller is mounted, a plain `agent/request` listener
 *   overrides the config so routing still works in a headless composition.
 *
 * @module index.js
 */

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { createDataset, familyFor, writeJsonAtomic } from './src/dataset.js'
import { createHealth, KIND } from './src/health.js'
import { createCatalog } from './src/catalog.js'
import { createChannelData } from './src/channels.js'
import { loadOrCreateToken, lendableRows, startPeerShareServer } from './src/peershare.js'
import { createPeerAdapter } from './src/peershare-adapter.js'
import { createObserver } from './src/observe.js'
import { createInflight } from './src/inflight.js'
import {
  evaluate, preferenceConflicts, rankGroups, rankLanes, readNeeds, resolvePreferenceGroup, selectRoute,
} from './src/router.js'
import { CONNECTIVITY, DEFAULT_CONFIG } from './src/policy-defaults.js'
import { foldKey } from './src/families.js'
import { installHttpApi } from './src/http.js'
import { registerAgentSurface } from './src/tools.js'
import { datasetFromReport } from './src/report-import.js'
import { resolveConfig, sanitizePatch } from './src/config.js'
import { createProbe, resolveIntervalMs } from './src/probe.js'

export const name = 'model-orchestrator'

/** `llm` is what the plugin exists for. The rest degrades feature by feature. */
export const inject = ['llm']

export const version = '2.17.0'

/**
 * 这条 provider 是不是「借来的聚合车道」。
 *
 * 互借把对侧几百个模型挂在同一个 provider 名下，本机并不拥有它：车道级的
 * 「这条渠道不能服务」在这里等于「对侧全灭」，而那从来不是一次失败能证明的事。
 * 判定只认配置里的 peerProvider，不猜名字。
 *
 * @param {object} config - resolved orchestrator config.
 * @param {string} provider
 * @returns {boolean}
 */
function isBorrowerProvider(config, provider) {
  const peer = config?.peerShare
  if (peer === null || peer === undefined || peer.enabled !== true) return false
  const self = String(peer.peerProvider ?? '').trim().toLowerCase()
  if (self === '') return false
  return String(provider ?? '').trim().toLowerCase() === self
}

/** The DSH home, resolved the same way the rest of the profile resolves it. */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** Read JSON, returning an empty object instead of throwing. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** One-line description of a route for logs. */
function routeLabel(route) {
  return route === null || route === undefined ? '—' : route.provider + '/' + route.model
}

/** Whether two routes are the same lane and effort. */
function sameRoute(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/** Whether two routes are the same model (provider may differ). */
function sameModel(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return left === right
  return left.model === right.model
}

/**
 * 换道预算之外还允许的换道次数（LOCAL PATCH 2026-11-16）。
 *
 * 判据：实测 38 个以 error 收场的回合里，13 个在**还有可用车道**的时候因为
 * `maxSwitchesPerStep` 用尽而失败；每一个这样的回合都要用户手动重试一次。
 * 多换两次的代价是一次请求，回合失败的代价是一次人工介入——两害相权取其轻。
 * 上限仍然存在，避免一条真死的目录把整轮变成扫描器。
 */
const EXTRA_SWITCHES = 2 // 兜底值；实际读 config.switchOverdraft（见 recover 的 canSwitch）

/**
 * 这些失败不该触发回合级自动续跑（LOCAL PATCH 2026-11-16）。
 *
 * 自动续跑解决的是「渠道坏了」——换一条车道就能继续。下面这些不是：
 *  - 用户/宿主主动停的（ABORTED、INTERRUPTED）：续跑等于跟用户对着干；
 *  - 上下文超限：同一个上下文再跑一遍会在同一处再超一次，正确出路是压缩；
 *  - 我们自己的请求不合法：换渠道也一样不合法。
 */
const AUTO_RESUME_EXCLUDED = new Set([
  'ABORTED',
  'INTERRUPTED',
  'CANCELLED',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_REQUEST',
  'UNSUPPORTED_REASONING_EFFORT',
])

/**
 * 一条车道的稳定键。用 NUL 分隔是因为 provider 与 model 里都可能出现 "/"。
 *
 * 与 router 的 `inspectLane` 必须逐字一致——那边的 exclude 是同一套键。
 */
function laneKey(provider, model) {
  return String(provider ?? '') + '\u0000' + String(model ?? '')
}

/** 可中断的等待。信号已中止时立刻返回，绝不把回合拖在 sleep 里。 */
function sleep(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    if (signal === undefined || signal === null) return
    if (signal.aborted === true) return done()
    signal.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 递归冻结（等价于 dsh-util-values 的 deepFreeze，几行就够）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/**
 * 造一条已冻结的 user 消息（与 dsh-session-relay 同款）。
 *
 * 刻意不 import `@deepseek-ai/dsh-llm`：那份 `createUserMessage` 做的事就是
 * `deepFreeze(structuredClone({ ...input, id: randomUUID() }))`，而多一个 peer
 * 依赖就多一个装不上的机会（profile 的 node_modules 里没有 @deepseek-ai/dsh-llm）。
 * 用内置 crypto 自己造，插件就是零 dsh 依赖，装到哪个 profile 都能跑。
 */
function userMessage(input) {
  return deepFreeze(structuredClone({
    role: 'user',
    content: [{ type: 'text', text: String(input.text) }],
    source: { kind: input.kind },
    id: randomUUID(),
  }))
}

/**
 * Host plugin body.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [rawConfig] - the loader row's config.
 */
export function apply(ctx, rawConfig = {}) {
  const home = resolveHome()
  const userDir = path.join(home, 'model-orchestrator')
  const overridesFile = path.join(userDir, 'overrides.json')
  try {
    fs.mkdirSync(userDir, { recursive: true })
  } catch {
    /* a read-only home degrades persistence, not routing */
  }

  const readOverrides = () => readJson(overridesFile)
  // 配置审计（LOCAL PATCH 2026-11-20）：overrides.json 一个月内被无记录改动至少
  // 3 次（prefer→off→prefer），每次都是事后体检才发现。每次经插件写入都留一条
  // diff 审计（时间、改了哪些键、从什么到什么）；直接改文件绕过插件的漂移由
  // 下面的启动自检兜住。审计只追加，超 200KB 截留最近 100 行。
  const auditFile = path.join(userDir, 'overrides-audit.jsonl')

  // 契约漂移检测（LOCAL PATCH 2026-11-20）：启动时与每次插件写入后各跑一次。
  // AGENTS.md 常驻契约：mode=auto + strategy=economy + 计费渠道常驻 deny。
  // 只告警不自动改回——用户显式改配置是合法操作，但要看得见。
  const checkContractDrift = (cfg, logger) => {
    try {
      const drift = []
      if (cfg.mode !== 'auto') drift.push({ key: 'mode', expected: 'auto', actual: cfg.mode })
      if (cfg.strategy !== 'economy') drift.push({ key: 'strategy', expected: 'economy', actual: cfg.strategy })
      for (const billed of ['deepseek-official', 'deepseek-account']) {
        if (!Array.isArray(cfg.denyProviders) || !cfg.denyProviders.includes(billed)) {
          drift.push({ key: 'denyProviders', expected: '包含 ' + billed, actual: (cfg.denyProviders || []).join(',') || '(空)' })
        }
      }
      const alertFile = path.join(userDir, 'drift-alert.json')
      if (drift.length > 0) {
        const alert = { status: 'drift', at: new Date().toISOString(), contract: 'AGENTS.md 模型选择契约', drift }
        fs.writeFileSync(alertFile, JSON.stringify(alert, null, 2))
        logger?.warn?.('[model-orchestrator] 配置漂移告警：' + drift.map(d => `${d.key} 期望 ${d.expected}，实际 ${d.actual}`).join('；') + '。详见 model-orchestrator/drift-alert.json')
      } else if (fs.existsSync(alertFile)) {
        fs.writeFileSync(alertFile, JSON.stringify({ status: 'ok', at: new Date().toISOString() }, null, 2))
      }
    } catch { /* 自检失败不影响调度 */ }
  }

  const writeOverrides = (value) => {
    try {
      const prev = readOverrides() ?? {}
      writeJsonAtomic(overridesFile, value)
      try {
        checkContractDrift(resolveConfig(rawConfig, value), ctx.logger)
      } catch { /* 写入后自检失败不影响审计 */ }
      try {
        const changes = {}
        for (const key of new Set([...Object.keys(prev), ...Object.keys(value)])) {
          if (JSON.stringify(prev[key]) !== JSON.stringify(value[key])) {
            changes[key] = { from: prev[key], to: value[key] }
          }
        }
        if (Object.keys(changes).length > 0) {
          fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), via: 'plugin', changes }) + '\n')
          if (fs.statSync(auditFile).size > 200_000) {
            const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n')
            fs.writeFileSync(auditFile, lines.slice(-100).join('\n') + '\n')
          }
        }
      } catch {
        /* 审计失败不影响配置写入 */
      }
    } catch {
      /* keep the in-memory value even when it cannot be persisted */
    }
  }

  const dataset = createDataset({ userDir })

  const runtime = {
    config: resolveConfig(rawConfig, readOverrides()),
    patch: { ...(rawConfig ?? {}) },
  }
  if (runtime.config.enabled === false) return

  // ── 契约漂移自检（启动时一次；写入后由 writeOverrides 内再检）────────────
  checkContractDrift(runtime.config, ctx.logger)

  // The ledger is created after `runtime` because its repeated-rejection policy
  // is read from the live config on every failure: the panel may change the
  // threshold, and the next rejection must obey the value in effect then.
  const health = createHealth({
    userDir,
    persistMs: DEFAULT_CONFIG.persistIntervalMs,
    requestPolicy: () => runtime.config,
    // 互借车道是聚合体：一次失败只证明对侧**那一个模型**不可用，不能把整条车道
    // （= 对侧几百个模型）判死。判据每次现读配置，关掉互借后旧记录也不再被当聚合体。
    isAggregator: (provider) => isBorrowerProvider(runtime.config, provider),
  })
  health.load()

  const channelData = createChannelData({
    home,
    channelPackDir: runtime.config.channelPackDir,
    freeModelDir: runtime.config.freeModelDir,
    enabled: runtime.config.channelData,
    freeEnabled: runtime.config.freeModelData,
    logger: ctx.logger,
  })
  channelData.refresh()

  const catalog = createCatalog({
    ctx,
    dataset,
    channelData,
    getConfig: () => runtime.config,
    clock: () => Date.now(),
  })

  /** @type {Map<string, object>} live sessions keyed by SessionId */
  const sessions = new Map()
  let sessionController = null
  let desktopRuntime = null

  /**
   * Live open-call accounting, shared by every session in this process.
   *
   * It has to be process-wide, not per-session: the whole point is that two
   * sessions see each other's load. See `src/inflight.js` and CONCURRENCY in
   * `src/policy-defaults.js`.
   */
  const inflight = createInflight({ staleMs: () => runtime.config.concurrencyStaleMs })

  const observer = createObserver({
    health,
    inflight,
    onSample: (sample) => {
      const state = sample.sessionId === undefined ? undefined : sessions.get(sample.sessionId)
      if (state === undefined) return
      // 一次成功的调用就是这条车道活着的证据：把它从"本轮死车道"里放出来
      // （LOCAL PATCH 2026-11-16）。少了这一句，一次瞬时抖动会把一条车道钉到
      // 回合结束——偏好模式明明恢复了，候选池里却没有它，表现为"偏好没生效"。
      const revived = laneKey(sample.provider, sample.model)
      if (state.stepDeadLanes instanceof Set) state.stepDeadLanes.delete(revived)
      if (state.turnDeadLanes instanceof Set) state.turnDeadLanes.delete(revived)
      // A title or compaction call spends the lane's quota but is not part of the
      // conversation's token budget; counting it would trip the economy switch
      // on work the user never asked for.
      if (sample.purpose !== '') return
      if (Number.isFinite(sample.inputTokens) && sample.inputTokens > 0) state.lastInputTokens = sample.inputTokens
      if ((sample.purpose === undefined || sample.purpose === '')
        && Number.isFinite(sample.cacheReadTokens) && sample.cacheReadTokens > 0) {
        state.lastCacheReadTokens = sample.cacheReadTokens
        state.lastCacheLane = { provider: String(sample.provider ?? ''), model: String(sample.model ?? '') }
      }
      state.turnTokens += Number(sample.outputTokens ?? 0)
      state.requests += 1
    },
    onFailure: (failure) => {
      const state = failure.sessionId === undefined ? undefined : sessions.get(failure.sessionId)
      if (state === undefined) return
      state.lastFailureAt = Date.now()
      // 流式中途抛错/零输出到不了 agent/request-error 的 recover 路径
      // （LOCAL PATCH 2026-11-20）：旧代码只记 lastFailureAt，车道要等冷却账本
      // 生效才被避开——短冷却（30s）内 autoResume 续跑可能再撞同一条。这里把
      // 失败车道直接计入本步/本轮死车道集合，与 recover 的排除面一致。
      // 只认 agent 循环调用（purpose 为空）；用户主动停止（ABORTED）车道无罪。
      if ((failure.thrown === true || failure.empty === true)
        && failure.purpose === undefined
        && String(failure.failure?.code ?? '').toUpperCase() !== 'ABORTED') {
        const deadKey = laneKey(failure.provider, failure.model)
        if (state.stepDeadLanes instanceof Set) state.stepDeadLanes.add(deadKey)
        if (state.turnDeadLanes instanceof Set) state.turnDeadLanes.add(deadKey)
      }
    },
  })

  // The session controller owns the kernel's per-session model selection. A
  // nested inject, because reading `ctx.get('sessionController')` at apply time
  // races the host half that publishes it.
  ctx.inject(['sessionController'], (scoped) => {
    sessionController = scoped.sessionController
    return () => {
      sessionController = null
    }
  })
  ctx.inject(['desktopRuntime'], (scoped) => {
    desktopRuntime = scoped.desktopRuntime
    return () => {
      desktopRuntime = null
    }
  })


  // ── 渠道互借（2026-10-29）─────────────────────────────────────────────────
  // 两种角色各自独立：出借方起一个本地端点把 llm.stream 借出去；借用方把对侧的
  // 端点注册成一条普通 provider。两端都开 = both，也就是「谁的额度还够就用谁的」。
  //
  // 为什么用 ctx.inject 而不是直接读 ctx.llm：注册适配器要求 llm 服务在场，而这个
  // 服务可能比本插件晚就绪；inject 会让这一段随服务出现/消失自动重挂。
  const peerState = {
    server: null,
    serverInfo: null,
    serverError: '',
    registration: null,
    borrower: null,
    tokenInfo: null,
  }
  /** 防止看门狗与配置变更同时重起端点（syncPeerServer 自己不做并发保护）。 */
  let peerSyncInFlight = false

  function peerConfig() {
    const peer = runtime.config.peerShare ?? DEFAULT_CONFIG.peerShare
    // 启动时 loadOrCreateToken 生成的 token 只在内存里；applyConfig 重解析配置
    // 时必须保留，否则任意一次调度设置变更都会把出借端点变回空 token。
    if (peer.token === '' && peerState.tokenInfo !== null) {
      return { ...peer, token: peerState.tokenInfo.token }
    }
    return peer
  }

  /**
   * 借入 provider 现在能不能被路由。
   *
   * 借用未启用 / 没有适配器时返回 true —— 那是「不用借」，不是「借不到」，路由层的
   * enabled/role 判定已经管了这件事，这里只回答适配器自己的健康问题。
   */
  function borrowUsable() {
    const borrower = peerState.borrower
    if (borrower === null) return true
    return borrower.usable !== false
  }

  /** 出借清单：本机实时目录里可借的行。 */
  function peerLendable() {
    const peer = peerConfig()
    return lendableRows(catalog.current.rows, {
      allowProviders: peer.allowProviders,
      denyProviders: peer.denyProviders,
      // 本机的借用车道名：这条 provider 下的行是**对侧**的车道，不能再借出去，
      // 否则两端都开 both 时会互相把对方借来的车道再借回去（环路）。
      selfProvider: peer.peerProvider,
    })
  }

  /**
   * 关掉正在跑的中继（幂等）。
   *
   * 这里**必须**有超时兜底：调用它的路径是「HMR reload → dispose → stop → start」，
   * 一次卡住就意味着端点永久消失，而不是重起一次。2026-11-04 00:06 实测过这个形状：
   * `server.close()` 的回调等所有连接断开，借用方的 keep-alive 连接一直挂着，Promise
   * 永不 resolve，18326 从日志里静默消失（B 侧 35 次 ECONNREFUSED）。close() 自身已补
   * 强制掐断，这里是第二道闸——配置改坏或将来换实现时，也不能把端点挂死。
   */
  async function stopPeerServer() {
    const server = peerState.server
    peerState.server = null
    peerState.serverInfo = null
    if (server === null) return
    const closed = (async () => {
      try {
        await server.close()
      } catch (error) {
        ctx.logger?.warn?.('model-orchestrator: 关闭互借中继失败 — ' + (error instanceof Error ? error.message : String(error)))
      }
    })()
    let timer = null
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 5_000)
      timer.unref?.()
    })
    const outcome = await Promise.race([closed.then(() => 'closed'), guard])
    if (timer !== null) clearTimeout(timer)
    if (outcome === 'timeout') {
      ctx.logger?.warn?.('model-orchestrator: 关闭互借中继超时（5s），继续重起以免端点消失')
    }
  }

  /** 按当前配置重起/关停中继。配置变了就关掉重开（host/port 只在 bind 时生效）。 */
  async function syncPeerServer() {
    const peer = peerConfig()
    const wanted = peer.enabled === true && (peer.role === 'both' || peer.role === 'lend')
    if (!wanted) {
      await stopPeerServer()
      return
    }
    if (peer.token === '') {
      peerState.tokenInfo = loadOrCreateToken(userDir)
      // 没配 token 时用本机生成的那把：借用方要填的就是它，面板会把路径显示出来。
      runtime.config.peerShare = { ...peer, token: peerState.tokenInfo.token }
    }
    const info = peerState.serverInfo
    const nextPort = peerConfig().port
    if (peerState.server !== null && info !== null && info.port === nextPort && info.host === peerConfig().host) return
    await stopPeerServer()
    try {
      const started = await startPeerShareServer({
        config: () => ({
          ...peerConfig(),
          version,
        }),
        models: () => peerLendable(),
        stream: (request) => llmStream(request),
        selfProvider: peerConfig().peerProvider,
        log: (message) => ctx.logger?.warn?.('model-orchestrator: ' + message),
      })
      peerState.server = started
      peerState.serverInfo = { host: started.host, port: started.port }
      peerState.serverError = ''
      ctx.logger?.info?.('model-orchestrator: 互借出借端点已监听 ' + started.host + ':' + started.port
        + '（可借 ' + peerLendable().length + ' 条车道）')
    } catch (error) {
      peerState.serverError = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('model-orchestrator: 互借出借端点启动失败 — ' + peerState.serverError)
    }
  }

  /** 出借方真正发请求的入口：本机的 llm.stream（也就是所有车道原来的走法）。 */
  let llmStream = () => {
    throw new Error('llm 服务尚未就绪')
  }

  /**
   * llm 服务是否已挂上。探活依赖它：服务缺席时 listLanes 返回空，
   * 一轮探活没有目标就会立刻结束 —— 那比拿一个会抛的 llmStream 去打每条车道好得多。
   */
  let llmReady = false

  /** 借用方：把对侧端点注册成一条 provider。 */
  function syncPeerBorrower() {
    const peer = peerConfig()
    const wanted = peer.enabled === true && (peer.role === 'both' || peer.role === 'borrow') && peer.peerUrl !== ''
    if (!wanted) {
      if (peerState.registration !== null) {
        try {
          peerState.registration()
        } catch {
          /* 已经被卸载过 */
        }
        peerState.registration = null
        peerState.borrower = null
      }
      return
    }
    const provider = peer.peerProvider
    if (peerState.borrower === null) {
      peerState.borrower = createPeerAdapter({
        provider,
        config: () => peerConfig(),
        log: (message) => ctx.logger?.warn?.('model-orchestrator: ' + message),
      })
    }
    if (peerState.registration !== null) {
      try {
        peerState.registration()
      } catch {
        /* 忽略 */
      }
      peerState.registration = null
    }
    try {
      const handle = ctx.llm.registerAdapter([provider], peerState.borrower.adapter)
      peerState.registration = () => handle()
      ctx.logger?.info?.('model-orchestrator: 互借借用车道已注册 provider=' + provider + ' → ' + peerConfig().peerUrl)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 重挂同一个 provider 名会撞 DUPLICATE_ADAPTER；这里如实记下来，不假装成功。
      ctx.logger?.warn?.('model-orchestrator: 互借借用车道注册失败 — ' + message)
    }
  }

  ctx.inject(['llm'], (scoped) => {
    llmStream = (request) => scoped.llm.stream(request)
    llmReady = true
    syncPeerServer().catch(() => {})
    syncPeerBorrower()
    return () => {
      llmReady = false
      llmStream = () => {
        throw new Error('llm 服务已卸载')
      }
      void stopPeerServer()
      if (peerState.registration !== null) {
        try {
          peerState.registration()
        } catch {
          /* 忽略 */
        }
        peerState.registration = null
      }
    }
  })

  /** 面板/工具读的互借状态。 */
  function peerView() {
    const peer = peerConfig()
    const lendable = peerLendable()
    const borrower = peerState.borrower
    return {
      enabled: peer.enabled === true,
      role: peer.role,
      borrowWhen: peer.borrowWhen,
      label: peer.label,
      server: peerState.serverInfo === null ? null : { ...peerState.serverInfo },
      serverError: peerState.serverError,
      token: peerState.tokenInfo === null ? null : { path: peerState.tokenInfo.path, created: peerState.tokenInfo.created },
      lendable: {
        count: lendable.length,
        providers: [...new Set(lendable.map(row => row.provider))].sort(),
        sample: lendable.slice(0, 12).map(row => row.id),
        allowProviders: peer.allowProviders,
        denyProviders: peer.denyProviders,
      },
      borrow: {
        peerUrl: peer.peerUrl,
        provider: peer.peerProvider,
        registered: peerState.registration !== null,
        models: borrower === null ? [] : borrower.models.map(row => row.id),
        modelsAt: borrower === null ? 0 : borrower.modelsAt,
        error: borrower === null ? '' : borrower.modelsError,
      },
    }
  }

  /** 设置变更后让互借跟随新配置（面板与工具都走这里）。 */
  function applyPeerConfig() {
    syncPeerServer().catch(() => {})
    syncPeerBorrower()
    refreshCatalog('peer-share').catch(() => {})
    return peerView()
  }
  function selectionFor(agent) {
    if (sessionController === null) return null
    if (typeof sessionController.agents?.selectionFor !== 'function') return null
    try {
      return sessionController.agents.selectionFor(agent)
    } catch {
      return null
    }
  }

  // ── settings ──────────────────────────────────────────────────────────────
  /**
   * Apply a settings patch.
   *
   * The patch is validated before it is written, not only before it is used:
   * otherwise a rejected value would sit in `overrides.json` forever, silently
   * ignored, and the panel would show a value that is not the value in effect.
   * Only keys the caller actually sent are persisted.
   */
  function applyConfig(patch) {
    const requested = sanitizePatch(patch)
    // 对象型设置（laneGuard / peerShare / duoPeers）必须**深合并**再解析：
    // 面板只发它改的那个字段（例如 { peerShare: { enabled: true } }），若整体替换，
    // 端口与 token 会被悄悄打回默认值 —— 表现为「开一下开关，端口自己变了」。
    for (const key of ['peerShare', 'laneGuard']) {
      const incoming = requested[key]
      if (incoming === undefined || incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) continue
      const current = readOverrides()[key]
      requested[key] = (current !== null && typeof current === 'object' && !Array.isArray(current))
        ? { ...current, ...incoming }
        : incoming
    }
    const resolved = resolveConfig(runtime.patch, { ...readOverrides(), ...requested })
    const persisted = { ...readOverrides() }
    for (const key of Object.keys(requested)) persisted[key] = resolved[key]
    // A preference that was explicitly configured clears the legacy pin, so the
    // two spellings cannot fight on the next resolve.
    if (requested.preferModel !== undefined || requested.mode !== undefined) {
      persisted.pinModel = ''
      persisted.pinProvider = ''
    }
    // `manual` 的全部含义是「跟随选择器」，和自动选择直接冲突；打开自动选择时把它落到
    // auto，免得面板高亮着「手动」而实际按策略调度。
    if (requested.autoSelect === true && persisted.mode === 'manual') persisted.mode = 'auto'
    writeOverrides(persisted)
    runtime.config = resolveConfig(runtime.patch, persisted)
    // 自动生成的出借 token 不进入 overrides.json，但不能被配置重解析冲掉。
    if (runtime.config.peerShare.token === '' && peerState.tokenInfo !== null) {
      runtime.config.peerShare = { ...runtime.config.peerShare, token: peerState.tokenInfo.token }
    }
    // A settings change is an explicit instruction: forget per-session
    // preference suspensions and picker overrides so the new setting is what
    // actually runs. Clearing the applied route is what makes the change take
    // effect immediately instead of one step late — `anchorFor` falls back to
    // the header, and the next assembly re-routes from the new settings.
    for (const state of sessions.values()) {
      state.external = null
      state.preferenceExhausted = null
      state.preferenceSuspended = false
      state.manualAnchor = null
      state.appliedAnchor = null
      state.userEffort = undefined
    }
    if (requested.mode !== undefined || requested.strategy !== undefined
      || requested.reasoningEffort !== undefined || requested.preferModel !== undefined
      || requested.autoSelect !== undefined) {
      for (const state of sessions.values()) state.applied = null
    }
    // 自动选择开关：选择器必须立刻不再是锚点，而且座位上的模型应该马上变成路由
    // 结果——等下一次回答才生效会让人以为「开关没反应」。
    // 互借开关/端口/token 改动要立刻生效：出借端点按 host/port 重绑，借用车道重新注册。
    if (requested.peerShare !== undefined) {
      applyPeerConfig()
    }
    if (requested.autoSelect !== undefined) {
      for (const state of sessions.values()) {
        state.external = null
        state.applied = null
        state.appliedAnchor = null
        if (requested.autoSelect !== true) continue
        try {
          const decision = selectRoute(selectionInput(state))
          if (decision !== null && decision.blocked !== true) applyRoute(state, decision, 'auto-select')
        } catch {
          /* 还没准备好路由的会话保留上一次的路由 */
        }
      }
    }
    return publicConfig()
  }

  /**
   * 展示用的配置副本。
   *
   * 必须脱敏（FIX 2026-11-16）：`peerShare.token` 是出借端点的 bearer 凭据——拿到它
   * 就能花对侧实例的额度。它随 `action=status`／`action=summary` 原样出现在工具结果、
   * 面板轮询与**会话日志**里，等于把凭据写进每一次对话记录。出借方自己（peerConfig、
   * peershare 的 config 回调）读的是 runtime.config，不受这里影响。
   */
  function publicConfig() {
    const config = { ...runtime.config }
    const peer = config.peerShare
    if (peer !== null && peer !== undefined && typeof peer === 'object' && peer.token) {
      config.peerShare = { ...peer, token: '***redacted***' }
    }
    return config
  }

  // ── live catalog ──────────────────────────────────────────────────────────
  let lastCatalogAt = 0
  let lastChannelAt = Date.now()
  let lastPersistAt = 0

  function refreshCatalog(reason) {
    return catalog.refresh(reason)
      .then((current) => {
        lastCatalogAt = Date.now()
        // 把当前清单里的 (provider,model) 也交给账本：探活/扇出留下的幽灵记录必须能被回收，
        // 否则 health.json 会随目录规模无限增长（见 src/health.js 的 prune）。
        health.prune(
          catalog.providerIds,
          catalog.current.rows.map(row => row.provider + '\u0000' + row.model),
        )
        return current
      })
      .catch(() => catalog.current)
  }

  function refreshChannelData() {
    channelData.refresh()
    lastChannelAt = Date.now()
  }

  ctx.effect(() => {
    refreshCatalog('start')
      .then((current) => {
        ctx.logger?.info?.(
          'model-orchestrator: ' + current.rows.length + ' models across ' + current.providers.length + ' lanes'
          + ', ' + Object.keys(dataset.current.families).length + ' families from report v'
          + (dataset.current.source.shipped?.reportVersion ?? '?')
          + ', channel data: ' + (channelData.hasData() ? 'on' : 'none')
          + (current.error === undefined || current.error === '' ? '' : '; catalog error: ' + current.error),
        )
      })
      .catch(() => {})
  }, 'model-orchestrator: initial catalog')

  ctx.on('llm/adapters-updated', () => {
    refreshCatalog('adapters').catch(() => {})
  })

  // One adaptive timer instead of three fixed ones: the panel can change these
  // intervals at runtime, and a timer created at boot would keep the old value
  // forever.
  ctx.inject(['timer'], (timed) => {
    timed.effect(
      () => timed.interval(() => {
        const now = Date.now()
        if (now - lastChannelAt >= runtime.config.channelDataRefreshMs) refreshChannelData()
        if (now - lastCatalogAt >= runtime.config.catalogRefreshMs) refreshCatalog('interval').catch(() => {})
        if (now - lastPersistAt >= runtime.config.persistIntervalMs) {
          health.persist()
          lastPersistAt = now
        }
        // 出借端点的看门狗（2026-11-04）。端点「悄悄没了」是最贵的一种坏：
        // 日志里停在「已监听」，本机一切正常，只有对侧看到 ECONNREFUSED。
        // 判据只认状态位，不猜原因：该有端点却没有 → 重起一次（syncPeerServer
        // 自身幂等，已经在跑就什么都不做）。
        if (peerState.server === null && llmReady && !peerSyncInFlight) {
          const peer = peerConfig()
          const wanted = peer.enabled === true && (peer.role === 'both' || peer.role === 'lend')
          if (wanted) {
            peerSyncInFlight = true
            syncPeerServer()
              .catch(() => {})
              .finally(() => { peerSyncInFlight = false })
          }
        }
      }, 15_000),
      'model-orchestrator: housekeeping',
    )
  })

  // ── 定时渠道巡检（2026-11-03）───────────────────────────────────────────────
  //
  // 免费车道会静默死亡：某个渠道 402 额度耗尽、某个免费层永久限流、某个模型悄悄
  // 下架。这些只有"被选中并失败一次"之后账本才会知道；很久没人选它，面板上的
  // 「可用」就是假的。这一段按间隔主动探一遍，把结果写回同一本账。
  //
  // 三条不能松的约束：
  //  1. 探活请求带 purpose='probe'，observer 的 onSample 对它早退，所以绝不进会话
  //     的 turnTokenBudget；
  //  2. 冷却未到期的车道直接跳过 —— 它本来就不会被选，探了只白烧额度；
  //  3. 单条独立超时 + 并发上限，一条挂死不拖垮整轮。
  const probe = createProbe({
    getConfig: () => runtime.config,
    listLanes: async () => {
      if (!llmReady) return []
      const rows = catalog.current.rows ?? []
      const config = runtime.config
      const out = []
      for (const row of rows) {
        if (row === null || row === undefined || row.denied === true) continue
        const provider = String(row.provider ?? '')
        const model = String(row.model ?? '')
        if (provider === '' || model === '') continue
        // 借来的车道默认不探：那是拿**对侧**的账号额度给本机做体检，数量还是对侧
        // 的全部模型（实测 600 条）。探活要回答的是「本机车道会不会静默死亡」。
        if (config.probeBorrowed !== true && (row.borrowed === true || isBorrowerProvider(config, provider))) continue
        out.push({ provider, model })
      }
      return out
    },
    health,
    /**
     * 发一个最小请求。只关心「这车道活不活、首字多久」——
     * 输出内容一律丢弃，token 已经花掉，留着也没用。
     */
    probeOne: async (lane, signal) => {
      const startedAt = Date.now()
      let ttftMs = 0
      let inputTokens = 0
      let outputTokens = 0
      const request = {
        provider: lane.provider,
        model: lane.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 8,
        signal,
        purpose: 'probe',
      }
      const stream = llmStream(request)
      for await (const chunk of stream) {
        if (ttftMs === 0 && (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' || chunk?.type === 'tool-call-delta')) {
          ttftMs = Date.now() - startedAt
        }
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          const failure = chunk.reason.failure ?? {}
          throw Object.assign(new Error(String(failure.message ?? '探活失败')), { code: String(failure.code ?? 'PROBE') })
        }
        if (chunk?.type === 'usage') {
          inputTokens = Number(chunk.inputTokens ?? inputTokens)
          outputTokens = Number(chunk.outputTokens ?? outputTokens)
        }
        // 首字到手就算活：探活没有理由等模型把话说完。
        if (ttftMs > 0) break
      }
      return { ttftMs: ttftMs > 0 ? ttftMs : Date.now() - startedAt, inputTokens, outputTokens }
    },
    clock: () => Date.now(),
    logger: ctx.logger,
  })

  ctx.effect(() => {
    const stop = probe.start((tick) => {
      // 每一轮自己排下一轮：间隔按实时配置重算，面板改了值下一轮就生效。
      const timer = setTimeout(tick, Math.max(60_000, resolveIntervalMs(runtime.config)))
      timer.unref?.()
    })
    const summary = probe.status()
    ctx.logger?.info?.(
      'model-orchestrator: 渠道巡检已挂载，间隔 '
      + summary.intervalDays + ' 天，超时 ' + summary.timeoutMs + 'ms，并发 ' + summary.concurrency,
    )
    return () => {
      stop()
      ctx.logger?.info?.('model-orchestrator: 渠道巡检已停止')
    }
  }, 'model-orchestrator: lane probe')

  // ── notifications ─────────────────────────────────────────────────────────
  function notify(title, body) {
    try {
      if (typeof desktopRuntime?.notifyAttention === 'function') {
        desktopRuntime.notifyAttention({ title, body })
      }
    } catch {
      /* a notification must never break routing */
    }
  }

  // ── session bookkeeping ───────────────────────────────────────────────────
  function freshSession(agent) {
    return {
      agent,
      ref: null,
      applied: null,
      appliedAnchor: null,
      manualAnchor: null,
      lastWritten: null,
      external: null,
      headerAnchor: null,
      turn: -1,
      step: -1,
      turnTokens: 0,
      switches: 0,
      stepSwitches: 0,
      turnSwitches: 0,
      priorFailures: 0,
      requests: 0,
      scannedSeq: 0,
      scannedReplaceGeneration: -1,
      chars: 0,
      userCount: 0,
      hasImage: false,
      hasTools: false,
      lastUserText: '',
      lastInputTokens: 0,
      lastCacheReadTokens: 0,
      lastCacheLane: null,
      lastDecision: null,
      lastFailureAt: 0,
      lastSwitchAt: 0,
      preferenceExhausted: null,
      preferenceSuspended: false,
      // ── 失败恢复的会话内记忆（LOCAL PATCH 2026-11-16）─────────────────────
      // 实测：单步骤 10~22 次失败里，绝大多数是**同一条已经证明死掉的车道**
      // 被重新选回来（session-e4a79c6d 一个 step 在 qoder 上撞 10 次）。
      // 这两组集合是"这一轮里这条车道已经完了"的唯一权威判据，不依赖冷却时长。
      stepDeadLanes: new Set(),
      turnDeadLanes: new Set(),
      // 最后一搏（等冷却结束再试）在本步骤里用掉了几次。
      lastResortUsed: 0,
      extraSwitches: 0,
      // 回合因车道故障中断后自动续跑的连击计数；回合正常完成即归零。
      resumeChain: 0,
      resumeAt: 0,
      resumeTimer: null,
      // 本回合是否已经产出过内容。中断后续跑要连上它，而不是从零重来。
      turnProduced: false,
      userEffort: undefined,
      lastPreferenceNotifyAt: 0,
      // Set the moment a request actually leaves the process. `applied` is cleared
      // by a settings change, so "has this session ever called a model" cannot be
      // inferred from it — and the first-turn takeover must not re-run later.
      started: false,
    }
  }

  /** Whether this agent's conversations are the router's to drive. */
  function shouldRoute(agent) {
    if (runtime.config.routeSubagents === true) return true
    try {
      return agent?.session?.header?.origin !== 'subagent'
    } catch {
      return true
    }
  }

  /**
   * Fold only the new session events into the routing signals.
   *
   * A full rescan per step would make the orchestrator the most expensive thing
   * in the loop; the incremental cursor keeps it O(new events), and a surface
   * replacement (compaction) is the one case that needs a fresh pass.
   */
  function scanSession(state) {
    const session = state.agent.session
    const surface = session.surface
    if (state.scannedReplaceGeneration !== surface.replaceGeneration) {
      state.scannedSeq = 0
      state.scannedReplaceGeneration = surface.replaceGeneration
      state.chars = 0
      state.userCount = 0
      state.hasImage = false
      state.hasTools = false
      state.lastUserText = ''
    }
    const events = session.snapshotEvents(state.scannedSeq, session.seq)
    for (const event of events) {
      if (event.type === 'user/message') {
        const content = Array.isArray(event.data?.content) ? event.data.content : []
        for (const block of content) {
          if (block?.type === 'image') state.hasImage = true
          if (block?.type === 'text') {
            state.chars += String(block.text ?? '').length
            state.lastUserText = String(block.text ?? '')
          }
        }
        if (event.data?.source?.kind === 'user') state.userCount += 1
      } else if (event.type === 'tool/call' || event.type === 'tool/result') {
        state.hasTools = true
      } else if (event.type === 'request/header') {
        const tools = event.data?.header?.tools
        if (Array.isArray(tools) && tools.length > 0) state.hasTools = true
      }
    }
    state.scannedSeq = session.seq
  }

  /** The route the session's own durable log last dispatched. */
  function headerRoute(state) {
    try {
      const header = state.agent?.session?.requestHeader?.()
      if (header?.config?.provider !== undefined) {
        return { provider: header.config.provider, model: header.config.model }
      }
    } catch {
      /* fall through */
    }
    return null
  }

  /** The live selection the kernel will apply. */
  function liveSelection(state) {
    if (state.ref === null) {
      try {
        state.ref = selectionFor(state.agent)
      } catch {
        return null
      }
    }
    if (state.ref === null) return null
    try {
      const current = state.ref.current
      if (current === undefined || current === null) return null
      return {
        provider: String(current.provider ?? ''),
        model: String(current.model ?? ''),
        ...(typeof current.reasoningEffort === 'string' ? { reasoningEffort: current.reasoningEffort } : {}),
      }
    } catch {
      return null
    }
  }

  /**
   * Prompt size for one session.
   *
   * The last reported input token count is the accurate answer once a call has
   * succeeded; before that (and after an unusual gap) the accumulated user text
   * is a floor. Routing only needs the order of magnitude — it decides between
   * "fits anywhere" and "needs a 1M-context family".
   */
  function estimateTokens(state) {
    const fromUsage = Number(state.lastInputTokens ?? 0)
    const fromText = Math.round(state.chars / 3.2)
    return Math.max(fromUsage, fromText)
  }

  /** Needs for one session, shared by the router and the panel. */
  function needsFor(state, config = runtime.config) {
    return readNeeds({
      hasImage: state.hasImage,
      hasTools: state.hasTools,
      estimatedTokens: estimateTokens(state),
      lastUserText: state.lastUserText,
      turnTokens: state.turnTokens,
      step: state.turn,
      priorFailures: state.priorFailures,
      cacheTokens: state.lastCacheReadTokens,
      cacheLane: state.lastCacheLane,
    }, config)
  }

  /** The anchor object the router compares against. */
  function anchorFor(state, config = runtime.config) {
    const now = Date.now()
    // Manual mode means "keep the model I chose": the anchor survives a rescue
    // to a different model, so the router returns to the user's choice as soon
    // as that model has a usable channel again.
    if (effectiveMode(state) === 'manual' && state.manualAnchor !== null) return state.manualAnchor
    const header = headerRoute(state)
    state.headerAnchor = header === null ? null : withKey(header)

    // ── 自动选择 ────────────────────────────────────────────────────────────
    // The picker is a display, not an instruction: no `userChoice`, no header
    // anchor (it may be a model the user picked in an earlier, non-takeover
    // session). Only the route this plugin itself applied survives, so an
    // ongoing turn keeps its model and a resumed session re-picks by strategy.
    if (config.autoSelect === true) {
      state.external = null
      return state.appliedAnchor
    }

    // ── 首轮接管 ────────────────────────────────────────────────────────────
    // A brand-new session has no header and no route of its own yet, so the only
    // thing in effect is whatever the model picker happens to show — and that
    // value is merely the model used last time, not an instruction about THIS
    // turn. Anchoring on it (as a userChoice) makes the router hold the
    // picker's model for the first answer and only correct itself on the second
    // step, which reads as auto routing being on while the first answer ignored it.
    // In auto mode the first assembly therefore starts with no anchor at all:
    // selectRoute ranks every group and the picked route is written back into
    // the kernel selection, so the picker follows the router instead of the
    // other way round. routeFirstTurn:false restores the old behaviour, and
    // manual/prefer modes keep their own meaning of the user chose this.
    if (config.mode === 'auto' && config.routeFirstTurn !== false
      && state.started !== true && state.applied === null && state.headerAnchor === null) {
      // A selection event raised while the session was being created is part of
      // the same default, so it is dropped here too; keeping it would make the
      // very next step anchor straight back to it.
      state.external = null
      return null
    }

    if (state.external !== null) {
      const fresh = now - state.external.at <= Number(config.userChoiceTtlMs ?? 0)
      // Manual mode keeps the user's model for the whole session; auto mode
      // respects a picker change for `userChoiceTtlMs` and then resumes normal
      // optimising (the model it switched to is still the anchor, so nothing
      // jumps without a margin).
      if (config.mode === 'manual' || fresh) return withKey(state.external, true)
      state.external = null
    }
    if (state.appliedAnchor !== null) return state.appliedAnchor
    if (state.headerAnchor !== null) return state.headerAnchor
    const live = liveSelection(state)
    return live === null ? null : withKey(live, true)
  }

  function withKey(route, userChoice = false) {
    const provider = String(route.provider ?? '')
    const model = String(route.model ?? '')
    const row = catalog.row(provider, model)
    return {
      provider,
      model,
      key: row?.key ?? foldKey(familyFor(dataset, model)),
      ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(userChoice ? { userChoice: true } : {}),
    }
  }

  /** The mode the router should actually run this step. */
  function effectiveMode(state) {
    const config = runtime.config
    // 自动选择 = 选择器不再是指令。`manual` 的全部含义就是「跟随选择器」，所以它
    // 在这个开关下让位给 auto；`off` 仍然是显式的「不介入」。
    if (config.mode !== 'prefer') return config.autoSelect === true && config.mode === 'manual' ? 'auto' : config.mode
    if (state?.preferenceSuspended === true && config.preferAutoResume !== true) {
      return config.preferFallback
    }
    return 'prefer'
  }

  // ── routing ───────────────────────────────────────────────────────────────
  function selectionInput(state) {
    const config = runtime.config
    const mode = effectiveMode(state)
    const anchor = anchorFor(state, config)
    // 借入车道能不能用，只有适配器知道（端点通不通、清单拉没拉到）。把它作为
    // peerShare.borrowUsable 传给路由器：false 时整片借入车道退出候选（LOCAL PATCH
    // 2026-11-04，对应 00:09 的 ECONNREFUSED 三连）。
    const peer = config.peerShare
    const peerShare = peer === null || peer === undefined
      ? peer
      : { ...peer, borrowUsable: borrowUsable() }
    return {
      rows: catalog.current.rows,
      config: peerShare === null || peerShare === undefined ? config : { ...config, peerShare },
      health,
      // Live open-call counts, so concurrent sessions spread instead of
      // stacking on the single best-looking lane (LOCAL PATCH 2026-10-26).
      inflight,
      dataset,
      anchor,
      needs: needsFor(state, config),
      mode,
      modeFallback: config.preferFallback,
      requestedEffort: state.userEffort ?? state.applied?.reasoningEffort,
      preference: { model: config.preferModel, provider: config.preferProvider, fallback: config.preferFallback },
    }
  }

  /**
   * End-of-turn recovery: when the user's picker choice was displaced by a
   * failure, bring the model back once the turn is over. A mid-turn recovery
   * would strand the conversation between two models; waiting for the turn
   * boundary is the honest version of "auto-resume".
   */
  function restoreUserChoice(state) {
    const config = runtime.config
    if (config.mode !== 'auto' && config.mode !== 'prefer') return
    if (state.applied === null || state.external === null) return
    if (sameModel(state.applied, state.external)) return
    const row = catalog.row(state.external.provider, state.external.model)
    if (row !== undefined && row.denied) return
    if (health.stateOf(state.external.provider, state.external.model).available !== true) return
    const decision = {
      provider: state.external.provider,
      model: state.external.model,
      family: row?.family ?? foldKey(familyFor(dataset, state.external.model)),
      key: row?.key ?? foldKey(familyFor(dataset, state.external.model)),
      strategy: runtime.config.strategy,
      utility: 0,
      parts: null,
      reason: '回合结束，恢复你选择的模型',
      effort: state.external.reasoningEffort,
      mode: config.mode,
      alternatives: [],
      lanes: [],
      needs: null,
    }
    try {
      applyRoute(state, decision, 'restore')
    } catch {
      /* restoring must never fail a step */
    }
  }

  /** Write one routing decision into the kernel's own selection. */
  function applyRoute(state, decision, kind) {
    const next = {
      provider: decision.provider,
      model: decision.model,
      ...(decision.effort === undefined ? {} : { reasoningEffort: decision.effort }),
    }
    const previous = state.applied
    const changed = !sameRoute(previous, next)

    if (changed) {
      // The durable event is what the browser picker listens to. Writing only
      // the in-process object left the UI showing a model that was no longer
      // being called, because `model/selection` is the projection input.
      state.lastWritten = next
      let written = false
      try {
        if (sessionController !== null && typeof sessionController.selectForNextRequest === 'function') {
          sessionController.selectForNextRequest(state.agent, next)
          written = true
        }
      } catch {
        written = false
      }
      if (!written && state.ref !== null) {
        try {
          state.ref.current = next
        } catch {
          /* a foreign selection object must not break routing */
        }
      }
      if (state.ref !== null) {
        try {
          // `assembled` is the snapshot the kernel's own request listener
          // applies; writing it makes a failover take effect on the retry of
          // THIS step rather than only from the next step onward.
          state.ref.assembled = next
        } catch {
          /* ignore */
        }
      }

      // A lane change drops the upstream prompt cache; the evidence that the old
      // lane held it is no longer valid for this session.
      state.lastCacheReadTokens = 0
      state.lastCacheLane = null
      if (previous !== null) {
        state.switches += 1
        state.lastSwitchAt = Date.now()
      }
      health.logDecision({
        kind,
        to: routeLabel(next),
        from: previous === null ? null : routeLabel(previous),
        family: decision.family,
        strategy: decision.strategy ?? runtime.config.strategy,
        utility: Math.round(decision.utility * 1000) / 1000,
        reason: decision.reason,
        effort: next.reasoningEffort ?? null,
        sessionId: state.agent.id,
      }, runtime.config.decisionLogSize)
    } else if (state.ref !== null) {
      try {
        state.ref.assembled = next
      } catch {
        /* ignore */
      }
    }

    state.applied = next
    state.appliedAnchor = { ...withKey(next), ...(decision.key === undefined ? {} : { key: decision.key }) }
    state.lastDecision = {
      at: Date.now(),
      kind,
      mode: decision.mode ?? effectiveMode(state),
      provider: next.provider,
      model: next.model,
      key: decision.key ?? null,
      family: decision.family ?? null,
      effort: next.reasoningEffort ?? null,
      utility: Math.round(decision.utility * 1000) / 1000,
      strategy: decision.strategy ?? runtime.config.strategy,
      parts: decision.parts ?? null,
      reason: decision.reason,
      alternatives: decision.alternatives ?? [],
      lanes: decision.laneAlternatives ?? [],
      preference: decision.preference ?? null,
      exhausted: decision.exhausted ?? null,
      needs: decision.needs ?? null,
    }
    return next
  }

  /** Preference state transitions: notify once, log once. */
  function notePreference(state, decision) {
    if (decision.exhausted !== undefined && decision.exhausted !== null) {
      const previous = state.preferenceExhausted
      state.preferenceExhausted = decision.exhausted
      state.preferenceSuspended = true
      // Notify only on the transition. The countdown inside `reason` changes
      // every minute, so comparing the full sentence would fire a notification
      // per step — the one thing a notification must never do.
      const first = previous === null || previous.model !== decision.exhausted.model
      if (first) {
        health.logDecision({
          kind: 'preference-exhausted',
          to: null,
          from: decision.exhausted.model,
          family: null,
          reason: decision.exhausted.reason,
          sessionId: state.agent.id,
        }, runtime.config.decisionLogSize)
        ctx.logger?.warn?.('model-orchestrator: 偏好模型不可用 — ' + decision.exhausted.reason)
        if (runtime.config.preferNotify !== false) {
          // 措辞分两种（LOCAL PATCH 2026-11-14）：被自己的 deny 挡住时，
          // "所有渠道都不可用"是**假话**——那几条车道是好的，只是用户自己关了它们。
          // 通知里必须给出可执行的下一步，否则用户只会以为插件坏了。
          const conflicts = Array.isArray(decision.exhausted.conflicts) ? decision.exhausted.conflicts : []
          const body = conflicts.length === 0
            ? '偏好模型 ' + decision.exhausted.model + ' 的可用渠道已用尽。' + decision.exhausted.reason
              + ' 已临时改用' + fallbackName(decision.mode) + '模式。'
            : '偏好模型 ' + decision.exhausted.model + ' 的可用渠道已用尽，但其中 ' + conflicts.length
              + ' 条是被你自己的屏蔽列表挡住的：' + conflicts.map(entry => entry.denyEntry).join('、')
              + '。删除对应 deny 项可立即恢复（它们不会随时间自愈）。已临时改用'
              + fallbackName(decision.mode) + '模式。'
          notify('偏好模式已暂停', body)
        }
      }
      return
    }
    if (state.preferenceExhausted !== null || state.preferenceSuspended === true) {
      resumePreference(state, '偏好模型已有可用渠道')
    }
  }

  /**
   * 解除偏好暂停：账本记一笔、面板通知一次。
   *
   * 抽成函数是为了让「会话下一次路由」之外的第二条路径也能解除它（见 recheckPreference）。
   */
  function resumePreference(state, reason) {
    if (state.preferenceSuspended !== true && state.preferenceExhausted === null) return false
    state.preferenceExhausted = null
    state.preferenceSuspended = false
    health.logDecision({
      kind: 'preference-resumed',
      to: runtime.config.preferModel,
      from: null,
      reason,
      sessionId: state.agent.id,
    }, runtime.config.decisionLogSize)
    if (runtime.config.preferNotify !== false) {
      notify('偏好模式已恢复', '偏好模型 ' + runtime.config.preferModel + ' 重新有可用渠道。')
    }
    return true
  }

  function fallbackName(mode) {
    if (mode === 'manual') return '手动'
    if (mode === 'off') return '关闭'
    return '自动'
  }

  /**
   * 偏好此刻是不是真的「全灭」——现在这一刻的答案，不是当初记下的那一句。
   *
   * 复用 selectRoute 的 prefer 分支本身，不另写一套可用性判据：只有它能保证
   * 「面板说能用」和「路由真的会用」是同一件事。读不出来时一律返回 true ——
   * 判据出问题的时候，宁可让偏好继续跑，也不能把会话锁在降级模式里。
   */
  function preferenceUsableNow(state) {
    const config = runtime.config
    if (config.mode !== 'prefer' || String(config.preferModel ?? '') === '') return true
    try {
      const decision = selectRoute({ ...selectionInput(state), mode: 'prefer' })
      if (decision === null) return false
      return decision.exhausted === undefined || decision.exhausted === null
    } catch {
      return true
    }
  }

  /**
   * 偏好暂停的自愈（LOCAL PATCH 2026-11-05）。
   *
   * 事故形状：断网三五分钟把偏好家族判成全灭，`preferenceSuspended` 被置位；而这个
   * 标记是**会话级内存态**，只在「该会话下一次路由」时才会被重新评估——于是断网时
   * 恰好空闲的会话，网络恢复后仍然一直显示「已暂停 / 自动」，用户看到的是若干个
   * 「有的会话退出了偏好模式、有的没有」的会话。
   *
   * 自愈的判据必须来自实时评估，而不是「等下一次路由」：谁能保证还有下一次路由？
   * 所以面板读取状态（preferenceView）和每一次 step 组装（routeForStep）都过一遍这里。
   */
  function syncPreference(state) {
    if (state === undefined || state === null) return false
    if (runtime.config.mode !== 'prefer') return false
    if (state.preferenceSuspended !== true) return false
    if (!preferenceUsableNow(state)) return false
    return resumePreference(state, '偏好模型重新有可用渠道（实时复核）')
  }

  /** Compute and install the route for the step that is about to assemble. */
  function routeForStep(state, assembly) {
    const config = runtime.config
    // 先自愈再算模式：否则 effectiveMode 会一直读到那个过期的暂停标记，
    // 会话就永远停在降级模式里（这正是事故里的「一直显示已暂停」）。
    if (config.mode === 'prefer') syncPreference(state)
    const mode = effectiveMode(state)
    if (mode === 'off') return null
    // The live assembly is the most reliable "this step can call tools" signal:
    // a brand-new session has no request header and no tool events yet, so
    // waiting for them would let a tool-weak model serve the first step of an
    // agent loop.
    if (Array.isArray(assembly?.tools) && assembly.tools.length > 0) state.hasTools = true
    scanSession(state)
    if (state.ref === null) state.ref = selectionFor(state.agent)

    if (mode === 'manual') {
      if (state.external !== null && state.external.fromEvent === true) {
        state.manualAnchor = withKey(state.external, true)
      } else if (state.manualAnchor === null) {
        state.manualAnchor = anchorFor(state, config)
      }
    } else {
      state.manualAnchor = null
    }

    // A picker change that no `model/selection` event announced (a resumed
    // session, another plugin) is still the user's current choice.
    const live = liveSelection(state)
    if (live !== null && state.userEffort === undefined && typeof live.reasoningEffort === 'string'
      && (state.applied === null || !sameRoute(live, state.applied))) {
      // A session restored from disk carries the explicit effort the user last
      // chose; adopting it once keeps a switch from silently downgrading it.
      // The comparison against `applied` is what keeps the router from
      // mistaking its OWN strategy-chosen effort for a user instruction.
      state.userEffort = live.reasoningEffort
    }
    if (live !== null && config.autoSelect !== true && state.external === null && state.applied !== null
      && !sameModel(live, state.applied)) {
      const row = catalog.row(live.provider, live.model)
      // Only treat it as external when it really differs from what we applied.
      if (row === undefined || !sameRoute(live, state.applied)) {
        state.external = { ...live, at: Date.now(), fromEvent: false }
      }
    }

    // Following the picker inside preference mode redefines the preference; an
    // explicit user choice must never be silently undone by the router.
    if (config.mode === 'prefer' && config.preferFollowSelection !== false
      && state.external !== null && state.external.fromEvent === true && state.applied !== null) {
      const family = catalog.row(state.external.provider, state.external.model)?.key
        ?? foldKey(familyFor(dataset, state.external.model))
      if (family !== '' && family !== config.preferModel) {
        applyConfig({ preferModel: family, preferProvider: '' })
        health.logDecision({
          kind: 'prefer-follow',
          to: family,
          from: config.preferModel,
          reason: '模型选择器改为 ' + state.external.model + '，偏好模型随之更新',
          sessionId: state.agent.id,
        }, runtime.config.decisionLogSize)
      }
      // The picker change has been consumed either way. Leaving it set would
      // make every later step treat a stale selection as a fresh user choice.
      state.external = null
    }

    // 本回合已经失败过的车道，这一步不再选（LOCAL PATCH 2026-11-16）。
    // 冷却账本是跨会话的，而"这个回合刚刚在这条车道上栽过"是会话内的事实——
    // 少了它，第二个步骤会从同一个死车道重新开始，把同一场失败重演一遍。
    const dead = state.turnDeadLanes instanceof Set && state.turnDeadLanes.size > 0
      ? state.turnDeadLanes
      : undefined
    const input = dead === undefined ? selectionInput(state) : { ...selectionInput(state), exclude: dead }
    let decision = routeOrNull(input)
    // 排除面把候选清空时退回无排除的候选池：一条冷却中的车道总好过没有车道。
    if (decision === null && dead !== undefined) decision = routeOrNull(selectionInput(state))
    if (decision === null) return null
    if (decision.blocked === true) {
      if (input.mode === 'prefer') notePreference(state, decision)
      // Fallback `off` means "do not choose for me": stop forcing the previous
      // route so the kernel's own selection (the user's picker) is what runs.
      if (decision.fallback === 'off') state.applied = null
      return null
    }
    if (input.mode === 'prefer') notePreference(state, decision)

    if (state.external !== null && state.external.fromEvent !== true && config.mode === 'auto'
      && Date.now() - state.external.at > Number(config.userChoiceTtlMs ?? 0)) {
      state.external = null
    }
    // The first route of a session earns its own kind in the decision log, but only
    // when the takeover really ran: a session whose `applied` was cleared by a
    // settings change is not a first turn, and the picker it just honoured must
    // not be described as ignored.
    const takeover = state.started !== true && state.applied === null
      && state.headerAnchor === null && state.external === null
      && config.mode === 'auto' && config.routeFirstTurn !== false
    if (takeover) decision.reason = '首轮接管（不用选择器里的默认模型）：' + decision.reason
    return applyRoute(state, decision, takeover ? 'first-turn' : 'step')
  }

  // ── failure recovery ──────────────────────────────────────────────────────
  /** The lane an `agent/request-error` attempt actually failed on. */
  function failedRoute(state, payload) {
    const header = headerRoute(state)
    const applied = state.applied
    const provider = String(payload.provider ?? applied?.provider ?? header?.provider ?? '')
    // The plugin's `agent/request` override makes `state.applied` the route that
    // actually left the process, so it outranks the header. That matters when
    // the failure happened before `buildRequest` logged a fresh header (a
    // prepareCall rejection): the header still names the previous attempt, and
    // marking THAT lane would cool a healthy model.
    let model = ''
    if (applied !== null && applied.provider === provider) model = applied.model
    else if (header !== null && header.provider === provider) model = header.model
    else model = applied?.model ?? header?.model ?? ''
    return provider === '' || model === '' ? null : { provider, model }
  }

  /**
   * Recover one failed model request.
   *
   * Order matters and is the point of the two-level router:
   *   1. record the verdict on the exact lane that failed;
   *   2. never blame the lane for our own bad request;
   *   3. retry on another channel of the SAME model;
   *   4. only then change model (or leave preference mode).
   */
  async function recover(state, payload, next) {
    const config = runtime.config
    if (config.mode === 'off' || effectiveMode(state) === 'off') return next()
    if (payload.signal?.aborted === true) return next()
    const route = failedRoute(state, payload)
    if (route === null) return next()

    const verdict = health.markFailure(route.provider, route.model, payload.failure)
    // 这里**不再**同步落盘（FIX 2026-11-16）。旧代码每次失败都调 health.persist()，而它是
    // 整本账（实测 611KB）的同步 JSON.stringify + 写文件，且绕过 15 秒节流：一个步骤最多会
    // 在错误路径上做 7 次全量写（maxSwitchesPerStep 5 + 超额 2），全部发生在最需要及时响应的
    // 那一刻。现在只标脏，交给节流定时器（persistIntervalMs）与卸载时的持久化。
    // 例外（LOCAL PATCH 2026-11-20）：≥30 分钟的长停车在 markFailure 内即时落盘——
    // 那是稀有事件，丢在硬杀里的代价是重启后重撞 EOL/套餐/凭据的墙。
    // 这一轮里这条车道已经证明过自己不行了（LOCAL PATCH 2026-11-16）。
    //
    // 为什么必须记在会话里、而不能只靠冷却账本：冷却有长有短（瞬时 30 秒），
    // 而"这一轮的这一步已经在这条车道上失败过"是**与冷却无关**的事实。旧代码的
    // `exclude` 只装"刚刚失败的那一条"，于是 A 失败 → 换到 B → B 失败 → 又换回 A，
    // 一个步骤在两条死车道之间来回撞（实测 session-e4a79c6d 一个 step 在 qoder 上
    // 撞了 10 次）。这两组集合是换道时唯一权威的排除面。
    const deadKey = laneKey(route.provider, route.model)
    if (state.stepDeadLanes instanceof Set) state.stepDeadLanes.add(deadKey)
    if (state.turnDeadLanes instanceof Set) state.turnDeadLanes.add(deadKey)
    // A single rejected request is our own mistake and must not move the route
    // — the lane is innocent. One that repeats is not: `markFailure` parks the
    // model after `requestRepeatThreshold` refusals inside the window and flags
    // the verdict `blocked`, and that verdict is what lets this turn reroute
    // instead of ending in an error the user has to work around by hand.
    if (verdict.kind === KIND.REQUEST && verdict.blocked !== true) return next()

    // 换道预算：正常额度之外还有 EXTRA_SWITCHES 的"宁可换也不要死"余量。
    // 为什么允许超预算：实测 38 个 error 回合里，13 个是在**还有可用车道**的情况下
    // 因为预算耗尽而失败的——用户看到的"这一轮运行失败"其实只是预算太小。
    const budgetLeft = state.stepSwitches < config.maxSwitchesPerStep
      && state.turnSwitches < config.maxSwitchesPerTurn
    const extraUsed = Number(state.extraSwitches ?? 0)
    // 超额余量走配置面（FIX 2026-11-16）：旧版本硬编码 2，用户无论怎么调
    // maxSwitchesPerStep 都算不出真实预算（clamp 上限又只有 10）。
    const overdraft = Number.isFinite(Number(config.switchOverdraft))
      ? Math.max(0, Math.round(Number(config.switchOverdraft)))
      : EXTRA_SWITCHES
    // 故障域短路（FIX 2026-11-16）：连接层失败不是「这条模型不行」，换道不该消耗步骤预算 ——
    // 否则一个死端点会把 8 次预算全部烧掉（实测 45 秒内 6 次 switch-budget-exhausted，
    // 每次 reason 都是同一个 ECONNRESET）。改用按回合的独立配额：既不计入预算，
    // 也不至于在真断网时无限循环。
    const domainDown = verdict.domainDown === true || verdict.endpointDown === true
    // 整域短路必须在决策日志里留痕：否则面板只会看到「这条渠道忽然不见了」，
    // 看不到原因是「线路不通」而不是「模型坏了」（FIX 2026-11-16）。
    if (domainDown) {
      health.logDecision({
        kind: 'domain-down',
        from: routeLabel(route),
        reason: failureReason(verdict),
        sessionId: state.agent.id,
      }, runtime.config.decisionLogSize)
    }
    const domainFree = Number(state.domainSwitches ?? 0) < Number(CONNECTIVITY.freeSwitchesPerTurn ?? 4)
    const canSwitch = (budgetLeft || extraUsed < overdraft) || (domainDown && domainFree)
    if (!canSwitch) {
      health.logDecision({
        kind: 'switch-budget-exhausted',
        from: routeLabel(route),
        reason: '本步骤已换道 ' + state.stepSwitches + ' 次（含超额 ' + extraUsed + ' 次），仍在 '
          + failureReason(verdict) + '；转入最后一搏',
        sessionId: state.agent.id,
      }, runtime.config.decisionLogSize)
    }

    state.priorFailures += 1
    refreshChannelData()
    scanSession(state)

    const failedRow = catalog.row(route.provider, route.model)
    const failedKey = failedRow?.key ?? foldKey(familyFor(dataset, route.model))
    const isContext = verdict.kind === KIND.CONTEXT
    const needs = needsFor(state)
    if (isContext) {
      needs.longContext = true
      needs.estimatedTokens = Math.max(Number(needs.estimatedTokens ?? 0), Number(failedRow?.contextWindow ?? 0) + 1)
    }

    const anchor = withKey(route)
    // 同一个家族在一个 step 里只允许重试一次（LOCAL PATCH 2026-11-14）。
    //
    // 事实：偏好家族 deepseek-v4.1-flash 现挂 16 条同名车道，其中 13 条可能同时不可用
    // （2 条被策略排除、2 条未登录、4 条未订阅、1 条额度到中午、1 条被用户屏蔽、
    // 1 条安全拦截）。旧代码每一次失败都"优先留在同一家族换个渠道"，于是三次
    // maxSwitchesPerStep 全花在同一个家族的兄弟车道上，整轮以最后一个错误结束——
    // 连"换一个模型"这一步都没走到。用户的观感就是"经常报错、经常停止"。
    //
    // 换渠道的初衷（保住 prompt 缓存、不换上下文）在小家族里依然成立，所以只限制次数，
    // 不取消：第一次仍然留在同家族，第二次直接比较全体候选（含其它家族）。
    const familyRetries = state.familyRetries instanceof Set ? state.familyRetries : (state.familyRetries = new Set())
    const repeatFamily = !isContext && failedKey !== null && failedKey !== undefined && familyRetries.has(failedKey)
    if (!isContext && failedKey !== null && failedKey !== undefined) familyRetries.add(failedKey)
    // 第二次栽在同一个家族上，本 step 内就不再把它排进候选（router 只在"还有别的
    // 家族可用"时才真的生效，见 evaluate 的 excludeFamilies）。
    const parkedFamilies = state.stepFailedFamilies instanceof Set
      ? state.stepFailedFamilies
      : (state.stepFailedFamilies = new Set())
    if (repeatFamily) parkedFamilies.add(failedKey)
    // 换道时的排除面 = 本步骤失败过的 + 本回合失败过的（含刚刚这一条）。
    // 同一族群的兄弟车道可以被排除，但**绝不排除整个候选池**：真的一条都不剩时，
    // 下面的「最后一搏」才是正确的下一步。
    const dead = new Set()
    for (const item of state.turnDeadLanes instanceof Set ? state.turnDeadLanes : []) dead.add(item)
    for (const item of state.stepDeadLanes instanceof Set ? state.stepDeadLanes : []) dead.add(item)
    dead.add(deadKey)

    const input = {
      ...selectionInput(state),
      anchor,
      needs,
      // Same model first, on a different channel. A context-window failure is
      // the one case where the same model cannot help.
      forceGroupKey: isContext ? null : failedKey,
      excludeFamilies: parkedFamilies,
      exclude: dead,
      minContextWindow: isContext && Number.isFinite(failedRow?.contextWindow) ? failedRow.contextWindow : undefined,
    }
    const decision = routeOrNull(input)
    const switchable = decision !== null && decision.blocked !== true
      && !(decision.provider === route.provider && decision.model === route.model)

    if (switchable && canSwitch) {
      if (input.mode === 'prefer') notePreference(state, decision)
      const applied = switchTo(state, route, decision, verdict, config, budgetLeft ? 0 : 1, { free: domainDown && domainFree })
      // 换道没写成（selection 写失败）：绝不能吞掉这次失败，交回内核去退避重试。
      if (applied !== null) return applied
      return next()
    }
    if (switchable && decision !== null && input.mode === 'prefer') notePreference(state, decision)
    if (decision !== null && decision.blocked === true) {
      if (input.mode === 'prefer') notePreference(state, decision)
      // Fallback `off` means "do not choose for me": stop forcing a route so the
      // kernel's own selection (the user's picker) is what runs next.
      if (decision.fallback === 'off') state.applied = null
    }

    // ── 最后一搏 ────────────────────────────────────────────────────────────
    //
    // 走到这里说明本步骤已经没有"现在就能用"的替代车道：要么全都还在冷却，
    // 要么换道预算刚刚用尽。旧代码在这里 `return next()`，于是原始错误直接
    // 冒到界面上——「本轮运行失败」，用户必须自己重试，而且往往重试也没用，
    // 因为冷却还在。真正该做的是**等**：账本里写着每条车道什么时候回来，
    // 挑最早的那条等到它回来再试一次。
    const resort = await tryLastResort(state, route, dead, verdict, switchable, canSwitch, config, payload.signal)
    if (resort !== null) return resort
    return next()
  }

  /** `selectRoute` 从不让一个异常把整轮带走。 */
  function routeOrNull(input) {
    try {
      return selectRoute(input)
    } catch {
      return null
    }
  }

  /** 换道 + 记账，成功时返回内核要的 retry 动作。 */
  function switchTo(state, route, decision, verdict, config, extra = 0, options = {}) {
    try {
      applyRoute(state, decision, 'failover')
    } catch {
      return null
    }
    // 计数只在换道真的写成之后才记：一条写不进 selection 的换道没有换来任何东西，
    // 不该消耗本步骤的预算。
    if (options.free === true) {
      // 故障域短路：这次换道的原因是「线路不通」，不是「模型不行」，因此不占步骤/回合
      // 预算，只占按回合的独立配额（见 recover 的 domainDown）。
      state.domainSwitches = Number(state.domainSwitches ?? 0) + 1
    } else {
      state.stepSwitches += 1
      state.turnSwitches += 1
      if (extra > 0) state.extraSwitches = Number(state.extraSwitches ?? 0) + extra
    }
    health.logDecision({
      kind: 'failover',
      from: routeLabel(route),
      to: routeLabel({ provider: decision.provider, model: decision.model }),
      family: decision.family,
      reason: failureReason(verdict) + ' → 自动切换到 ' + (decision.family ?? decision.model)
        + (decision.sameModel === true ? '（同模型换渠道）' : ''),
      sessionId: state.agent.id,
    }, runtime.config.decisionLogSize)
    return { kind: 'retry' }
  }

  /**
   * 最后一条路：等到最早恢复的那条车道可用，然后换过去（或原地重试）。
   *
   * 三种"没得换"的情形必须分开处理，因为它们要等的时间差几个数量级：
   *  - 全部在瞬时冷却（30 秒级）→ 等，然后必然能重试；
   *  - 全部因为凭据/订阅被停（小时级）→ 等一下没有意义；交给回合级自动续跑；
   *  - 目录本身就没有别的车道 → 同第一条，但等的对象是这条车道自己。
   *
   * @returns {object|null} `{kind:'retry'}` 当且仅当真的等到了值得一试的时刻。
   */
  async function tryLastResort(state, route, dead, verdict, switchable, canSwitch, config, signal) {
    if (signal?.aborted === true) return null
    if (Number(state.lastResortUsed ?? 0) >= Number(config.lastResortPerStep ?? 1)) return null
    if (switchable === true && canSwitch === true) return null
    const wait = soonestRecoveryMs(state, config)
    if (wait === null) return null
    const cap = Number(config.lastResortWaitMs ?? 30_000)
    if (wait > cap) {
      health.logDecision({
        kind: 'last-resort-skipped',
        from: routeLabel(route),
        reason: '最早的可用车道还要 ' + Math.round(wait / 1000) + ' 秒才恢复（上限 ' + Math.round(cap / 1000)
          + ' 秒），等待没有意义，交给回合级自动续跑',
        sessionId: state.agent.id,
      }, runtime.config.decisionLogSize)
      return null
    }
    state.lastResortUsed = Number(state.lastResortUsed ?? 0) + 1
    const waited = Math.max(0, Math.round(wait)) + 400
    health.logDecision({
      kind: 'last-resort-wait',
      from: routeLabel(route),
      reason: failureReason(verdict) + ' → 候选全在冷却，等待 ' + Math.round(waited / 1000) + ' 秒后重试',
      sessionId: state.agent.id,
    }, runtime.config.decisionLogSize)
    // 界面上的静默最容易被读成卡死：超过 3 秒的等待必须自己说明一次。
    if (waited > 3_000) {
      notify('模型调度：正在等待车道恢复', failureReason(verdict) + '，所有候选都在冷却。'
        + '约 ' + Math.ceil(waited / 1000) + ' 秒后自动重试（不会结束这一轮）。')
    }
    await sleep(waited, signal)
    if (signal?.aborted === true) return null

    // 冷却可能刚好过期：重新算一次。这次排除面里不含"刚刚等回来的那条"，
    // 否则我们会把自己刚等活的候选又排除掉。
    const revived = routeOrNull({
      ...selectionInput(state),
      anchor: withKey(route),
      needs: needsFor(state),
      excludeFamilies: state.stepFailedFamilies instanceof Set ? state.stepFailedFamilies : new Set(),
      exclude: dead,
    })
    if (revived !== null && revived.blocked !== true
      && !(revived.provider === route.provider && revived.model === route.model)) {
      const applied = switchTo(state, route, revived, verdict, config, 1)
      if (applied !== null) return applied
    }
    // 没有更好的：在原车道上再试一次——它刚刚从冷却里出来，这一次是新的证据。
    return { kind: 'retry' }
  }

  /**
   * 最早多久之后会有一条车道可用（毫秒）。
   *
   * 只读账本，不猜：每条候选车道问一次 `stateOf`，取 `until` 里最近的一个。
   * 目录里一条冷却记录都没有时返回 null——"没有在冷却的车道"与"全在冷却"是
   * 两件完全不同的事，不能用同一个 0 表示。
   */
  function soonestRecoveryMs(state, config) {
    const now = Date.now()
    const rows = catalog.current?.rows ?? []
    let soonest = null
    for (const row of rows) {
      if (row === null || row === undefined) continue
      if (row.denied === true) continue
      // 借来的车道在 borrowWhen='exhausted' 下本来就不参战，等它等于等错对象。
      if (row.borrowed === true && config.peerShare?.borrowWhen !== 'always') continue
      const status = health.stateOf(row.provider, row.model)
      const until = Number(status?.until ?? 0)
      if (!Number.isFinite(until) || until <= now) continue
      const delta = until - now
      if (soonest === null || delta < soonest) soonest = delta
    }
    return soonest
  }

  /**
   * 回合因渠道故障中断后，自动把这一轮续上（LOCAL PATCH 2026-11-16）。
   *
   * 为什么要有它：内核在 `agent/request-error` 没有返回 retry 时直接抛 LlmError，
   * 回合以 `reason.kind='error'` 收场，界面弹「本轮运行失败」——**用户必须自己点一次
   * 重试**。实测 11-10..11-16 有 38 个回合这样收场，其中 11 个发生在新会话的第一轮。
   * 用户的原话是「失败后还得用户重试，不能自动」。
   *
   * 三条边界：
   *  1. 只在回合边界做（`turn/end`）。中途插话会把一次对话切成两半。
   *  2. 必须等 Agent 真的回到 idle 再 followup。落在一个仍在运行的 phase 上时
   *     `send()` 只会把消息排进 next-turn 而**不会唤醒驱动**（`wakeDriver` 只在
   *     maintenance 或 aborted 时置 wakeRequested），消息会一直躺在队列里——
   *     这正是"看起来续跑了其实没动"的形状。
   *  3. 有上限（`autoResumeMax`）：连续两次续跑都没能把这一轮做完，就停下来
   *     告诉用户，而不是把同一个死循环刷成几十条消息。
   */
  function scheduleAutoResume(state, error) {
    const config = runtime.config
    if (config.autoResume === false) return
    if (config.mode === 'off' || effectiveMode(state) === 'off') return
    const failure = error ?? {}
    const code = String(failure.code ?? 'UNKNOWN')
    if (AUTO_RESUME_EXCLUDED.has(code)) return
    const max = Math.max(0, Number(config.autoResumeMax ?? 2))
    if (Number(state.resumeChain ?? 0) >= max) {
      notify('模型调度：已停止自动续跑', '连续 ' + state.resumeChain + ' 次自动续跑都没能完成这一轮（最后一次：'
        + code + '）。请手动重试，或在设置里换一条车道。')
      health.logDecision({
        kind: 'auto-resume-stop',
        reason: '连续 ' + state.resumeChain + ' 次自动续跑后仍未完成（最后错误 ' + code + '）',
        sessionId: state.agent.id,
      }, runtime.config.decisionLogSize)
      return
    }
    state.resumeChain = Number(state.resumeChain ?? 0) + 1
    state.resumeAt = Date.now()
    const chain = state.resumeChain
    // 续跑延迟跟账本对齐：最早恢复的车道还要多久，就等多久（有上限）。
    // 否则 1.5 秒后续跑只是把同一堵墙再撞一次，还会白白烧掉一次连击预算。
    const base = Math.max(0, Number(config.autoResumeDelayMs ?? 1_500)) * chain
    const soonest = soonestRecoveryMs(state, config)
    const aligned = soonest === null ? 0 : Math.min(soonest + 400, Number(config.autoResumeWaitCapMs ?? 90_000))
    const delay = Math.max(base, aligned)
    const message = String(failure.message ?? '').replace(/\s+/g, ' ').slice(0, 180)
    const text = '（模型调度自动续跑 ' + chain + '/' + max + '）上一轮在第 '
      + Number(state.step >= 0 ? state.step : 0) + ' 步被渠道故障打断：' + code
      + (message === '' ? '' : '（' + message + '）')
      + '。已经自动换到其它可用车道，请**从断点继续**完成原任务：不要重述已经完成的部分，'
      + '也不要重做已经成功的步骤；如果上一步的产出已经足够，直接收尾即可。'
    // 覆盖前先清旧句柄（FIX 2026-11-16）：等待窗口最长 90 秒，窗口内用户重试或再次
    // 以 error 收场都会再次走到这里；只赋值不清除时旧定时器照样到点执行，于是同一个
    // 会话被插入第二条「模型调度自动续跑」消息，并重复消耗 resumeChain 预算。
    if (state.resumeTimer !== null && state.resumeTimer !== undefined) clearTimeout(state.resumeTimer)
    state.resumeTimer = setTimeout(() => {
      state.resumeTimer = null
      resumeNow(state, text, chain, code)
    }, delay)
    state.resumeTimer?.unref?.()
  }

  /** 等 Agent 空闲后把续跑消息交给它；一直忙（用户在说话）就放弃这一次。 */
  async function resumeNow(state, text, chain, code) {
    if (sessions.get(state.agent?.id) !== state) return
    const agent = state.agent
    if (agent === null || agent === undefined) return
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (sessions.get(agent.id) !== state) return
      if (agent.status === 'idle') break
      await sleep(250, null)
    }
    if (agent.status !== 'idle') {
      // 用户自己又在说话了：这一次续跑就没有必要了，把预算还回去。
      state.resumeChain = Math.max(0, Number(state.resumeChain ?? 1) - 1)
      return
    }
    try {
      agent.followup(userMessage({ text, kind: 'model-orchestrator-resume' }))
    } catch (failure) {
      state.resumeChain = Math.max(0, Number(state.resumeChain ?? 1) - 1)
      ctx.logger?.warn?.('model-orchestrator: 自动续跑入队失败: '
        + (failure instanceof Error ? failure.message : String(failure)))
      return
    }
    if (chain === 1) {
      notify('模型调度：已自动续跑', '上一轮因渠道故障中断（' + code + '），已自动换道并继续。')
    }
    health.logDecision({
      kind: 'auto-resume',
      reason: '第 ' + chain + '/' + Math.max(0, Number(runtime.config.autoResumeMax ?? 2))
        + ' 次自动续跑（上一轮以 ' + code + ' 中断）',
      sessionId: agent.id,
    }, runtime.config.decisionLogSize)
  }

  function failureReason(verdict) {
    if (verdict.kind === KIND.QUOTA) return '额度耗尽'
    if (verdict.kind === KIND.PLAN) return '订阅/套餐不可用'
    if (verdict.kind === KIND.AUTH && verdict.credentialMissing === true) return '该渠道未配置凭据'
    if (verdict.kind === KIND.RATE) return '速率受限'
    if (verdict.kind === KIND.CONTEXT) return '上下文窗口不足'
    if (verdict.kind === KIND.REGION) return '地区封锁'
    if (verdict.kind === KIND.AUTH) return '凭据/授权问题'
    if (verdict.kind === KIND.SAFETY) return '渠道安全审核拦截'
    if (verdict.kind === KIND.UNAVAILABLE) return '模型不可路由'
    if (verdict.kind === KIND.SLOW) return '响应过慢'
    return verdict.reason ?? '请求失败'
  }

  // ── kernel hooks ──────────────────────────────────────────────────────────
  ctx.on('agent/created', ({ agent }) => {
    if (!shouldRoute(agent)) return
    const state = freshSession(agent)
    state.ref = selectionFor(agent)
    sessions.set(agent.id, state)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const state = sessions.get(agent.id)
    if (state?.resumeTimer !== null && state?.resumeTimer !== undefined) {
      clearTimeout(state.resumeTimer)
      state.resumeTimer = null
    }
    sessions.delete(agent.id)
  })

  ctx.on('session/event', (session, event) => {
    const state = sessions.get(session.id)
    if (state === undefined) return
    if (event.type === 'turn/start') {
      state.turn = Number(event.data?.turn ?? -1)
      state.turnTokens = 0
      state.priorFailures = 0
      state.stepSwitches = 0
      state.turnSwitches = 0
      state.familyRetries = new Set()
      state.stepFailedFamilies = new Set()
      // 死车道的记忆只在一个回合内有效：给下个回合（以及自动续跑）一个干净的
      // 候选池，否则一条车道一次抖动会把它钉死整个会话。冷却账本才是跨回合的判据。
      state.turnDeadLanes = new Set()
      state.stepDeadLanes = new Set()
      state.turnProduced = false
      state.extraSwitches = 0
      state.lastResortUsed = 0
      // 故障域短路用的独立配额：按回合重置（step 级不动它，见 recover 的 domainDown）。
      state.domainSwitches = 0
      return
    }
    if (event.type === 'turn/end') {
      // A turn is the safe point to hand the model back: the conversation is
      // complete, so a switch now cannot split one exchange across two models.
      restoreUserChoice(state)
      const reason = event.data?.reason
      if (reason?.kind === 'completed' || reason?.kind === 'max-tokens') {
        // 走到这里说明调度器把一次危机救回来了：连击清零，下次中断重新给满预算。
        state.resumeChain = 0
      } else if (reason?.kind === 'error') {
        scheduleAutoResume(state, reason.error)
      }
      return
    }
    if (event.type === 'step/start') {
      state.step = Number(event.data?.step ?? -1)
      state.stepSwitches = 0
      state.lastResortUsed = 0
      state.extraSwitches = 0
      state.stepDeadLanes = new Set()
      // 同家族只在每个 step 里重试一次（LOCAL PATCH 2026-11-14，见 recover）。
      state.familyRetries = new Set()
      state.stepFailedFamilies = new Set()
      return
    }
    if (event.type === 'assistant/message') {
      state.turnProduced = true
      return
    }
    if (event.type === 'model/selection') {
      const data = event.data
      if (data === null || typeof data !== 'object') return
      const selection = {
        provider: String(data.provider ?? ''),
        model: String(data.model ?? ''),
        ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}),
      }
      // Our own writes land here too; only a real third-party change is external.
      if (state.lastWritten !== null && sameRoute(selection, state.lastWritten)) return
      if (state.applied !== null && sameRoute(selection, state.applied)) return
      // Only a third-party selection is an instruction. Our own writes land here
      // too, and treating their strategy-chosen effort as a user choice would
      // freeze the effort for the rest of the session.
      if (typeof selection.reasoningEffort === 'string') state.userEffort = selection.reasoningEffort
      // 自动选择：模型不由选择器决定，但「推理档」是另一回事——用户在选择器里调档
      // 仍然算一条明确指令，所以只在模型层把它丢掉。
      if (runtime.config.autoSelect === true) {
        // 自动选择期间模型不由选择器决定……但「在官方模型列表里点了一个具体模型」是一条
        // 明确的指令：那等于说「我不要接管，我要这个」。所以这里退出自动选择并采纳这次选择。
        // 列表首行是「自动选择」，点它就是重新接管——和单选按钮的语义一致。
        if (state.applied === null) {
          state.external = null
          return
        }
        try {
          applyConfig({ autoSelect: false })
          state.external = { ...selection, at: Date.now(), fromEvent: true }
          health.logDecision({
            kind: 'auto-select-off',
            from: routeLabel(state.applied),
            to: routeLabel(selection),
            reason: '在官方模型列表里选定了模型，已退出自动选择',
            sessionId: state.agent.id,
          }, runtime.config.decisionLogSize)
        } catch {
          /* 选择器事件永远不该把会话弄坏 */
        }
        return
      }
      state.external = { ...selection, at: Date.now(), fromEvent: true }
    }
  })

  // The decision point. Assembly is what snapshots the selected model into the
  // request, so this must run before the kernel's own assembly listener — hence
  // `prepend`. Everything here is synchronous bookkeeping on cached state.
  ctx.on('system-prompt/assemble', (assembly, context, next) => {
    const agent = context?.agent
    const state = agent === undefined ? undefined : sessions.get(agent.id)
    if (state !== undefined) {
      try {
        routeForStep(state, assembly)
      } catch (error) {
        ctx.logger?.warn?.('model-orchestrator: routing skipped: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    return next()
  }, { prepend: true })

  // The request-level override. It runs after the kernel's own selection
  // listener, so even if the assembly write raced another assembly, the call
  // that leaves this process is the route the router chose.
  ctx.on('agent/request', async ({ agent }, next) => {
    // Recorded before the await: the flag means "this session has dispatched", and
    // it must survive a settings change that clears `applied`.
    const started = sessions.get(agent.id)
    if (started !== undefined) started.started = true
    const resolved = await next()
    const state = sessions.get(agent.id)
    if (state === undefined || state.applied === null) return resolved
    // `off` means "do not intervene": the kernel's own selection must win, even
    // though this session still remembers the route the router used before.
    if (effectiveMode(state) === 'off') return resolved
    const nextConfig = {
      ...resolved,
      provider: state.applied.provider,
      model: state.applied.model,
    }
    if (state.applied.reasoningEffort === undefined) delete nextConfig.reasoningEffort
    else nextConfig.reasoningEffort = state.applied.reasoningEffort
    return nextConfig
  })

  // Failure recovery: cool the lane, retry the same model on another channel,
  // and only then change model — all inside the same step.
  // 重试预算归属（LOCAL PATCH 2026-11-16）。
  //
  // 内核的 `llm-retry` 与这个插件都挂在 `agent/request-error` 瀑布上，**谁先注册谁先
  // 说话**。实测的证据形状：一个步骤里同一条车道被撞 15~22 次，而调度器的换道预算只有
  // 3 次——因为 llm-retry 先把它能重试的码（TRANSPORT/TIMEOUT/SERVER/RATE_LIMIT/
  // EMPTY_RESPONSE）自己吞掉 5 次（0.5s→10s 退避），调度器要到第 6 次才看得见。
  //
  // `prepend` 让调度器抢在前面：车道级故障立刻换道（`{kind:'retry'}` 不再往下传），
  // 只有"换不了"的时候才把控制权交回内核，让它去做同车道的退避重试。
  // 关掉 `ownRetryBudget` 即恢复旧行为（内核优先）。
  ctx.on('agent/request-error', (payload, next) => {
    const state = sessions.get(payload.agent?.id)
    if (state === undefined) return next()
    let forwarded = false
    const forward = () => {
      forwarded = true
      return next()
    }
    return recover(state, payload, forward).catch((error) => {
      // 恢复逻辑自己出问题绝不能成为"回合失败"的理由：能交回内核就交回。
      try {
        ctx.logger?.warn?.('model-orchestrator: 失败恢复出错，交回内核: '
          + (error instanceof Error ? error.message : String(error)))
      } catch { /* 日志不重要 */ }
      return forwarded ? undefined : forward()
    })
  }, runtime.config.ownRetryBudget === true ? { prepend: true } : undefined)

  // Passive measurement of every call that actually goes out.
  ctx.on('llm/stream', (options, next) => observer.observe(options, next()))

  // Seed the route for every already-live agent (a plugin enabled mid-session).
  ctx.inject(['agents'], (scoped) => {
    try {
      for (const agent of scoped.agents.list()) {
        if (sessions.has(agent.id)) continue
        if (!shouldRoute(agent)) continue
        const state = freshSession(agent)
        state.ref = selectionFor(agent)
        sessions.set(agent.id, state)
      }
    } catch {
      /* the registry may not be readable this early; agent/created covers it */
    }
  })

  // ── operations shared by the tool, the command, and the panel ─────────────
  function sessionState(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') return sessions.get(sessionId)
    // Without an explicit session, the most recently active one is the useful
    // default; a panel opened from a conversation always passes its id.
    let newest = null
    for (const state of sessions.values()) {
      if (newest === null || (state.applied !== null && state.lastSwitchAt > (newest.lastSwitchAt ?? 0))) newest = state
    }
    return newest ?? undefined
  }

  function currentOf(state) {
    const route = state?.applied ?? (state === undefined ? null : headerRoute(state))
    if (route === null) return null
    const row = catalog.row(route.provider, route.model)
    const healthState = health.stateOf(route.provider, route.model)
    const spend = health.windowSpend(route.provider, route.model, 24 * 60 * 60_000)
    const channel = channelData.signal(route.provider, route.model)
    return {
      provider: route.provider,
      model: route.model,
      modelName: row?.modelName ?? route.model,
      family: row?.family ?? null,
      key: row?.key ?? foldKey(familyFor(dataset, route.model)),
      effort: route.reasoningEffort ?? null,
      health: healthState,
      // Live load on this exact route, so the panel can explain a switch that
      // the historical readings would not predict.
      inFlight: inflight.of(route.provider, route.model),
      tokensToday: spend.in + spend.out,
      requests: state?.requests ?? 0,
      switches: state?.switches ?? 0,
      reason: state?.lastDecision?.reason ?? '',
      channel: channel === null ? null : {
        available: channel.available,
        rateLimitedUntil: channel.rateLimitedUntil,
        accounts: channel.accounts,
        todayTokens: channel.today !== null && channel.today !== undefined
          ? channel.today.inputTokens + channel.today.outputTokens
          : channel.freeToday === null || channel.freeToday === undefined
            ? null
            : channel.freeToday.inputTokens + channel.freeToday.outputTokens,
        todayRequests: channel.today?.requests ?? channel.freeToday?.calls ?? null,
        ttftMs: channel.today?.ttftMs ?? channel.freeToday?.ttftMs ?? null,
      },
      free: channel?.free ?? null,
    }
  }

  function preferenceView(state) {
    const config = runtime.config
    const mode = effectiveMode(state ?? null)
    const input = state === undefined
      ? { rows: catalog.current.rows, health, inflight, config, anchor: null, needs: readNeeds({}, config) }
      : selectionInput(state)
    let group = null
    try {
      if (config.mode === 'prefer' && config.preferModel !== '') {
        const evaluation = evaluate(input)
        // resolvePreferenceGroup is stable; find by the configured key.
        const match = resolvePreferenceGroup(evaluation.allGroups, config.preferModel, config.preferProvider)
        if (match !== null) {
          group = {
            key: match.key,
            family: match.family,
            label: match.label,
            intel: match.intel,
            total: match.all.length,
            available: match.lanes.length,
            // 被用户自己的 deny 挡住的渠道（不会随时间恢复）——面板与工具都要显示，
            // 否则"偏好模式坏了"与"你自己把它屏蔽了"在界面上长得一模一样。
            conflicts: preferenceConflicts(match),
            lanes: match.all.map(entry => ({
              provider: entry.row.provider,
              model: entry.row.model,
              modelName: entry.row.modelName,
              available: entry.inspection.eligible,
              reason: entry.inspection.reason ?? '',
              cooldownMs: Math.max(0, Number(entry.inspection.until ?? 0) - Date.now()),
              ttftMs: entry.row.channel?.today?.ttftMs ?? entry.row.reportTtftMs ?? null,
            })),
          }
        }
      }
    } catch {
      group = null
    }
    // 面板读数之前先自愈一次：面板是用户唯一能看见状态的地方，它不能显示一个
    // 已经不成立的暂停（LOCAL PATCH 2026-11-05）。
    if (state !== undefined && state !== null) syncPreference(state)
    return {
      configured: {
        model: config.preferModel,
        provider: config.preferProvider,
        fallback: config.preferFallback,
        notify: config.preferNotify !== false,
        autoResume: config.preferAutoResume === true,
        followSelection: config.preferFollowSelection !== false,
      },
      active: config.mode === 'prefer' && mode === 'prefer',
      suspended: state?.preferenceSuspended === true,
      // While a preference is suspended the honest answer to "what is running
      // now" is the last fallback decision, not the configured mode.
      effectiveMode: state?.preferenceSuspended === true
        ? (state?.lastDecision?.mode ?? config.preferFallback)
        : mode,
      exhausted: state?.preferenceExhausted ?? null,
      group,
    }
  }

  function viewFor(state) {
    const config = publicConfig()
    const input = state === undefined
      ? { rows: catalog.current.rows, health, inflight, config, anchor: null, needs: readNeeds({}, config) }
      : selectionInput(state)
    const current = currentOf(state)
    const groups = rankGroups(input)
    const key = current?.key ?? groups[0]?.key
    const lanes = key === undefined ? [] : rankLanes({ ...input, anchor: current === null ? null : withKey(current) }, key)
    return { config, current, groups, lanes, key }
  }

  /**
   * The route the next assembly would install, without touching a session.
   *
   * A session that has not sent anything yet has no `current` route at all, and
   * "which model will answer this first message" is the only question the panel
   * can usefully answer there. After the first-turn takeover that preview is the
   * exact route the first message will use.
   */
  function nextRouteOf(view, preference) {
    const config = view.config
    if (config.mode === 'off' || config.mode === 'manual') return null
    if (config.mode === 'prefer' && preference.group !== null && preference.group.available > 0) {
      const lane = preference.group.lanes.find(entry => entry.available === true) ?? null
      return {
        mode: 'prefer',
        key: preference.group.key,
        family: preference.group.family,
        provider: lane === null ? null : lane.provider,
        model: lane === null ? null : lane.model,
        lanes: preference.group.available,
        total: preference.group.total,
        utility: null,
      }
    }
    const top = view.groups[0]
    if (top === undefined) return null
    return {
      mode: config.mode,
      key: top.key,
      family: top.family,
      provider: top.bestProvider,
      model: top.bestModel,
      lanes: top.lanes,
      total: top.total,
      utility: top.utility,
    }
  }

  /**
   * 巡检状态（面板与 summary 共用）。
   *
   * `lastResults` 是上一轮每条车道的判决，一台机器上可能几十行、每行带一条上游错误
   * 原文。面板每 10 秒轮询一次 summary，把整轮结果原样塞进去等于让轮询悄悄变贵，所以
   * 这里给条数上限：超出部分只报 `truncated`，要看完整明细走工具 `action=probe`。
   */
  const PROBE_RESULT_CAP = 60
  function probeView() {
    const status = probe.status()
    const results = Array.isArray(status.lastResults) ? status.lastResults : []
    return {
      enabled: status.enabled,
      intervalMs: status.intervalMs,
      intervalDays: status.intervalDays,
      timeoutMs: status.timeoutMs,
      concurrency: status.concurrency,
      running: status.running,
      rounds: status.rounds,
      lastRunAt: status.lastRunAt,
      lastFinishedAt: status.lastFinishedAt,
      lastDurationMs: status.lastDurationMs,
      nextAt: status.nextAt,
      counts: {
        total: results.length,
        ok: results.filter(row => row.ok === true).length,
        failed: results.filter(row => row.ok === false).length,
        skipped: results.filter(row => row.ok === null || row.ok === undefined).length,
      },
      results: results.slice(0, PROBE_RESULT_CAP),
      truncated: results.length > PROBE_RESULT_CAP,
      cap: PROBE_RESULT_CAP,
    }
  }

  const api = {
    refresh: async () => {
      const current = await refreshCatalog('api')
      refreshChannelData()
      return {
        at: current.at,
        total: current.rows.length,
        providers: current.providers.length,
        families: new Set(current.rows.map(row => row.key)).size,
        failures: current.failures.length,
        denied: current.rows.filter(row => row.denied).length,
        channelData: channelData.hasData(),
        error: current.error ?? '',
      }
    },

    status: (sessionId) => {
      const state = sessionState(sessionId)
      const view = viewFor(state)
      const healthState = view.current === null ? null : view.current.health
      return {
        ok: true,
        version,
        config: view.config,
        effectiveMode: effectiveMode(state ?? null),
        preference: preferenceView(state),
        current: view.current === null ? null : {
          ...view.current,
          health: healthState,
        },
        catalog: {
          at: catalog.current.at,
          lastGoodAt: catalog.current.lastGoodAt,
          error: catalog.current.error ?? '',
          total: catalog.current.rows.length,
          groups: view.groups.length,
          providers: catalog.current.providers.map(provider => ({
            id: provider.id,
            name: provider.name,
            models: (catalog.current.byProvider.get(provider.id) ?? []).length,
            accounts: channelData.providerSummary(provider.id),
          })),
          failures: catalog.current.failures,
        },
        groups: view.groups.slice(0, 18),
        lanes: view.lanes,
        dataset: datasetView(),
        decisions: health.snapshot().decisions.slice(0, 20),
        concurrency: inflight.snapshot(),
      }
    },

    explain: (sessionId) => {
      let state = sessionState(sessionId)
      if (state === undefined || state.lastDecision === null) {
        let newest = null
        for (const candidate of sessions.values()) {
          if (candidate.lastDecision === null) continue
          if (newest === null || candidate.lastDecision.at > newest.lastDecision.at) newest = candidate
        }
        if (newest !== null) state = newest
      }
      return {
        ok: true,
        sessionId: state?.agent?.id ?? null,
        lastDecision: state?.lastDecision ?? null,
        preference: preferenceView(state),
        previous: health.snapshot().decisions.slice(0, 12),
      }
    },

    applyConfig,

    /** 互借状态（面板与工具共用）。 */
    peer: () => ({ ok: true, peer: peerView() }),

    /**
     * 渠道巡检的对外入口。
     *
     * `status` 只读，随时可调；`run-now` 会真的发请求、花额度，所以它不在这里
     * 自动触发——只有面板点按或工具显式调用才会跑。
     */
    probe: async (options = {}) => {
      const action = String(options.action ?? 'status')
      if (action === 'run-now') {
        const summary = await probe.runOnce({ force: true })
        return { ok: true, summary, status: probe.status() }
      }
      return { ok: true, status: probe.status() }
    },

    /** 主动重拉对侧清单（借用方）。 */
    peerRefresh: async () => {
      if (peerState.borrower === null) return { ok: false, error: '借用车道未启用' }
      await peerState.borrower.refreshModels()
      refreshCatalog('peer-refresh').catch(() => {})
      return { ok: true, peer: peerView() }
    },

    importReport: (reportPath) => {
      if (typeof reportPath !== 'string' || reportPath.trim() === '') {
        return { ok: false, error: '需要提供报告文件路径' }
      }
      let markdown
      try {
        markdown = fs.readFileSync(reportPath, 'utf8')
      } catch (error) {
        return { ok: false, error: '读取失败：' + (error instanceof Error ? error.message : String(error)) }
      }
      try {
        const { dataset: imported, stats } = datasetFromReport(markdown, {
          baseCanonical: dataset.current.canonical,
        })
        dataset.importDataset(imported, { reportPath, ...stats })
        refreshCatalog('import').catch(() => {})
        return { ok: true, stats, userFile: dataset.userFile }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    clearImport: () => {
      dataset.clearImport()
      refreshCatalog('clear-import').catch(() => {})
      return { ok: true, userFile: dataset.userFile }
    },

    /** Read-only face for the panel. */
    summary: (sessionId) => {
      const state = sessionState(sessionId ?? undefined)
      const view = viewFor(state)
      const snapshot = health.snapshot()
      const preference = preferenceView(state)
      return {
        ok: true,
        version,
        patch: runtime.patch,
        config: view.config,
        effectiveMode: effectiveMode(state ?? null),
        current: view.current,
        next: nextRouteOf(view, preference),
        preference,
        groups: view.groups.slice(0, 30),
        lanes: view.lanes,
        catalog: {
          at: catalog.current.at,
          lastGoodAt: catalog.current.lastGoodAt,
          error: catalog.current.error ?? '',
          total: catalog.current.rows.length,
          groups: view.groups.length,
          families: new Set(catalog.current.rows.map(row => row.key)).size,
          providers: catalog.current.providers.map(provider => ({
            id: provider.id,
            name: provider.name,
            models: (catalog.current.byProvider.get(provider.id) ?? []).length,
            health: snapshot.lanes.find(lane => lane.provider === provider.id) ?? null,
            accounts: channelData.providerSummary(provider.id),
          })),
          failures: catalog.current.failures,
        },
        decisions: snapshot.decisions.slice(0, 40),
        dataset: datasetView(),
        // Live open calls per route and per lane. The panel shows this next to
        // the health ledger so "why did it pick the second-best lane" has a
        // visible answer: the first one was already busy.
        concurrency: inflight.snapshot(),
        peer: peerView(),
        lanesHealth: snapshot.lanes,
        modelsHealth: snapshot.models.slice(0, 40),
        strategies: ['quality', 'balanced', 'economy', 'speed'],
        modes: ['auto', 'prefer', 'manual', 'off'],
        fallbacks: ['auto', 'manual', 'off'],
        channelData: {
          available: channelData.hasData(),
          at: channelData.current.at,
          day: channelData.current.day,
          packDir: channelData.packDir,
          freeDir: channelData.freeDir,
        },
        // 定时渠道巡检：面板「巡检」页签读的就是这一块。它跟着 10 秒轮询走，
        // 所以条目有上限（见 probeView）。
        probe: probeView(),
      }
    },

    /**
     * Every model group with the facts needed to pick one, optionally filtered.
     *
     * The settings dropdown used to be fed from `summary.groups`, which is capped
     * at 30 rows for the panel — a machine with more families simply could not be
     * locked onto the rest. This is the uncapped list, fetched on demand instead
     * of riding along with the 10 s poll, with a server-side `q` filter for the
     * case where the client would rather narrow than filter locally.
     */
    families: (sessionId, query) => {
      const state = sessionState(sessionId ?? undefined)
      const view = viewFor(state)
      const config = view.config
      const needle = String(query ?? '').trim().toLowerCase()
      const all = view.groups
      const rows = needle === ''
        ? all
        : all.filter((group) => {
          const haystack = [group.family, group.key, group.bestProvider, group.bestModel, ...(group.models ?? []), ...(group.tags ?? [])]
            .filter(value => typeof value === 'string')
            .join(' ')
            .toLowerCase()
          return haystack.includes(needle)
        })
      return {
        ok: true,
        total: all.length,
        count: rows.length,
        configured: config.preferModel,
        configuredProvider: config.preferProvider,
        current: view.current === null ? null : (view.current.key ?? view.current.model),
        groups: rows,
      }
    },
  }

  function datasetView() {
    return {
      shipped: dataset.current.source.shipped,
      imported: dataset.current.source.imported,
      userFile: dataset.userFile,
      families: Object.keys(dataset.current.families).length,
      models: Object.keys(dataset.current.models).length,
      lanes: dataset.current.lanes.length,
    }
  }

  installHttpApi({ ctx, api })
  registerAgentSurface({ ctx, api })

  // A report path in the config is loaded once at startup, so pointing the
  // plugin at a refreshed report is a config change and nothing else.
  if (runtime.config.reportPath !== '') {
    const result = api.importReport(runtime.config.reportPath)
    if (result.ok !== true) {
      ctx.logger?.warn?.('model-orchestrator: could not import the configured report: ' + result.error)
    }
  }

  // Keep the persisted ledger coherent at unload.
  ctx.effect(() => () => {
    health.persist()
  }, 'model-orchestrator: persist on unload')
}

// The loader's `unwrapExports` prefers `exports.default`, and a bare function's
// `.inject` is undefined — so a default export silently drops `inject`. Export
// the namespace instead.
