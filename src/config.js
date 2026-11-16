/**
 * Config resolution.
 *
 * Three layers exist, and their order is deliberate: the profile patch outranks
 * the panel, because a value pinned in `cordis.patch.yml` is a deployment
 * decision and must not be silently undone by a click. The panel writes only the
 * keys it was asked to change, so a patch never freezes unrelated settings.
 *
 * @module src/config
 */

import { DEFAULT_CONFIG, STRATEGIES as STRATEGY_TABLE } from './policy-defaults.js'

const isBool = value => typeof value === 'boolean'
const isString = value => typeof value === 'string'
const isNumber = value => typeof value === 'number' && Number.isFinite(value)
const isStringArray = value => Array.isArray(value) && value.every(entry => typeof entry === 'string')
const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const oneOf = (...allowed) => value => typeof value === 'string' && allowed.includes(value)

/** Keys the panel, the tool, and the command are allowed to change. */
export const MUTABLE_KEYS = [
  'enabled', 'mode', 'preferModel', 'preferProvider', 'preferFallback', 'preferNotify',
  'preferAutoResume', 'preferFollowSelection', 'strategy', 'deny', 'allow', 'denyProviders',
  'maxSwitchesPerStep', 'switchOverdraft', 'maxSwitchesPerTurn', 'proactiveSwitch', 'escalateOnFailure',
  // 2026-11-16 失败恢复三件套（见 index.js 的 recover / scheduleAutoResume）。
  // 放进 MUTABLE_KEYS 的理由与其它运行旋钮一致：它们是事故现场的应急开关——
  // 「自动续跑太吵」或「最后一搏等太久」都要能当场关掉，而不是去改 profile patch。
  'ownRetryBudget', 'lastResortPerStep', 'lastResortWaitMs',
  'autoResume', 'autoResumeMax', 'autoResumeDelayMs', 'autoResumeWaitCapMs',
  'requestRepeatThreshold', 'requestRepeatWindowMs', 'requestRepeatBlockMs',
  'turnTokenBudget', 'longContextThreshold', 'latencyGateMs', 'staleLatencyMode', 'sameKindEscalation',
  'cacheSwitchPenalty',
  'cacheAffinityTokens', 'cacheRebillRefBurn', 'tokenCostWeight', 'tokenCostRefInTokens',
  'anchorBonus', 'switchMargin', 'laneSwitchMargin', 'userChoiceTtlMs',
  'spreadConcurrency', 'concurrencySoftCap', 'concurrencyWeight', 'concurrencyStaleMs', 'failureBurstWindowMs',
  'routeSubagents', 'adoptUserSelection', 'routeFirstTurn', 'autoSelect', 'reasoningEffort', 'catalogRefreshMs',
  'channelDataRefreshMs', 'modelInfoTtlMs', 'catalogTimeoutMs', 'usageUnitTokens',
  'channelData', 'freeModelData', 'laneGuard', 'duoPeers', 'peerShare',
  'probeEnabled', 'probeEveryDays', 'probeIntervalMs', 'probeTimeoutMs', 'probeConcurrency', 'probeFirstDelayMs',
  'probeBorrowed', 'probeRecheckMs', 'freeLaneBonus',
  // 渠道计费声明（src/providers.js）：免费渠道的价格语义在渠道上，不在模型名上。
  // 允许用户覆盖/新增，是为了新接一条免费渠道时不必等插件发版。
  'providerProfiles',
]

/**
 * Coerce the lane guard block, keeping every default the caller left out.
 *
 * Written field by field rather than spread over the defaults: a patch that says
 * only `enabled: true` must inherit the default `laneId` and `enforce`, and a
 * patch that says `laneId: z` must not silently become a guard that blocks
 * nothing without saying so — an unknown lane falls back to the default and the
 * reason shows up in the audit.
 */
function resolveLaneGuard(raw) {
  const defaults = DEFAULT_CONFIG.laneGuard
  const value = isPlainObject(raw) ? raw : {}
  const laneId = String(value.laneId ?? defaults.laneId).trim().toLowerCase()
  return {
    enabled: isBool(value.enabled) ? value.enabled : defaults.enabled,
    laneId: laneId === 'a' || laneId === 'b' ? laneId : defaults.laneId,
    policyPath: isString(value.policyPath) ? value.policyPath.trim() : defaults.policyPath,
    enforce: isBool(value.enforce) ? value.enforce : defaults.enforce,
  }
}

