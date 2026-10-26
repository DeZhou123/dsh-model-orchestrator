/**
 * In-flight accounting: how many model calls are open on a route right now.
 *
 * ## Why this exists
 *
 * The router scores lanes from *history* — strikes, latency, today's tokens.
 * History cannot tell two concurrent sessions apart from one session asking
 * twice, so with N sessions open at once every one of them ranks the same lane
 * first and they all pile onto it. A free channel's allowance is per key (and
 * often per IP), so that pile does not go faster: it splits one quota N ways and
 * then earns a 429 storm, whose cooldown is channel-scoped and therefore hits
 * every session at once.
 *
 * This module is the missing input: a live count of open calls per
 * `provider\0model` and per provider. The router charges a bounded penalty for
 * it, so concurrent sessions spread across independent quotas instead of
 * stacking on the single best-looking one.
 *
 * ## Properties that matter
 *
 * 1. **Leases, not counters.** `begin` returns a lease; `end` is idempotent, so
 *    a stream that ends twice (a `finally` plus a thrown error) cannot drive the
 *    count negative.
 * 2. **Self-healing.** A stream that never ends (crashed consumer, killed turn)
 *    would otherwise penalize the lane forever. Entries older than `staleMs`
 *    stop counting, and the sweep happens on read — no timer to leak.
 * 3. **Cheap.** One Map lookup on the routing hot path; no allocation per call
 *    beyond the lease object.
 *
 * @module src/inflight
 */


/**
 * Create the in-flight registry.
 *
 * @param {{
 *   clock?: () => number,
 *   staleMs?: number,
 * }} [options]
 */
export function createInflight(options = {}) {
  const clock = options.clock ?? (() => Date.now())
  const staleMs = Math.max(1000, Number(options.staleMs ?? 15 * 60_000))

  /**
   * Live leases only. A lease is kept here until `end`, and read through
   * `#sweep` so a stale one silently stops counting.
   *
   * @type {Set<{route: string, lane: string, at: number, done: boolean}>}
   */
  const live = new Set()

  /** Drop leases that outlived any plausible request. */
  function sweep(now = clock()) {
    for (const lease of live) {
      if (lease.done === true) {
        live.delete(lease)
        continue
      }
      if (now - lease.at > staleMs) live.delete(lease)
    }
  }

  /** Route key used by every lookup; a NUL keeps ids with '\0' unrepresentable. */
  function routeKey(provider, model) {
    return `${String(provider ?? '')}\u0000${String(model ?? '')}`
  }

  /**
   * Open one lease for a call that is about to leave the process.
   *
   * @param {string} provider - provider route.
   * @param {string} model - exact model id.
   * @returns {{release: () => void}} the lease; `release` is idempotent.
   */
  function begin(provider, model) {
    const now = clock()
    sweep(now)
    const lease = { route: routeKey(provider, model), lane: String(provider ?? ''), at: now, done: false }
    live.add(lease)
    return {
      release() {
        if (lease.done === true) return
        lease.done = true
        live.delete(lease)
      },
    }
  }

  /** Open calls on one exact route. */
  function of(provider, model) {
    const key = routeKey(provider, model)
    return countWhere(lease => lease.route === key)
  }

  /** Open calls on every route of one provider (its quota is shared). */
  function lane(provider) {
    const key = String(provider ?? '')
    return countWhere(lease => lease.lane === key)
  }

  function countWhere(predicate) {
    sweep()
    let total = 0
    for (const lease of live) {
      if (predicate(lease)) total += 1
    }
    return total
  }

  /**
   * Fold the two readings the router needs, in one sweep.
   *
   * @param {string} provider
   * @param {string} model
   * @returns {{route: number, lane: number}}
   */
  function pressure(provider, model) {
    const key = routeKey(provider, model)
    const laneKey = String(provider ?? '')
    sweep()
    let route = 0
    let lane = 0
    for (const lease of live) {
      if (lease.route === key) route += 1
      if (lease.lane === laneKey) lane += 1
    }
    return { route, lane }
  }

  /** Full view, for the panel and the tool output. */
  function snapshot() {
    sweep()
    /** @type {Map<string, number>} */
    const routes = new Map()
    /** @type {Map<string, number>} */
    const lanes = new Map()
    for (const lease of live) {
      routes.set(lease.route, (routes.get(lease.route) ?? 0) + 1)
      lanes.set(lease.lane, (lanes.get(lease.lane) ?? 0) + 1)
    }
    return {
      total: live.size,
      routes: [...routes.entries()].map(([key, count]) => {
        const [provider, model] = key.split('\u0000')
        return { provider, model, count }
      }),
      lanes: [...lanes.entries()].map(([provider, count]) => ({ provider, count })),
    }
  }

  /** Total open calls across every lane. */
  function total() {
    sweep()
    return live.size
  }

  /** Drop every lease (tests, and a profile that disables routing). */
  function reset() {
    live.clear()
  }

  return { begin, of, lane, pressure, snapshot, total, reset, routeKey, staleMs }
}

export default createInflight
