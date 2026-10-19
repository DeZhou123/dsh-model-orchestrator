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
const oneOf = (...allowed) => value => typeof value === 'string' && allowed.includes(value)

/** Keys the panel, the tool, and the command are allowed to change. */
export const MUTABLE_KEYS = [
  'enabled', 'mode', 'preferModel', 'preferProvider', 'preferFallback', 'preferNotify',
  'preferAutoResume', 'preferFollowSelection', 'strategy', 'deny', 'allow', 'denyProviders',
  'maxSwitchesPerStep', 'maxSwitchesPerTurn', 'proactiveSwitch', 'escalateOnFailure',
  'requestRepeatThreshold', 'requestRepeatWindowMs', 'requestRepeatBlockMs',
  'turnTokenBudget', 'longContextThreshold', 'latencyGateMs', 'cacheSwitchPenalty',
  'cacheAffinityTokens', 'anchorBonus', 'switchMargin', 'laneSwitchMargin', 'userChoiceTtlMs',
  'routeSubagents', 'adoptUserSelection', 'reasoningEffort', 'catalogRefreshMs',
  'channelDataRefreshMs', 'modelInfoTtlMs', 'catalogTimeoutMs', 'usageUnitTokens',
  'channelData', 'freeModelData',
]

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
    userChoiceTtlMs: Math.max(0, pick(merged, DEFAULT_CONFIG, 'userChoiceTtlMs', isNumber)),
    routeSubagents: pick(merged, DEFAULT_CONFIG, 'routeSubagents', isBool),
    adoptUserSelection: pick(merged, DEFAULT_CONFIG, 'adoptUserSelection', isBool),
    reasoningEffort: pick(merged, DEFAULT_CONFIG, 'reasoningEffort', isString).trim(),
    catalogRefreshMs: Math.max(15_000, pick(merged, DEFAULT_CONFIG, 'catalogRefreshMs', isNumber)),
    persistIntervalMs: Math.max(5_000, pick(merged, DEFAULT_CONFIG, 'persistIntervalMs', isNumber)),
    channelDataRefreshMs: Math.max(5_000, pick(merged, DEFAULT_CONFIG, 'channelDataRefreshMs', isNumber)),
    modelInfoTtlMs: Math.max(60_000, pick(merged, DEFAULT_CONFIG, 'modelInfoTtlMs', isNumber)),
    catalogTimeoutMs: clamp(pick(merged, DEFAULT_CONFIG, 'catalogTimeoutMs', isNumber), 1000, 120_000),
    decisionLogSize: clamp(Math.round(pick(merged, DEFAULT_CONFIG, 'decisionLogSize', isNumber)), 10, 500),
    channelData: pick(merged, DEFAULT_CONFIG, 'channelData', isBool),
    freeModelData: pick(merged, DEFAULT_CONFIG, 'freeModelData', isBool),
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