/** Coerce the peer list: entries without any readable path are dropped. */
function resolveDuoPeers(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const entry of list) {
    if (!isPlainObject(entry)) continue
    const label = isString(entry.label) ? entry.label.trim() : ''
    const healthPath = isString(entry.healthPath) ? entry.healthPath.trim() : ''
    const patchPath = isString(entry.patchPath) ? entry.patchPath.trim() : ''
    if (healthPath === '' && patchPath === '') continue
    out.push({ label: label === '' ? 'peer' : label, healthPath, patchPath })
  }
  return out
}

/** 互借角色：不参与 / 既借又出 / 只出借 / 只借用。 */
export const PEER_ROLES = ['off', 'both', 'lend', 'borrow']

/** 借用车道什么时候参与打分。 */
export const PEER_BORROW_WHEN = ['exhausted', 'always']

/**
 * Coerce the peer-share block, keeping every default the caller left out.
 *
 * 写成逐字段而不是展开：patch 里只写 `enabled: true` 时必须继承默认端口与角色；
 * 而写了 `role: 'lend'` 也不能把 `peerProvider` 变成空串——那会让借用方的回环守卫失效。
 * 端口用 0 表示「由系统分配」，其余越界值退回默认。
 */
function resolvePeerShare(raw) {
  const defaults = DEFAULT_CONFIG.peerShare
  const value = isPlainObject(raw) ? raw : {}
  const role = String(value.role ?? defaults.role).trim().toLowerCase()
  const borrowWhen = String(value.borrowWhen ?? defaults.borrowWhen).trim().toLowerCase()
  const port = Math.round(Number(value.port ?? defaults.port))
  return {
    enabled: isBool(value.enabled) ? value.enabled : defaults.enabled,
    role: PEER_ROLES.includes(role) ? role : defaults.role,
    label: isString(value.label) ? value.label.trim() : defaults.label,
    host: isString(value.host) && value.host.trim() !== '' ? value.host.trim() : defaults.host,
    port: Number.isFinite(port) && port >= 0 && port <= 65535 ? port : defaults.port,
    token: isString(value.token) ? value.token.trim() : defaults.token,
    allowProviders: isStringArray(value.allowProviders)
      ? value.allowProviders.map(entry => entry.trim().toLowerCase()).filter(Boolean)
      : [...defaults.allowProviders],
    denyProviders: isStringArray(value.denyProviders)
      ? value.denyProviders.map(entry => entry.trim().toLowerCase()).filter(Boolean)
      : [...defaults.denyProviders],
    peerUrl: isString(value.peerUrl) ? value.peerUrl.trim() : defaults.peerUrl,
    peerToken: isString(value.peerToken) ? value.peerToken.trim() : defaults.peerToken,
    peerProvider: (isString(value.peerProvider) ? value.peerProvider.trim() : defaults.peerProvider) || defaults.peerProvider,
    borrowWhen: PEER_BORROW_WHEN.includes(borrowWhen) ? borrowWhen : defaults.borrowWhen,
    timeoutMs: clamp(Math.round(Number(value.timeoutMs ?? defaults.timeoutMs)) || defaults.timeoutMs, 1000, 300_000),
  }
}

/** Modes the router understands. */
export const MODES = ['auto', 'prefer', 'manual', 'off']

/** Fallback modes available while a preference is exhausted. */
export const FALLBACK_MODES = ['auto', 'manual', 'off']

/**
 * Strategies the scorer understands.
 *
 * 派生自 policy-defaults 的 STRATEGIES（唯一事实来源，FIX 2026-11-16）。此前这里
 * 另写了一份字面量白名单：新增一个策略时只改一边，config 会静默把新值判成非法并回退
 * 到默认策略——「加了策略但策略不生效」这种故障没有任何提示。
 */
export const STRATEGIES = Object.keys(STRATEGY_TABLE)

/** Coerce one raw value, keeping the default when the value is unusable. */
function pick(raw, defaults, key, guard) {
  const value = raw?.[key]
  if (value === undefined || value === null) return defaults[key]
  return guard(value) ? value : defaults[key]
}

