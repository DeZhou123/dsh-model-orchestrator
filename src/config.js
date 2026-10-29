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

import { DEFAULT_CONFIG } from './policy-defaults.js'

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
  'maxSwitchesPerStep', 'maxSwitchesPerTurn', 'proactiveSwitch', 'escalateOnFailure',
  'requestRepeatThreshold', 'requestRepeatWindowMs', 'requestRepeatBlockMs',
  'turnTokenBudget', 'longContextThreshold', 'latencyGateMs', 'cacheSwitchPenalty',
  'cacheAffinityTokens', 'anchorBonus', 'switchMargin', 'laneSwitchMargin', 'userChoiceTtlMs',
  'spreadConcurrency', 'concurrencySoftCap', 'concurrencyWeight', 'concurrencyStaleMs', 'failureBurstWindowMs',
  'routeSubagents', 'adoptUserSelection', 'routeFirstTurn', 'autoSelect', 'reasoningEffort', 'catalogRefreshMs',
  'channelDataRefreshMs', 'modelInfoTtlMs', 'catalogTimeoutMs', 'usageUnitTokens',
  'channelData', 'freeModelData', 'laneGuard', 'duoPeers', 'peerShare',
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

/** Strategies the scorer understands. */
export const STRATEGIES = ['quality', 'balanced', 'economy', 'speed']

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
    maxSwitchesPerStep: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'maxSwitchesPerStep', isNumber)), 0, 10),
    maxSwitchesPerTurn: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'maxSwitchesPerTurn', isNumber)), 0, 100),
    proactiveSwitch: pick(merged, DEFAULT_CONFIG, 'proactiveSwitch', isBool),
    escalateOnFailure: pick(merged, DEFAULT_CONFIG, 'escalateOnFailure', isBool),
    // Repeated-rejection guard: a lane that refuses our requests N times in a
    // row inside the window is parked for a bounded while (see src/health.js).
    requestRepeatThreshold: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'requestRepeatThreshold', isNumber)), 1, 10),
    requestRepeatWindowMs: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'requestRepeatWindowMs', isNumber)), 60_000, 24 * 60 * 60_000),
    requestRepeatBlockMs: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'requestRepeatBlockMs', isNumber)), 0, 24 * 60 * 60_000),
    turnTokenBudget: Math.max(0, Math.round(pick(merged, DEFAULT_CONFIG, 'turnTokenBudget', isNumber))),
    longContextThreshold: Math.max(1000, pick(merged, DEFAULT_CONFIG, 'longContextThreshold', isNumber)),
    latencyGateMs: Math.max(0, pick(merged, DEFAULT_CONFIG, 'latencyGateMs', isNumber)),
    cacheSwitchPenalty: clamp(pick(merged, DEFAULT_CONFIG, 'cacheSwitchPenalty', isNumber), 0, 1),
    cacheAffinityTokens: Math.max(1000, pick(merged, DEFAULT_CONFIG, 'cacheAffinityTokens', isNumber)),
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
