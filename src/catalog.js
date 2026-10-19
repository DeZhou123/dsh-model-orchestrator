/**
 * Live catalog sync.
 *
 * The orchestrator never hardcodes a lane list. It asks the LLM registry what is
 * routable right now, so a channel the user logs into later — or an account
 * added to an existing channel — shows up on the next refresh with no plugin
 * change. `llm/adapters-updated` is the signal that the topology moved.
 *
 * Three facts are deliberately kept apart on each row, because they come from
 * three different sources and have three different lifetimes:
 *
 *   - **family / intelligence** — prior knowledge from the report (slow, coarse);
 *   - **capabilities** — context window, modalities, reasoning efforts, read from
 *     the adapter that will actually serve the call (authoritative per lane);
 *   - **lane health and usage** — recorded traffic and the channel pack's own
 *     ledger (fast, exact, this machine only).
 *
 * @module src/catalog
 */

import { familyInfo, familyResolutionFor, deniedReason, reportLaneTtft } from './dataset.js'
import { foldKey, NON_INTERACTIVE_SUFFIX } from './families.js'
import { EFFORT_RANK, MAX_INTEL, NEUTRAL_INTEL_SCORE } from './policy-defaults.js'

/** Run `worker` over `items` with a bounded number in flight. */
async function pooled(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** Race a promise against a deadline without leaking the loser. */
async function withDeadline(promise, ms, what) {
  if (!(ms > 0)) return promise
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The token-burn bucket of a family, from the report's own tags. */
function costFactor(tags) {
  if (tags.includes('cheapest')) return 0.05
  if (tags.includes('cheap')) return 0.22
  if (tags.includes('budget')) return 0.3
  if (tags.includes('expensive')) return 0.85
  if (tags.includes('verbose') || tags.includes('slow-decode')) return 1
  if (tags.includes('flagship')) return 0.7
  return 0.45
}

/**
 * The lane's own billing multiplier, parsed from the advertised display name
 * (e.g. "DeepSeek-V4-Flash · x0.2") — the only place the registry carries it.
 *
 * Only the segment after the last "·" is read, so the model name itself
 * ("Spark-X2.5", "Mixtral 8x22b") is never mistaken for a price; the last number
 * in that segment wins, so a discount range "x0.12→x0.06" bills at its right-hand
 * end; and an explicit 免费 ending lands on the clamp floor.
 */
export function laneMultiplier(modelName) {
  const name = String(modelName ?? '')
  const tail = name.lastIndexOf('·') === -1 ? '' : name.slice(name.lastIndexOf('·') + 1)
  if (tail === '') return 1
  const numbers = [...tail.matchAll(/x(\d+(?:\.\d+)?)/gi)].map(match => Number(match[1]))
    .filter(value => Number.isFinite(value))
  if (numbers.length > 0) {
    const value = numbers[numbers.length - 1]
    return Math.min(5, Math.max(0.05, value))
  }
  if (/免费|free/i.test(tail)) return 0.05
  return 1
}

/** Whether the display name advertises this route as free (panel flag). */
export function laneIsFree(modelName) {
  const name = String(modelName ?? '')
  const tail = name.lastIndexOf('·') === -1 ? '' : name.slice(name.lastIndexOf('·') + 1)
  if (tail === '') return false
  const numbers = [...tail.matchAll(/x(\d+(?:\.\d+)?)/gi)].map(match => Number(match[1]))
    .filter(value => Number.isFinite(value))
  if (numbers.length > 0) return numbers[numbers.length - 1] === 0
  return /免费|free/i.test(tail)
}

/**
 * Enumerate every routable model, enriched with the metadata routing needs.
 *
 * Two sources, because they answer different questions: the registry's
 * `listModels()` is exactly what the composer's model picker offers (so the
 * orchestrator can never route to something the user cannot see), while
 * `resolveModelInfo` per model adds the capability fields the picker omits —
 * modalities, context window, reasoning efforts.
 *
 * @param {object} ctx - host context carrying `llm`.
 * @param {object} [options]
 * @param {number} [options.concurrency]
 * @param {number} [options.timeoutMs]
 * @param {Map<string, {at: number, info: object|null}>} [options.cache]
 * @param {number} [options.cacheTtlMs]
 * @param {number} [options.negativeTtlMs]
 * @param {() => number} [options.clock]
 * @returns {Promise<{rows: object[], providers: object[], failures: object[], at: number}>}
 */
export async function enumerateCatalog(ctx, options = {}) {
  const llm = ctx.llm
  const concurrency = options.concurrency ?? 6
  const timeoutMs = options.timeoutMs ?? 15_000
  const clock = options.clock ?? (() => Date.now())
  const cache = options.cache
  const cacheTtlMs = options.cacheTtlMs ?? 6 * 60 * 60_000
  const negativeTtlMs = options.negativeTtlMs ?? 10 * 60_000
  const now = clock()

  let providers = []
  try {
    providers = llm.listProviders().map(provider => ({ id: provider.id, name: provider.name }))
  } catch (error) {
    return { rows: [], providers: [], failures: [{ id: '', name: '', message: error instanceof Error ? error.message : String(error) }], at: now }
  }

  const failures = []
  const groups = await Promise.all(providers.map(async provider => {
    try {
      const models = await withDeadline(llm.listModels(provider.id), timeoutMs, `listModels(${provider.id})`)
      return { provider, models: Array.isArray(models) ? models : [] }
    } catch (error) {
      failures.push({ id: provider.id, name: provider.name, message: error instanceof Error ? error.message : String(error) })
      return { provider, models: [] }
    }
  }))

  const flat = []
  for (const { provider, models } of groups) {
    for (const model of models) flat.push({ provider, model })
  }

  const enriched = await pooled(flat, concurrency, async ({ provider, model }) => {
    const key = `${provider.id}\u0000${model.id}`
    const cached = cache?.get(key)
    const fresh = cached !== undefined && now - cached.at < (cached.info === null ? negativeTtlMs : cacheTtlMs)
    let info = fresh ? cached.info : undefined
    if (!fresh) {
      try {
        info = await withDeadline(
          llm.resolveModelInfo(provider.id, model.id, typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(timeoutMs)
            : undefined),
          timeoutMs,
          `resolveModelInfo(${provider.id}/${model.id})`,
        )
      } catch {
        info = null
      }
      cache?.set(key, { at: now, info: info ?? null })
    }
    return {
      provider: provider.id,
      providerName: provider.name,
      model: model.id,
      modelName: model.name ?? model.id,
      description: model.description ?? info?.description ?? '',
      modalities: [...(info?.inputModalities ?? model.inputModalities ?? ['text'])],
      contextWindow: info?.context?.contextWindow ?? null,
      defaultMaxTokens: info?.defaultMaxTokens ?? null,
      reasoning: info?.reasoning ?? null,
      systemPromptUpdate: info?.systemPromptUpdate ?? null,
      toolUpdate: info?.toolUpdate ?? null,
    }
  })

  return { rows: enriched, providers, failures, at: now }
}

/**
 * Create the live catalog, with derived priority fields.
 *
 * @param {{ctx: object, dataset: object, channelData?: object, getConfig: () => object, concurrency?: number, clock?: () => number}} options
 */
export function createCatalog(options) {
  const { ctx, dataset, channelData } = options
  // Read the config through a getter: settings change at runtime and the catalog
  // must decorate the next refresh with the new deny/allow lists.
  const readConfig = typeof options.getConfig === 'function' ? options.getConfig : () => options.config ?? {}
  const clock = options.clock ?? (() => Date.now())
  const listeners = new Set()
  const metaCache = new Map()
  let current = emptyCatalog()
  let refreshing = null
  /** provider id -> report lane name, rebuilt per refresh. */
  let laneNames = new Map()

  function emptyCatalog() {
    return {
      rows: [], providers: [], failures: [], at: 0, error: '', byProvider: new Map(), byKey: new Map(), lastGoodAt: 0,
    }
  }

  /**
   * The report lane a provider route carries, or null.
   *
   * The report names lanes ("TRAE 字节"); the registry names provider routes
   * ("trae"). `LANE_HINTS` (overridable per import) is the bridge, and it is what
   * lets a row use the latency that lane actually measured instead of the
   * family's best-case number from some other lane.
   */
  function laneNameFor(provider) {
    const key = String(provider ?? '').toLowerCase()
    const cached = laneNames.get(key)
    if (cached !== undefined) return cached
    const hints = dataset.current.laneHints ?? {}
    for (const [laneName, hint] of Object.entries(hints)) {
      if (!Array.isArray(hint?.providers)) continue
      if (hint.providers.some(id => String(id).toLowerCase() === key)) {
        laneNames.set(key, laneName)
        return laneName
      }
    }
    laneNames.set(key, null)
    return null
  }

  /** Latency floor for a structurally slow lane. */
  function lanePenaltyMs(provider) {
    const hints = dataset.current.laneHints ?? {}
    for (const hint of Object.values(hints)) {
      if (!Array.isArray(hint?.providers)) continue
      if (hint.penalty === undefined) continue
      if (hint.providers.some(id => String(id).toLowerCase() === provider.toLowerCase())) return hint.penalty
    }
    return 0
  }

  function matches(row, entry) {
    const text = String(entry ?? '').trim().toLowerCase()
    if (text === '') return false
    if (text.includes('/')) return `${row.provider}/${row.model}`.toLowerCase() === text
    return row.model.toLowerCase() === text || foldKey(row.model) === foldKey(text)
  }

  /**
   * How much of the report's (maximum-effort) score a lane can actually deliver.
   *
   * The report measures every family at the benchmark's max reasoning tier, but
   * a lane that only exposes \`high\` cannot reach that score. The curve is
   * deliberately mild and only applies when the adapter actually advertises
   * reasoning efforts: an adapter that reports none is treated as "unknown", not
   * as "cannot reason", because penalising missing metadata would favour the
   * lanes that happen to describe themselves best.
   */
  function effortFactor(reasoning) {
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
    if (efforts.length === 0) return 1
    let best = 0
    for (const effort of efforts) {
      const rank = EFFORT_RANK[effort?.id] ?? 0
      if (rank > best) best = rank
    }
    const maxRank = EFFORT_RANK.max
    if (best >= maxRank) return 1
    return 0.75 + 0.25 * (best / maxRank)
  }

  /** Shrink a report score toward neutral by how confident the identification is. */
  function qualityOf(intel, intelConfidence, estimatedIntel, familyConfidence) {
    const confidence = Math.min(1, Math.max(0, intelConfidence * familyConfidence))
    const raw = intel !== null && Number.isFinite(intel)
      ? intel / MAX_INTEL
      : estimatedIntel !== null && Number.isFinite(estimatedIntel)
        ? estimatedIntel / MAX_INTEL
        : NEUTRAL_INTEL_SCORE
    const value = NEUTRAL_INTEL_SCORE + (raw - NEUTRAL_INTEL_SCORE) * confidence
    return Math.min(1, Math.max(0, value))
  }

  /** Attach family, report score and routing verdicts to one raw row. */
  function decorate(row) {
    const config = readConfig()
    const resolution = familyResolutionFor(dataset, row.model)
    const family = resolution.key
    const info = familyInfo(dataset, family)
    const familyConfidence = resolution.confidence
    const laneName = laneNameFor(row.provider)
    const reportLaneMs = reportLaneTtft(dataset, laneName, row.model)

    const reportDenied = deniedReason(dataset, row.model)
    const providerDenied = (config.denyProviders ?? []).some(entry => String(entry).toLowerCase() === row.provider.toLowerCase())
    const extraDeny = (config.deny ?? []).find(entry => matches(row, entry))
    const allow = (config.allow ?? []).some(entry => matches(row, entry))
    const channel = channelData?.signal(row.provider, row.model) ?? null

    let deniedReasonText = null
    if (providerDenied) deniedReasonText = '该车道已被用户排除'
    else if (!allow && reportDenied !== null) deniedReasonText = reportDenied
    else if (!allow && extraDeny !== undefined) deniedReasonText = `用户屏蔽：${extraDeny}`
    else if (channel?.disabled === true) deniedReasonText = '该模型在渠道面板中被关闭'

    const tags = info.tags
    const multiplier = laneMultiplier(row.modelName)
    const freeLane = laneIsFree(row.modelName)
    const burn = costFactor(tags) * multiplier * (freeLane ? 0.6 : 1)

    return {
      ...row,
      key: foldKey(family ?? row.model),
      family,
      familyConfidence,
      familySource: resolution.source,
      intel: info.intel,
      intelConfidence: info.intelConfidence,
      estimatedIntel: info.estimatedIntel,
      quality: Math.min(1, qualityOf(info.intel, info.intelConfidence, info.estimatedIntel, familyConfidence) * effortFactor(row.reasoning)),
      reportTtftMs: reportLaneMs,
      reportLane: laneName,
      reportScore: info.score ?? null,
      lanePenaltyMs: lanePenaltyMs(row.provider),
      tags,
      known: info.known,
      denied: deniedReasonText !== null,
      deniedReason: deniedReasonText,
      vision: Array.isArray(row.modalities) && row.modalities.includes('image'),
      multiplier,
      freeLane,
      burn,
      channel,
    }
  }

  /**
   * Mark rows that must not win a ranking slot even though the lane advertises
   * them.
   *
   * Two distinct causes, one verdict:
   *
   * 1. **Batch endpoints.** A `:batch` id is an asynchronous submission queue,
   *    not a model a step can wait on.
   * 2. **Duplicate routes.** TRAE advertises `DeepSeek-V4-Flash` and
   *    `DeepSeek-V4-Flash-Official` with a byte-identical display name, and
   *    Cline serves some ids twice under different tiers. Both variants hit the
   *    same upstream, so ranking them separately spends two slots on one route.
   *
   * The row is denied rather than dropped: `byKey` must keep resolving so an
   * existing session parked on one of these routes still finds its row.
   */
  function markUnroutable(rows) {
    const seen = new Map()
    const marked = []
    for (const row of rows) {
      const base = String(row.model)
      if (NON_INTERACTIVE_SUFFIX.test(base)) {
        marked.push({ ...row, denied: true, deniedReason: '批处理端点，不能用于交互式请求' })
        continue
      }
      const key = `${row.provider}\u0000${row.family ?? base}\u0000${String(row.modelName ?? base).trim().toLowerCase()}`
      const first = seen.get(key)
      if (first === undefined) {
        seen.set(key, row)
        marked.push(row)
        continue
      }
      marked.push({ ...row, denied: true, deniedReason: `与 ${first.model} 是同一路由的重复 id` })
    }
    return marked
  }

  /** Rebuild the catalog; concurrent callers share one pass. */
  function refresh(reason = 'manual') {
    if (refreshing !== null) return refreshing
    refreshing = (async () => {
      try {
        laneNames = new Map()
        const config = readConfig()
        const raw = await enumerateCatalog(ctx, {
          concurrency: options.concurrency ?? 6,
          timeoutMs: config.catalogTimeoutMs ?? 15_000,
          cache: metaCache,
          cacheTtlMs: config.modelInfoTtlMs ?? 6 * 60 * 60_000,
          clock,
        })
        const rows = markUnroutable(raw.rows.map(decorate))
        const byProvider = new Map()
        const byKey = new Map()
        for (const row of rows) {
          if (!byProvider.has(row.provider)) byProvider.set(row.provider, [])
          byProvider.get(row.provider).push(row)
          byKey.set(`${row.provider}\u0000${row.model}`, row)
        }
        current = { ...raw, rows, byProvider, byKey, error: '', lastGoodAt: clock() }
      } catch (error) {
        // A failed refresh must not look like "no lanes exist": keep the previous
        // rows and publish the reason, because an empty catalog silently turns
        // the orchestrator into a no-op.
        current = {
          ...current,
          at: clock(),
          error: error instanceof Error ? error.message : String(error),
        }
      }
      for (const listener of listeners) {
        try {
          listener(current, reason)
        } catch {
          /* one bad listener must not stop the others */
        }
      }
      return current
    })().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  return {
    refresh,
    get current() {
      return current
    },
    /** Look up one exact route. */
    row(provider, model) {
      return current.byKey.get(`${provider}\u0000${model}`)
    },
    /** Provider ids the registry currently advertises. */
    get providerIds() {
      return current.providers.map(provider => provider.id)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get metaCacheSize() {
      return metaCache.size
    },
  }
}

export default createCatalog