/** Clamp a numeric setting into a range. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Merge defaults, the persisted UI overrides, and the profile patch.
 *
 * Legacy `pinProvider`/`pinModel` are folded into the preference fields:
 * a pinned lane was the old spelling of "use exactly this model", and keeping
 * two answers to one question is how the panel and the router start disagreeing.
 *
 * @param {object} raw - the loader row's config (profile patch).
 * @param {object} overrides - the panel's persisted values.
 * @returns {object} resolved config.
 */
export function resolveConfig(raw, overrides) {
  const merged = { ...(overrides ?? {}), ...(raw ?? {}) }
  const config = {
    enabled: pick(merged, DEFAULT_CONFIG, 'enabled', isBool),
    mode: pick(merged, DEFAULT_CONFIG, 'mode', oneOf(...MODES)),
    preferModel: pick(merged, DEFAULT_CONFIG, 'preferModel', isString).trim(),
    preferProvider: pick(merged, DEFAULT_CONFIG, 'preferProvider', isString).trim(),
    preferFallback: pick(merged, DEFAULT_CONFIG, 'preferFallback', oneOf(...FALLBACK_MODES)),
    preferNotify: pick(merged, DEFAULT_CONFIG, 'preferNotify', isBool),
    preferAutoResume: pick(merged, DEFAULT_CONFIG, 'preferAutoResume', isBool),
    preferFollowSelection: pick(merged, DEFAULT_CONFIG, 'preferFollowSelection', isBool),
    strategy: pick(merged, DEFAULT_CONFIG, 'strategy', oneOf(...STRATEGIES)),
    pinProvider: pick(merged, DEFAULT_CONFIG, 'pinProvider', isString).trim(),
    pinModel: pick(merged, DEFAULT_CONFIG, 'pinModel', isString).trim(),
    deny: pick(merged, DEFAULT_CONFIG, 'deny', isStringArray).map(value => value.trim()).filter(Boolean),
    allow: pick(merged, DEFAULT_CONFIG, 'allow', isStringArray).map(value => value.trim()).filter(Boolean),
    denyProviders: pick(merged, DEFAULT_CONFIG, 'denyProviders', isStringArray).map(value => value.trim().toLowerCase()).filter(Boolean),
    // 上限与 README 键表对齐（FIX 2026-11-16）。旧上限 10 会把用户填的 20 静默截成
    // 12（10 + EXTRA_SWITCHES），配置面在说谎；30 足够覆盖「一条真死的目录」而不至于
    // 把一轮变成扫描器。
    maxSwitchesPerStep: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'maxSwitchesPerStep', isNumber)), 0, 30),
    // 超额余量从硬编码常量变成配置键（FIX 2026-11-16）：它此前不在 MUTABLE_KEYS、
    // 也不在 README，用户算不出实际预算。见 index.js 的 EXTRA_SWITCHES 注释。
    switchOverdraft: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'switchOverdraft', isNumber)), 0, 10),
    maxSwitchesPerTurn: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'maxSwitchesPerTurn', isNumber)), 0, 100),
    proactiveSwitch: pick(merged, DEFAULT_CONFIG, 'proactiveSwitch', isBool),
    escalateOnFailure: pick(merged, DEFAULT_CONFIG, 'escalateOnFailure', isBool),
    // ── 失败恢复三件套（2026-11-16）─────────────────────────────────────────
    // ownRetryBudget: 「调度器还是内核掌管同车道重试」的开关。默认给调度器——
    //   内核的 llm-retry 对同一个 provider 有 5 次盲重试，跟换道叠在一起会把
    //   一个步骤烧成 15~22 次尝试（见 index.js 的 recover 头部注释）。
    ownRetryBudget: pick(merged, DEFAULT_CONFIG, 'ownRetryBudget', isBool),
    // lastResort*: 候选全在冷却时的"等到最早那条回来"。等得太久不如不做，
    //   所以 waitMs 有硬上限，perStep 限制次数。
    lastResortPerStep: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'lastResortPerStep', isNumber)), 0, 5),
    lastResortWaitMs: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'lastResortWaitMs', isNumber)), 0, 120_000),
    // autoResume*: 回合以 error 收场后自动续跑。max 是连击上限（成功即归零），
    //   delayMs 是基础停顿，waitCapMs 是与账本对齐时的等待上限。
    autoResume: pick(merged, DEFAULT_CONFIG, 'autoResume', isBool),
    autoResumeMax: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'autoResumeMax', isNumber)), 0, 10),
    autoResumeDelayMs: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'autoResumeDelayMs', isNumber)), 0, 60_000),
    autoResumeWaitCapMs: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'autoResumeWaitCapMs', isNumber)), 0, 600_000),
    // Repeated-rejection guard: a lane that refuses our requests N times in a
    // row inside the window is parked for a bounded while (see src/health.js).
    requestRepeatThreshold: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'requestRepeatThreshold', isNumber)), 1, 10),
    requestRepeatWindowMs: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'requestRepeatWindowMs', isNumber)), 60_000, 24 * 60 * 60_000),
    requestRepeatBlockMs: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'requestRepeatBlockMs', isNumber)), 0, 24 * 60 * 60_000),
    turnTokenBudget: Math.max(0, Math.round(pick(merged, DEFAULT_CONFIG, 'turnTokenBudget', isNumber))),
    longContextThreshold: Math.max(1000, pick(merged, DEFAULT_CONFIG, 'longContextThreshold', isNumber)),
    latencyGateMs: Math.max(0, pick(merged, DEFAULT_CONFIG, 'latencyGateMs', isNumber)),
    staleLatencyMode: pick(merged, DEFAULT_CONFIG, 'staleLatencyMode', oneOf('penalize', 'neutral')),
    sameKindEscalation: pick(merged, DEFAULT_CONFIG, 'sameKindEscalation', isBool),
    cacheSwitchPenalty: clamp(pick(merged, DEFAULT_CONFIG, 'cacheSwitchPenalty', isNumber), 0, 1),
    cacheAffinityTokens: Math.max(1000, pick(merged, DEFAULT_CONFIG, 'cacheAffinityTokens', isNumber)),
  cacheRebillRefBurn: clamp(pick(merged, DEFAULT_CONFIG, 'cacheRebillRefBurn', isNumber), 0.05, 5),
    // 成本项的实测修正（见 policy-defaults 的 TOKEN_COST）。weight=0 即退回「只看倍率」。
    tokenCostWeight: clamp(pick(merged, DEFAULT_CONFIG, 'tokenCostWeight', isNumber), 0, 1),
    tokenCostRefInTokens: Math.max(1000, pick(merged, DEFAULT_CONFIG, 'tokenCostRefInTokens', isNumber)),
    anchorBonus: clamp(pick(merged, DEFAULT_CONFIG, 'anchorBonus', isNumber), 0, 0.2),
    switchMargin: clamp(pick(merged, DEFAULT_CONFIG, 'switchMargin', isNumber), 0, 0.5),
    laneSwitchMargin: clamp(pick(merged, DEFAULT_CONFIG, 'laneSwitchMargin', isNumber), 0, 0.5),
    // Concurrency spreading (see CONCURRENCY in policy-defaults). The weight is
    // capped at 0.3: above that the penalty starts outweighing the strategy
    // weights it is supposed to break ties between, and a single open call would
    // be able to hide a genuinely better model.
    spreadConcurrency: pick(merged, DEFAULT_CONFIG, 'spreadConcurrency', isBool),
    concurrencySoftCap: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'concurrencySoftCap', isNumber)), 1, 16),
    concurrencyWeight: clamp(pick(merged, DEFAULT_CONFIG, 'concurrencyWeight', isNumber), 0, 0.3),
    failureBurstWindowMs: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'failureBurstWindowMs', isNumber)), 0, 60_000),
    concurrencyStaleMs: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'concurrencyStaleMs', isNumber)), 60_000, 60 * 60_000),
    userChoiceTtlMs: Math.max(0, pick(merged, DEFAULT_CONFIG, 'userChoiceTtlMs', isNumber)),
    routeSubagents: pick(merged, DEFAULT_CONFIG, 'routeSubagents', isBool),
    adoptUserSelection: pick(merged, DEFAULT_CONFIG, 'adoptUserSelection', isBool),
    routeFirstTurn: pick(merged, DEFAULT_CONFIG, 'routeFirstTurn', isBool),
    autoSelect: pick(merged, DEFAULT_CONFIG, 'autoSelect', isBool),
    reasoningEffort: pick(merged, DEFAULT_CONFIG, 'reasoningEffort', isString).trim(),
    // 定时渠道巡检（2026-11-03）。开关与间隔都走 pick，面板/工具随时可改；
    // 间隔的计算留在 src/probe.js 的 resolveIntervalMs 里，这里只做类型收敛，
    // 免得同一个「3 天 / 259200000ms」的换算写两遍。
    probeEnabled: pick(merged, DEFAULT_CONFIG, 'probeEnabled', isBool),
    probeEveryDays: Math.max(0, pick(merged, DEFAULT_CONFIG, 'probeEveryDays', isNumber)),
    probeIntervalMs: Math.max(0, pick(merged, DEFAULT_CONFIG, 'probeIntervalMs', isNumber)),
    probeTimeoutMs: Math.max(1_000, pick(merged, DEFAULT_CONFIG, 'probeTimeoutMs', isNumber)),
    probeConcurrency: Math.min(8, Math.max(1, pick(merged, DEFAULT_CONFIG, 'probeConcurrency', isNumber))),
    probeFirstDelayMs: Math.max(0, pick(merged, DEFAULT_CONFIG, 'probeFirstDelayMs', isNumber)),
    probeRecheckMs: Math.max(0, pick(merged, DEFAULT_CONFIG, 'probeRecheckMs', isNumber)),
    freeLaneBonus: Math.min(0.3, Math.max(0, pick(merged, DEFAULT_CONFIG, 'freeLaneBonus', isNumber))),
    providerProfiles: (() => {
      const raw = merged.providerProfiles ?? DEFAULT_CONFIG.providerProfiles
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CONFIG.providerProfiles }
      return { ...raw }
    })(),
    probeBorrowed: pick(merged, DEFAULT_CONFIG, 'probeBorrowed', isBool),
    catalogRefreshMs: Math.max(15_000, pick(merged, DEFAULT_CONFIG, 'catalogRefreshMs', isNumber)),
    persistIntervalMs: Math.max(5_000, pick(merged, DEFAULT_CONFIG, 'persistIntervalMs', isNumber)),
    channelDataRefreshMs: Math.max(5_000, pick(merged, DEFAULT_CONFIG, 'channelDataRefreshMs', isNumber)),
    modelInfoTtlMs: Math.max(60_000, pick(merged, DEFAULT_CONFIG, 'modelInfoTtlMs', isNumber)),
    catalogTimeoutMs: clamp(pick(merged, DEFAULT_CONFIG, 'catalogTimeoutMs', isNumber), 1000, 120_000),
    decisionLogSize: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'decisionLogSize', isNumber)), 10, 500),
    channelData: pick(merged, DEFAULT_CONFIG, 'channelData', isBool),
    freeModelData: pick(merged, DEFAULT_CONFIG, 'freeModelData', isBool),
    laneGuard: resolveLaneGuard(pick(merged, DEFAULT_CONFIG, 'laneGuard', isPlainObject)),
    duoPeers: resolveDuoPeers(pick(merged, DEFAULT_CONFIG, 'duoPeers', Array.isArray)),
    peerShare: resolvePeerShare(pick(merged, DEFAULT_CONFIG, 'peerShare', isPlainObject)),
    channelPackDir: pick(merged, DEFAULT_CONFIG, 'channelPackDir', isString),
    freeModelDir: pick(merged, DEFAULT_CONFIG, 'freeModelDir', isString),
    usageUnitTokens: Math.max(10_000, pick(merged, DEFAULT_CONFIG, 'usageUnitTokens', isNumber)),
    reportPath: pick(merged, DEFAULT_CONFIG, 'reportPath', isString),
  }

  // ── legacy pin -> preference ──────────────────────────────────────────────
  // An exact lane pin is the old spelling of "only this model". It used to be
  // honoured only when BOTH fields were set, and the router would then still
  // change model on failure; the preference model is the same intent done
  // properly (same model, different channel).
  if (config.pinModel !== '') {
    if (config.preferModel === '') {
      config.preferModel = config.pinModel
      config.preferProvider = config.pinProvider
    }
    if (config.mode === 'auto') config.mode = 'prefer'
  }
  if (config.mode === 'prefer' && config.preferModel === '') config.mode = 'auto'
  if (config.mode === 'prefer' && config.preferFallback === 'prefer') config.preferFallback = 'auto'
  return config
}

/** Keep only the keys a settings patch is allowed to touch. */
export function sanitizePatch(patch) {
  const requested = {}
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!MUTABLE_KEYS.includes(key)) continue
    requested[key] = value
  }
  return requested
}

export default resolveConfig
