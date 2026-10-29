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

import { createDataset, familyFor, writeJsonAtomic } from './src/dataset.js'
import { createHealth, KIND } from './src/health.js'
import { createCatalog } from './src/catalog.js'
import { createChannelData } from './src/channels.js'
import { loadOrCreateToken, lendableRows, startPeerShareServer } from './src/peershare.js'
import { createPeerAdapter } from './src/peershare-adapter.js'
import { createObserver } from './src/observe.js'
import { createInflight } from './src/inflight.js'
import {
  evaluate, rankGroups, rankLanes, readNeeds, resolvePreferenceGroup, selectRoute,
} from './src/router.js'
import { DEFAULT_CONFIG } from './src/policy-defaults.js'
import { foldKey } from './src/families.js'
import { installHttpApi } from './src/http.js'
import { registerAgentSurface } from './src/tools.js'
import { datasetFromReport } from './src/report-import.js'
import { resolveConfig, sanitizePatch } from './src/config.js'

export const name = 'model-orchestrator'

/** `llm` is what the plugin exists for. The rest degrades feature by feature. */
export const inject = ['llm']

export const version = '2.6.0'

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
  const writeOverrides = (value) => {
    try {
      writeJsonAtomic(overridesFile, value)
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

  // The ledger is created after `runtime` because its repeated-rejection policy
  // is read from the live config on every failure: the panel may change the
  // threshold, and the next rejection must obey the value in effect then.
  const health = createHealth({
    userDir,
    persistMs: DEFAULT_CONFIG.persistIntervalMs,
    requestPolicy: () => runtime.config,
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
  const inflight = createInflight({ staleMs: Number(runtime.config.concurrencyStaleMs ?? 0) || undefined })

  const observer = createObserver({
    health,
    inflight,
    onSample: (sample) => {
      const state = sample.sessionId === undefined ? undefined : sessions.get(sample.sessionId)
      if (state === undefined) return
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
      if (state !== undefined) state.lastFailureAt = Date.now()
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

  function peerConfig() {
    return runtime.config.peerShare ?? DEFAULT_CONFIG.peerShare
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

  /** 关掉正在跑的中继（幂等）。 */
  async function stopPeerServer() {
    const server = peerState.server
    peerState.server = null
    peerState.serverInfo = null
    if (server === null) return
    try {
      await server.close()
    } catch (error) {
      ctx.logger?.warn?.('model-orchestrator: 关闭互借中继失败 — ' + (error instanceof Error ? error.message : String(error)))
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
    syncPeerServer().catch(() => {})
    syncPeerBorrower()
    return () => {
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

  function publicConfig() {
    return { ...runtime.config }
  }

  // ── live catalog ──────────────────────────────────────────────────────────
  let lastCatalogAt = 0
  let lastChannelAt = Date.now()
  let lastPersistAt = 0

  function refreshCatalog(reason) {
    return catalog.refresh(reason)
      .then((current) => {
        lastCatalogAt = Date.now()
        health.prune(catalog.providerIds)
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
      }, 15_000),
      'model-orchestrator: housekeeping',
    )
  })

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
    return {
      rows: catalog.current.rows,
      health,
      // Live open-call counts, so concurrent sessions spread instead of
      // stacking on the single best-looking lane (LOCAL PATCH 2026-10-26).
      inflight,
      dataset,
      config,
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
          notify('偏好模式已暂停',
            '偏好模型 ' + decision.exhausted.model + ' 的所有渠道都不可用。' + decision.exhausted.reason
            + ' 已临时改用' + fallbackName(decision.mode) + '模式。')
        }
      }
      return
    }
    if (state.preferenceExhausted !== null) {
      state.preferenceExhausted = null
      state.preferenceSuspended = false
      health.logDecision({
        kind: 'preference-resumed',
        to: runtime.config.preferModel,
        from: null,
        reason: '偏好模型已有可用渠道',
        sessionId: state.agent.id,
      }, runtime.config.decisionLogSize)
      if (runtime.config.preferNotify !== false) {
        notify('偏好模式已恢复', '偏好模型 ' + runtime.config.preferModel + ' 重新有可用渠道。')
      }
    }
  }

  function fallbackName(mode) {
    if (mode === 'manual') return '手动'
    if (mode === 'off') return '关闭'
    return '自动'
  }

  /** Compute and install the route for the step that is about to assemble. */
  function routeForStep(state, assembly) {
    const config = runtime.config
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

    const input = selectionInput(state)
    const decision = selectRoute(input)
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
    health.persist()
    // A single rejected request is our own mistake and must not move the route
    // — the lane is innocent. One that repeats is not: `markFailure` parks the
    // model after `requestRepeatThreshold` refusals inside the window and flags
    // the verdict `blocked`, and that verdict is what lets this turn reroute
    // instead of ending in an error the user has to work around by hand.
    if (verdict.kind === KIND.REQUEST && verdict.blocked !== true) return next()
    if (state.stepSwitches >= config.maxSwitchesPerStep) return next()
    if (state.turnSwitches >= config.maxSwitchesPerTurn) return next()

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
    const input = {
      ...selectionInput(state),
      anchor,
      needs,
      // Same model first, on a different channel. A context-window failure is
      // the one case where the same model cannot help.
      forceGroupKey: isContext ? null : failedKey,
      exclude: new Set([route.provider + '\u0000' + route.model]),
      minContextWindow: isContext && Number.isFinite(failedRow?.contextWindow) ? failedRow.contextWindow : undefined,
    }
    let decision = null
    try {
      decision = selectRoute(input)
    } catch {
      decision = null
    }
    if (decision === null) return next()
    if (decision.blocked === true) {
      if (input.mode === 'prefer') notePreference(state, decision)
      if (decision.fallback === 'off') state.applied = null
      return next()
    }
    if (input.mode === 'prefer') notePreference(state, decision)
    if (decision.provider === route.provider && decision.model === route.model) return next()

    state.stepSwitches += 1
    state.turnSwitches += 1
    try {
      applyRoute(state, decision, 'failover')
    } catch {
      return next()
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

  function failureReason(verdict) {
    if (verdict.kind === KIND.QUOTA) return '额度耗尽'
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
      return
    }
    if (event.type === 'turn/end') {
      // A turn is the safe point to hand the model back: the conversation is
      // complete, so a switch now cannot split one exchange across two models.
      restoreUserChoice(state)
      return
    }
    if (event.type === 'step/start') {
      state.step = Number(event.data?.step ?? -1)
      state.stepSwitches = 0
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
  ctx.on('agent/request-error', (payload, next) => {
    const state = sessions.get(payload.agent.id)
    if (state === undefined) return next()
    return recover(state, payload, next).catch(() => undefined)
  })

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
