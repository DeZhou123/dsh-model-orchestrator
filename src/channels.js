/**
 * Channel-side measurements, read from the local channel pack.
 *
 * The orchestrator cannot see a channel's account pool, its per-model rate
 * limits, or its own recorded first-token latency through the LLM registry:
 * `llm.listModels()` knows the model exists, not that the account serving it
 * is parked until 14:20. The channel pack already records exactly that, on this
 * machine, in plain JSON — so the honest thing is to read it instead of
 * guessing from the report.
 *
 * Everything here is optional. A missing file, a schema this build does not
 * recognise, or a provider the pack does not know simply yields "no signal";
 * routing then falls back to the traffic ledger the plugin measures itself.
 *
 * @module src/channels
 */

import fs from 'node:fs'
import path from 'node:path'
import { foldKey } from './families.js'

const MAX_JSON_BYTES = 8 * 1024 * 1024

/** Read one JSON file, or undefined. Never throws. */
function readJson(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return undefined
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Today's key in the channel pack's own timezone (UTC+8). */
export function packDayKey(now = Date.now()) {
  const shifted = new Date(now + 8 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

/** Lowercase model key used by every lookup in this module. */
function modelKey(provider, model) {
  return `${String(provider ?? '').toLowerCase()}\u0000${String(model ?? '').toLowerCase()}`
}

/**
 * Create the channel-data reader.
 *
 * @param {{home?: string, channelPackDir?: string, freeModelDir?: string, enabled?: boolean, freeEnabled?: boolean, clock?: () => number, logger?: object}} options
 */
export function createChannelData(options = {}) {
  const clock = options.clock ?? (() => Date.now())
  const home = options.home ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  const packDir = options.channelPackDir !== undefined && options.channelPackDir !== ''
    ? options.channelPackDir
    : path.join(home, 'channel-pack')
  const freeDir = options.freeModelDir !== undefined && options.freeModelDir !== ''
    ? options.freeModelDir
    : path.join(home, 'our-free-model')
  const enabled = options.enabled !== false
  const freeEnabled = options.freeEnabled !== false
  const logger = options.logger

  let state = emptyState()

  function emptyState() {
    return {
      at: 0,
      error: '',
      /** provider -> { total, enabled, limitedUntil: Map<modelLower, until> } */
      accounts: new Map(),
      /** provider -> Map<modelLower, disabled> */
      disabled: new Map(),
      /** `provider\0model` -> today's counters */
      laneStats: new Map(),
      /** modelLower -> free-lane availability verdict */
      freeAvailability: new Map(),
      /** modelLower -> free-lane today's counters */
      freeStats: new Map(),
      day: packDayKey(clock()),
    }
  }

  function readAccounts(raw) {
    const accounts = new Map()
    for (const account of Array.isArray(raw?.accounts) ? raw.accounts : []) {
      if (typeof account?.provider !== 'string' || account.provider === '') continue
      const provider = account.provider.toLowerCase()
      const entry = accounts.get(provider) ?? { total: 0, enabled: 0, limits: new Map() }
      entry.total += 1
      if (account.enabled !== false) entry.enabled += 1
      if (account.enabled !== false && account.modelRateLimits !== null && typeof account.modelRateLimits === 'object') {
        for (const [model, until] of Object.entries(account.modelRateLimits)) {
          const at = Number(until)
          if (!Number.isFinite(at) || at <= clock()) continue
          const key = String(model).toLowerCase()
          const previous = entry.limits.get(key) ?? { until: 0, accounts: 0 }
          entry.limits.set(key, { until: Math.max(previous.until, at), accounts: previous.accounts + 1 })
        }
      }
      accounts.set(provider, entry)
    }
    return accounts
  }

  function readDisabled(raw) {
    const disabled = new Map()
    for (const [provider, models] of Object.entries(raw?.disabledModels ?? {})) {
      if (models === null || typeof models !== 'object') continue
      const set = new Map()
      for (const [model, value] of Object.entries(models)) {
        if (value === true) set.set(String(model).toLowerCase(), true)
      }
      if (set.size > 0) disabled.set(String(provider).toLowerCase(), set)
    }
    return disabled
  }

  function readLedger(raw, day) {
    const stats = new Map()
    const buckets = raw?.days?.[day]
    if (buckets === null || typeof buckets !== 'object') return stats
    for (const [key, bucket] of Object.entries(buckets)) {
      // `channel|provider|account|model`; the model segment may itself contain
      // '|' on odd ids, so it is re-joined instead of split-and-indexed.
      const parts = String(key).split('|')
      if (parts.length < 4) continue
      const provider = parts[1].toLowerCase()
      const model = parts.slice(3).join('|').toLowerCase()
      if (provider === '' || model === '') continue
      const laneKey = modelKey(provider, model)
      const total = stats.get(laneKey) ?? {
        requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        ttftSumMs: 0, ttftCount: 0, tpsSum: 0, tpsCount: 0,
      }
      total.requests += Number(bucket?.requests ?? 0) || 0
      total.errors += Number(bucket?.errors ?? 0) || 0
      total.inputTokens += Number(bucket?.inputTokens ?? 0) || 0
      total.outputTokens += Number(bucket?.outputTokens ?? 0) || 0
      total.cacheReadTokens += Number(bucket?.cacheReadTokens ?? 0) || 0
      total.ttftSumMs += Number(bucket?.ttftSumMs ?? 0) || 0
      total.ttftCount += Number(bucket?.ttftCount ?? 0) || 0
      total.tpsSum += Number(bucket?.tpsSum ?? 0) || 0
      total.tpsCount += Number(bucket?.tpsCount ?? 0) || 0
      stats.set(laneKey, total)
    }
    for (const [key, value] of stats) {
      stats.set(key, {
        ...value,
        ttftMs: value.ttftCount > 0 ? Math.round(value.ttftSumMs / value.ttftCount) : null,
        tps: value.tpsCount > 0 ? Math.round((value.tpsSum / value.tpsCount) * 10) / 10 : null,
      })
    }
    return stats
  }

  function readFreeAvailability(raw) {
    const map = new Map()
    const results = raw?.results
    if (results === null || typeof results !== 'object') return map
    for (const [model, verdict] of Object.entries(results)) {
      if (verdict === null || typeof verdict !== 'object') continue
      map.set(String(model).toLowerCase(), {
        state: String(verdict.state ?? 'unknown'),
        detail: String(verdict.detail ?? ''),
        ttftMs: Number.isFinite(Number(verdict.latencyMs)) && Number(verdict.latencyMs) > 0 ? Number(verdict.latencyMs) : null,
        at: Number(verdict.at ?? 0) || 0,
      })
    }
    return map
  }

  function readFreeStats(raw, day) {
    const map = new Map()
    const models = raw?.days?.[day]?.models
    if (models === null || typeof models !== 'object') return map
    for (const [model, entry] of Object.entries(models)) {
      if (entry === null || typeof entry !== 'object') continue
      map.set(String(model).toLowerCase(), {
        calls: Number(entry.calls ?? 0) || 0,
        failed: Number(entry.failed ?? 0) || 0,
        inputTokens: Number(entry.input ?? 0) || 0,
        outputTokens: Number(entry.output ?? 0) || 0,
        cacheReadTokens: Number(entry.cacheRead ?? 0) || 0,
        ttftMs: Number(entry.ttftSamples ?? 0) > 0 && Number(entry.ttftMs ?? 0) > 0
          ? Math.round(Number(entry.ttftMs) / Number(entry.ttftSamples))
          : null,
        ttftSamples: Number(entry.ttftSamples ?? 0) || 0,
      })
    }
    return map
  }

  /** Re-read every local source. Missing files degrade to "no signal". */
  function refresh() {
    if (!enabled && !freeEnabled) return state
    const now = clock()
    const next = emptyState()
    next.at = now
    next.day = packDayKey(now)
    try {
      if (enabled) {
        const packState = readJson(path.join(packDir, 'state.json'))
        const ledger = readJson(path.join(packDir, 'token-ledger.json'))
        if (packState !== undefined) {
          next.accounts = readAccounts(packState)
          next.disabled = readDisabled(packState)
        }
        if (ledger !== undefined) next.laneStats = readLedger(ledger, next.day)
      }
      if (freeEnabled) {
        const availability = readJson(path.join(freeDir, 'availability.json'))
        const stats = readJson(path.join(freeDir, 'stats.json'))
        if (availability !== undefined) next.freeAvailability = readFreeAvailability(availability)
        if (stats !== undefined) next.freeStats = readFreeStats(stats, next.day)
      }
    } catch (error) {
      next.error = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`model-orchestrator: channel data unavailable: ${next.error}`)
    }
    state = next
    return state
  }

  /** Look up a value in a per-model map, tolerating separator spellings. */
  function lookup(map, model) {
    if (map === null) return undefined
    const key = String(model ?? '').toLowerCase()
    const exact = map.get(key)
    if (exact !== undefined) return exact
    const folded = foldKey(key)
    for (const [candidate, value] of map) {
      if (foldKey(candidate) === folded) return value
    }
    return undefined
  }

  /**
   * Everything the channel side knows about one exact route.
   *
   * @param {string} provider - provider route.
   * @param {string} model - exact model id.
   * @returns {{available: boolean|null, disabled: boolean, rateLimitedUntil: number, limitedAccounts: number, accounts: number, today: object|null, free: object|null, freeToday: object|null}}
   */
  function signal(provider, model) {
    const providerKey = String(provider ?? '').toLowerCase()
    const modelKeyLower = String(model ?? '').toLowerCase()
    const account = state.accounts.get(providerKey)
    const limit = account === undefined ? undefined : lookup(account.limits, modelKeyLower)
    const disabled = state.disabled.get(providerKey)?.get(modelKeyLower) === true
    const today = state.laneStats.get(modelKey(providerKey, modelKeyLower)) ?? null
    const free = lookup(state.freeAvailability, modelKeyLower) ?? null
    const freeToday = lookup(state.freeStats, modelKeyLower) ?? null

    let available = null
    if (disabled) available = false
    else if (limit !== undefined && account !== undefined && account.enabled > 0 && limit.accounts >= account.enabled) {
      // Every enabled account is rate-limited for this model, which is exactly
      // the channel pack's own "cannot serve now" condition.
      available = false
    } else if (free !== null) {
      if (free.state === 'unavailable' || free.state === 'regionBlocked') available = false
      else if (free.state === 'throttled') available = false
      else if (free.state === 'available') available = true
    }

    return {
      available,
      disabled,
      rateLimitedUntil: limit?.until ?? 0,
      limitedAccounts: limit?.accounts ?? 0,
      accounts: account?.enabled ?? 0,
      today,
      free,
      freeToday,
    }
  }

  /** One provider's account summary for the panel. */
  function providerSummary(provider) {
    const account = state.accounts.get(String(provider ?? '').toLowerCase())
    return account === undefined
      ? null
      : { accounts: account.enabled, limitedModels: account.limits.size }
  }

  /** Whether any source was readable at all. */
  function hasData() {
    return state.laneStats.size > 0 || state.accounts.size > 0 || state.freeAvailability.size > 0
  }

  return {
    refresh,
    signal,
    providerSummary,
    hasData,
    get current() {
      return state
    },
    packDir,
    freeDir,
  }
}

export default createChannelData
