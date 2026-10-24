/**
 * Per-lane health and quota ledger.
 *
 * A lane is one `provider` route (a channel account, or the anonymous free
 * lane). Quota belongs to the lane, never to the model family — the whole point
 * of the report's "渠道多 ≠ 模型多" finding is that `glm-5.3` on six lanes is one
 * intelligence score behind six independent quotas.
 *
 * Everything here is derived from real traffic: the failure codes the adapters
 * report and the usage the streams carry. Nothing is probed speculatively, so
 * the ledger cannot invent a quota that does not exist.
 *
 * @module src/health
 */

import path from 'node:path'
import fs from 'node:fs'
import { COOLDOWN, REQUEST_REPEAT, STRIKE_HALF_LIFE_MS, TOKEN_WINDOWS } from './policy-defaults.js'
import { writeJsonAtomic } from './dataset.js'

/** Failure kinds the router reasons about. */
export const KIND = {
  OK: 'ok',
  RATE: 'rate',
  QUOTA: 'quota',
  REGION: 'region',
  AUTH: 'auth',
  /**
   * The channel's own safety review refused the call.
   *
   * LOCAL PATCH 2026-10-18: CodeBuddy/WorkBuddy (腾讯) answers a blocked call
   * with HTTP 400 and `请求被拦截，请重新发送 request illegal` (code 11140) — no
   * standard code at all. That used to be filed as KIND.REQUEST, i.e. "our
   * request is wrong, the lane is innocent", so the ledger recorded nothing,
   * nothing failed over, and the turn simply died. That refusal is account- and
   * model-scoped (the pack parks just that account/model for 30 min), so the
   * verdict cools this model on this channel and leaves siblings alone.
   */
  SAFETY: 'safety',
  UNAVAILABLE: 'unavailable',
  CONTEXT: 'context',
  TRANSIENT: 'transient',
  SLOW: 'slow',
  /** Our request was wrong — the lane is innocent and must not be cooled down. */
  REQUEST: 'request',
}

/** Failure kinds that mean "this lane cannot serve anything right now". */
const LANE_WIDE = new Set([KIND.QUOTA, KIND.REGION, KIND.AUTH, KIND.UNAVAILABLE])
// KIND.SAFETY is deliberately absent: a content refusal applies to the model on
// that channel, while the channel's other models keep serving — the pack's own
// policy-block bookkeeping is per account+model for the same reason.

/** Codes that describe our own request, not the lane's health. */
const REQUEST_CODES = new Set([
  'INVALID_REQUEST',
  'UNSUPPORTED_REASONING_EFFORT',
  'IMAGE_OFFLOAD_REQUIRED',
  'INVALID_ARGS',
  'INVALID_PREPARED_CALL',
  // A user pressing stop is not a lane fault; cooling the lane down for it would
  // make the next request avoid a perfectly healthy model.
  'ABORTED',
])

/**
 * Request-shape refusals that arrive as a bare 400 with a business code.
 *
 * LOCAL PATCH 2026-10-24: WorkBuddy answers `{"code":11128,"msg":"first message
 * is not system prompt"}` when the conversation does not open with a system
 * message. That is our own message order, not the lane's health — but with no
 * matching code it fell through to the transient default, so the lane collected
 * a strike and cooled for 30 s on every occurrence.
 */
const REQUEST_SHAPE_TEXT = /first message is not system prompt|"code"\s*:\s*11128\b/i

/** Codes the channel pack and the harness both use for an exhausted allowance. */
const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'QUOTA_EXCEEDED'])
/** Codes for "this lane is switched off or locked", not a transient fault. */
const LANE_DOWN_CODES = new Set(['LANE_LOCKED', 'CONFIG_DISABLED', 'NO_ADAPTER'])
/** Codes that mean this exact model is not served by this lane. */
const MODEL_DOWN_CODES = new Set(['MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE', 'INVALID_MODEL', 'MODEL_RETIRED'])
const AUTH_CODES = new Set(['AUTH', 'MISSING_CREDENTIAL', 'PERMISSION_DENIED', 'INVALID_CREDENTIAL', 'AUTHORIZATION_REQUIRED'])

const QUOTA_TEXT = /quota|insufficient|balance|credit|billing|payment|arrears|额度|余额/i
const RATE_TEXT = /rate limit|too many requests|限流|频率/i
/**
 * LOCAL PATCH 2026-10-16: quota-coded failures that are really short per-model
 * rate limits. The channel pack reports "所有账号均受限，请稍后再试" with a
 * QUOTA_EXCEEDED code, but live-probing proved the lane recovers in minutes —
 * parking it until midnight as a lane-wide quota strands the cheapest routes
 * (buddy carries the x0.11 V4.1 Flash).
 */
const QUOTA_BUT_RATE_TEXT = /请稍后再试|稍后再试|稍候再试|均受限|受限，请|频率受限|限流|rate.?limit|too many requests|try again later/i
/**
 * LOCAL PATCH 2026-10-16: quota failures the channel itself says are per-model.
 * zcode's "额度已用尽…改用其它模型" names one model and tells you to use another,
 * so cooling the whole lane wrongly disables working siblings (GLM-5.3-Flash was
 * live-probed healthy while GLM-5.3 was cooled).
 *
 * LOCAL PATCH 2026-10-24 (enumerated advice): those rules assume the advice is
 * written as one contiguous phrase. buddy / workbuddy word it with a list —
 * 「换用其它账号、其它模型或其它通道」— so the "其它" and "模型" are separated by
 * 「账号、」 and all four alternatives miss. The mistake is expensive: one
 * WorkBuddy `-sg` variant answering 14018 got filed as a LANE_WIDE quota fault and
 * parked the same provider's x0.00 free lane (`deepseek-v4.1-flash`, live-probed
 * healthy) for the full 24h cap. Allow a short enumeration between the pronoun
 * and the noun, while still requiring that the sentence names a model at all.
 */
const QUOTA_PER_MODEL_TEXT =
  /(?:改|换|使|试)用其[它他][^。；;，,\n]{0,16}?模型|试试其[它他]模型/
/**
 * Codes an adapter set deliberately. When one of these is present the prose
 * around it is context, not evidence — see the gating in {@link classifyFailure}.
 *
 * LOCAL PATCH 2026-10-24 (explicit code outranks prose): the fuzzy text rules
 * below are fallbacks for adapters that report nothing structured, but they ran
 * *first*. Probed consequences: a 502 whose body mentioned a regional endpoint
 * became a 24h lane-wide REGION block; a 500 mentioning a "credit ledger" became
 * a lane-wide QUOTA; a TIMEOUT mentioning "region" parked the lane for a day.
 * Each of those cools every sibling model on a healthy channel.
 */
const AUTHORITATIVE_CODES = new Set([
  'TIMEOUT',
  'SERVER',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'STREAM_CUT',
  // RATE_LIMIT is deliberately absent: a 429 is the one status that can carry
  // either "slow down" or "the pool is empty", and the quota prose has to be
  // read before the rate branch decides. The rate branch still matches on the
  // code itself (see `code === 'RATE_LIMIT'`), so nothing is lost.
  'REGION_BLOCKED',
  'MODEL_NOT_FOUND',
  'MODEL_UNAVAILABLE',
  'INVALID_MODEL',
  'MODEL_RETIRED',
  'NO_ADAPTER',
  'LANE_LOCKED',
  'CONFIG_DISABLED',
  'CONTEXT_WINDOW_EXCEEDED',
])

/**
 * A free pool that is spent for the day, worded in English.
 *
 * LOCAL PATCH 2026-10-24: OpenCode answers 429 with
 * `Free usage limit reached. Subscribe to OpenCode Go …`. It carries no business
 * code, and none of the QUOTA_TEXT words appear ("usage limit" is not "quota"),
 * so it fell through every branch to the 30-second transient default — the
 * router kept re-picking a lane that cannot answer until the pool resets.
 */
const DAILY_QUOTA_TEXT =
  /free usage limit|usage limit (?:reached|exceeded|exhausted)|daily (?:quota|limit) (?:reached|exceeded)|subscribe to opencode go|out of (?:free )?(?:credits|quota)/i
/**
 * Narrowed on purpose: a bare `region` / `country` / `地区` appears in ordinary
 * transport and gateway prose ("connect timeout to region endpoint"), and the
 * verdict for a real region block is a full day on the whole lane.
 */
const REGION_TEXT = /not available in your (?:region|country)|region not supported|地区封锁|地区限制|区域限制/i
const AUTH_TEXT = /unauthor|invalid api key|invalid credential|sign in|登录|凭据/i
const CONTEXT_TEXT = /context (window|length)|too many tokens|maximum context|上下文/i
/**
 * A channel's own content/safety review (LOCAL PATCH 2026-10-18).
 *
 * The Buddy family (CodeBuddy / WorkBuddy, 腾讯) answers a blocked call with
 * HTTP 400 and no standard code: the localized display message says
 * `请求被拦截，请重新发送` and the payload carries `request illegal` (code 11140).
 * The channel pack recognises the same spellings in its own `isContentRejection`;
 * matching them here keeps the verdict lane-scoped even when the pack reports a
 * bare INVALID_REQUEST.
 */
const SAFETY_BLOCK_TEXT = /request illegal|安全审核|安全策略拦截|safety review|"code"\s*:\s*11140|请求被拦截/i
const TIMEOUT_TEXT = /timeout|timed out|超时|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i
const SERVER_TEXT = /\b5\d\d\b|internal server|bad gateway|unavailable/i
const EMPTY_TEXT = /empty response|no content/i

/** Local midnight after `at`, plus a small margin so a reset is never raced. */
function nextLocalMidnight(at) {
  const date = new Date(at)
  date.setHours(24, 5, 0, 0)
  return date.getTime()
}

/**
 * Turn one `LlmFailure` into a ledger verdict.
 *
 * The classification is deliberately code-first: the harness publishes
 * `QUOTA` / `ACCOUNT_QUOTA` / `RATE_LIMIT` / `REGION_BLOCKED` and the
 * our-free-model adapter republishes the same vocabulary, so message sniffing is
 * only the fallback for adapters that report nothing structured.
 *
 * @param {{code?: string, status?: number, message?: string, providerRetryAfterMs?: number}} failure
 * @param {{strikes?: number, now?: number}} [context]
 * @returns {{kind: string, cooldownMs: number, scope: 'model'|'lane', reason: string, retryable: boolean}}
 */
export function classifyFailure(failure, context = {}) {
  const now = context.now ?? Date.now()
  const strikes = Math.max(0, context.strikes ?? 0)
  const code = String(failure?.code ?? '').toUpperCase()
  const status = Number(failure?.status ?? 0)
  const message = String(failure?.message ?? '')
  const retryAfter = Number(failure?.providerRetryAfterMs ?? 0)
  const detail = message === '' ? code : `${code} ${message}`

  // An adapter that names the failure kind has already done the classification.
  // The prose rules below exist for adapters that report nothing structured, so
  // when a code is present they must not overrule it — otherwise a 502 whose
  // body happens to mention a regional endpoint is filed as a 24h REGION block.
  const authoritative = AUTHORITATIVE_CODES.has(code)
  /** Text fallback: only consulted when the adapter gave no verdict of its own. */
  const byText = (pattern) => !authoritative && pattern.test(detail)

  if (code === 'CONTEXT_WINDOW_EXCEEDED' || (status === 0 && CONTEXT_TEXT.test(message))) {
    // Not a lane problem: this model is simply too small for this request. Keep
    // the lane healthy so a long-context sibling on the same lane can serve it.
    return { kind: KIND.CONTEXT, cooldownMs: 0, scope: 'model', reason: '上下文窗口不足', retryable: false }
  }

  // Safety review first. It arrives as 400/INVALID_REQUEST, which the block
  // below would file as our own mistake — and a mistake of ours is exactly what
  // the router is forbidden to fail over from.
  if (SAFETY_BLOCK_TEXT.test(detail)) {
    // Model-scoped, matching the channel pack's own bookkeeping: it parks the
    // offending *account for this model* for 30 minutes and keeps serving the
    // lane's other models. Cooling the whole provider here would take working
    // siblings down with it.
    return {
      kind: KIND.SAFETY,
      cooldownMs: COOLDOWN.auth,
      scope: 'model',
      reason: '渠道安全审核拦截：' + (message === '' ? code : message.slice(0, 160)),
      retryable: false,
    }
  }

  if (REQUEST_CODES.has(code) || REQUEST_SHAPE_TEXT.test(detail)) {
    // A rejected request is ours to fix. Cooling the lane down for it would
    // punish a healthy channel for our own mistake.
    return { kind: KIND.REQUEST, cooldownMs: 0, scope: 'model', reason: message.slice(0, 200) || code, retryable: false }
  }

  if (QUOTA_CODES.has(code) || status === 402 || byText(QUOTA_TEXT) || (!authoritative && DAILY_QUOTA_TEXT.test(detail))) {
    // LOCAL PATCH 2026-10-16 (quota-coded rate limits): the channel pack reports
    // short per-model rate limits with a QUOTA code and "请稍后再试" wording.
    // Live-probing proved the lane recovers in minutes, so this must be a
    // model-scoped rate backoff, not a lane-wide park until midnight.
    if (QUOTA_BUT_RATE_TEXT.test(detail)) {
      const reported = retryAfter > 0 ? Math.min(retryAfter, COOLDOWN.rateMax) : 0
      const backoff = reported > 0 ? reported : Math.min(COOLDOWN.rate * 2 ** strikes, COOLDOWN.rateMax)
      return {
        kind: KIND.RATE,
        cooldownMs: Math.max(1000, backoff),
        scope: 'model',
        reason: message === '' ? '速率限制' : message.slice(0, 200),
        retryable: true,
      }
    }
    const untilMidnight = COOLDOWN.quotaDayRollover ? nextLocalMidnight(now) - now : COOLDOWN.quotaFallback
    // LOCAL PATCH 2026-10-16 (per-model quota): when the channel itself says the
    // allowance is per-model ("改用其它模型"), only that model cools — the lane's
    // other models stay routable. Verified live: zcode's GLM-5.3-Flash answered
    // fine while GLM-5.3 was quota-cooled.
    const perModel = QUOTA_PER_MODEL_TEXT.test(detail)
    return {
      kind: KIND.QUOTA,
      cooldownMs: Math.max(60_000, Math.min(untilMidnight, 24 * 60 * 60_000)),
      scope: perModel ? 'model' : 'lane',
      reason: message === '' ? '额度/余额耗尽' : message.slice(0, 200),
      retryable: false,
    }
  }

  if (code === 'RATE_LIMIT' || status === 429 || RATE_TEXT.test(detail)) {
    // The free lane's 429 carries a *growing* Retry-After, so the provider value
    // is honoured but clamped: an hour-long park would strand the model when a
    // sibling lane could have served the step.
    const reported = retryAfter > 0 ? Math.min(retryAfter, COOLDOWN.rateMax) : 0
    const backoff = reported > 0 ? reported : Math.min(COOLDOWN.rate * 2 ** strikes, COOLDOWN.rateMax)
    return {
      kind: KIND.RATE,
      cooldownMs: Math.max(1000, backoff),
      scope: 'model',
      reason: message === '' ? '速率限制' : message.slice(0, 200),
      retryable: true,
    }
  }

  if (code === 'REGION_BLOCKED' || byText(REGION_TEXT)) {
    return { kind: KIND.REGION, cooldownMs: COOLDOWN.region, scope: 'lane', reason: '地区封锁', retryable: false }
  }

  if (AUTH_CODES.has(code) || status === 401 || status === 403 || byText(AUTH_TEXT)) {
    return {
      kind: KIND.AUTH,
      cooldownMs: COOLDOWN.auth,
      scope: 'lane',
      reason: message === '' ? '凭据/授权问题' : message.slice(0, 200),
      retryable: false,
    }
  }

  if (LANE_DOWN_CODES.has(code) || MODEL_DOWN_CODES.has(code) || status === 404) {
    return {
      kind: KIND.UNAVAILABLE,
      cooldownMs: COOLDOWN.unavailable,
      scope: code === 'NO_ADAPTER' || code === 'LANE_LOCKED' || code === 'CONFIG_DISABLED' ? 'lane' : 'model',
      reason: message === '' ? (code === 'NO_ADAPTER' ? '该车道没有注册适配器' : '模型不可路由') : message.slice(0, 200),
      retryable: false,
    }
  }

  if (code === 'EMPTY_RESPONSE' || code === 'STREAM_CUT' || byText(EMPTY_TEXT)) {
    return { kind: KIND.TRANSIENT, cooldownMs: COOLDOWN.transient, scope: 'model', reason: '上游流中断/空响应', retryable: true }
  }

  if (code === 'TIMEOUT' || byText(TIMEOUT_TEXT)) {
    // Repeated timeouts are a latency verdict, not a transient one.
    const kind = strikes >= 1 ? KIND.SLOW : KIND.TRANSIENT
    return {
      kind,
      cooldownMs: Math.min(COOLDOWN.transient * 2 ** strikes, COOLDOWN.rateMax),
      scope: 'model',
      reason: message === '' ? '请求超时' : message.slice(0, 200),
      retryable: true,
    }
  }

  if (code === 'SERVER' || code === 'TRANSPORT' || byText(SERVER_TEXT)) {
    return {
      kind: KIND.TRANSIENT,
      cooldownMs: Math.min(COOLDOWN.transient * 2 ** strikes, COOLDOWN.rateMax),
      scope: 'model',
      reason: message === '' ? '上游故障' : message.slice(0, 200),
      retryable: true,
    }
  }

  return {
    kind: KIND.TRANSIENT,
    cooldownMs: COOLDOWN.transient,
    scope: 'model',
    reason: message === '' ? String(failure?.code ?? '未知失败') : message.slice(0, 200),
    retryable: true,
  }
}

/** Empty per-lane counters. */
function emptyCounters() {
  return { calls: 0, errors: 0, inTok: 0, outTok: 0, ttftSum: 0, ttftN: 0, ttftEwma: 0, tpsSum: 0, tpsN: 0 }
}

/**
 * Weight of one new sample in the latency EWMA.
 *
 * A lifetime mean would let one slow burst penalize a lane forever — the exact
 * opposite of what a router needs, because a lane that recovered must be able to
 * win again. 0.3 forgets a bad patch over roughly ten calls.
 */
const TTFT_EWMA_ALPHA = 0.3

/**
 * Decay one record's strike count to `now`.
 *
 * A strike used to be permanent until that exact route succeeded again, and a
 * route that keeps losing the ranking never gets the chance — so one bad minute
 * became a life sentence (the report's highest-intelligence family sat at rank
 * 10 on four strikes recorded a day and a half earlier). Exponential decay with
 * a three-hour half-life makes the ledger forget the way a person would: what
 * broke five minutes ago still counts, what broke yesterday barely does.
 *
 * @param {object} record - a model or lane record, mutated in place.
 * @param {number} now - current clock reading.
 * @returns {number} the decayed strike count.
 */
function decayStrikes(record, now) {
  const strikes = Number(record.strikes ?? 0)
  if (!(strikes > 0)) {
    record.strikes = 0
    record.strikesAt = Number(record.strikesAt ?? now)
    return 0
  }
  // A record written by an older build carries no strikesAt; its last activity
  // is the honest stand-in, and when even that is missing the count is left
  // alone rather than silently forgiven.
  const since = Number(record.strikesAt ?? record.lastAt ?? 0)
  if (!(since > 0) || now <= since) return strikes
  const decayed = strikes * 0.5 ** ((now - since) / STRIKE_HALF_LIFE_MS)
  // Anything under a fiftieth of a strike is noise; drop it so a long-lived
  // ledger does not accumulate invisible fractions forever.
  record.strikes = decayed < 0.02 ? 0 : Math.round(decayed * 1000) / 1000
  record.strikesAt = now
  return record.strikes
}

/**
 * Create the ledger.
 *
 * @param {{userDir: string|null, clock?: () => number, persistMs?: number}} options
 */
export function createHealth(options = {}) {
  const clock = options.clock ?? (() => Date.now())
  const file = options.userDir === null || options.userDir === undefined
    ? null
    : path.join(options.userDir, 'health.json')
  const persistMs = options.persistMs ?? 15_000
  /**
   * Live config for the repeated-rejection policy. A function, not a snapshot:
   * the panel can change the threshold at any time and the ledger must obey the
   * value in effect when the next rejection arrives.
   */
  const requestPolicy = typeof options.requestPolicy === 'function' ? options.requestPolicy : () => ({})

  /** @type {Map<string, object>} keyed `provider\u0000model` */
  const models = new Map()
  /** @type {Map<string, object>} keyed `provider` */
  const lanes = new Map()
  /** @type {Map<string, object>} keyed `provider\u0000model` -> hourly buckets */
  const buckets = new Map()
  const decisions = []

  let dirty = false
  let loaded = false

  function laneKey(provider) {
    return String(provider ?? '')
  }
  function modelKey(provider, model) {
    return `${provider}\u0000${model}`
  }

  function laneRecord(provider) {
    const key = laneKey(provider)
    let record = lanes.get(key)
    if (record === undefined) {
      record = { provider: key, status: KIND.OK, until: 0, reason: '', strikes: 0, lastAt: 0, counters: emptyCounters() }
      lanes.set(key, record)
    }
    return record
  }

  function modelRecord(provider, model) {
    const key = modelKey(provider, model)
    let record = models.get(key)
    if (record === undefined) {
      record = {
        provider: String(provider ?? ''),
        model: String(model ?? ''),
        status: KIND.OK,
        until: 0,
        reason: '',
        strikes: 0,
        lastAt: 0,
        lastOkAt: 0,
        // Consecutive request-side rejections (see markFailure / REQUEST_REPEAT).
        rejects: 0,
        rejectsAt: 0,
        counters: emptyCounters(),
      }
      models.set(key, record)
    }
    return record
  }

  /** Hour buckets, pruned to 25 hours so the rolling windows stay cheap. */
  function bucketFor(provider, model) {
    const key = modelKey(provider, model)
    let entry = buckets.get(key)
    if (entry === undefined) {
      entry = { hours: {} }
      buckets.set(key, entry)
    }
    const now = clock()
    const hour = Math.floor(now / 3_600_000)
    const oldest = hour - 24
    for (const key of Object.keys(entry.hours)) {
      if (Number(key) < oldest) delete entry.hours[key]
    }
    let bucket = entry.hours[hour]
    if (bucket === undefined) {
      bucket = { in: 0, out: 0, calls: 0, errors: 0 }
      entry.hours[hour] = bucket
    }
    return bucket
  }

  /** Token spend for one `(provider, model)` over one rolling window. */
  function windowSpend(provider, model, windowMs) {
    const entry = buckets.get(modelKey(provider, model))
    if (entry === undefined) return { in: 0, out: 0, calls: 0, errors: 0 }
    const since = Math.floor((clock() - windowMs) / 3_600_000)
    const total = { in: 0, out: 0, calls: 0, errors: 0 }
    for (const [hour, bucket] of Object.entries(entry.hours)) {
      if (Number(hour) < since) continue
      total.in += bucket.in
      total.out += bucket.out
      total.calls += bucket.calls
      total.errors += bucket.errors
    }
    return total
  }

  /** Sum one lane's token spend across every model it served. */
  function laneSpend(provider, windowMs) {
    const total = { in: 0, out: 0, calls: 0, errors: 0 }
    for (const record of models.values()) {
      if (record.provider !== provider) continue
      const spend = windowSpend(provider, record.model, windowMs)
      total.in += spend.in
      total.out += spend.out
      total.calls += spend.calls
      total.errors += spend.errors
    }
    return total
  }

  /**
   * Resolve one model's current availability, honoring the lane's verdict.
   *
   * The strike count reported here is *decayed to now*, not the raw total: it is
   * read by the router on every step, so it has to mean "how bad is this lane
   * right now". The raw number stays on disk and is rewritten by the next
   * failure or success.
   */
  function stateOf(provider, model) {
    const now = clock()
    const lane = lanes.get(laneKey(provider))
    const laneStrikes = lane === undefined ? 0 : decayStrikes(lane, now)
    if (lane !== undefined && lane.until > now && LANE_WIDE.has(lane.status)) {
      return { status: lane.status, available: false, until: lane.until, reason: lane.reason, scope: 'lane', strikes: laneStrikes }
    }
    const record = models.get(modelKey(provider, model))
    if (record === undefined) {
      return { status: KIND.OK, available: true, until: 0, reason: '', scope: 'model', strikes: 0 }
    }
    const strikes = decayStrikes(record, now)
    if (record.until > now) {
      return { status: record.status, available: false, until: record.until, reason: record.reason, scope: 'model', strikes }
    }
    // Expired cooldown: the lane gets a fresh chance, and the decayed strike
    // count is all that is left of the history — so a lane that failed a week
    // ago competes on equal terms with a lane that never failed.
    return { status: KIND.OK, available: true, until: 0, reason: '', scope: 'model', strikes }
  }

  /** Apply one failure to the ledger and return the verdict. */
  function markFailure(provider, model, failure, meta = {}) {
    const now = clock()
    const lane = laneRecord(provider)
    const record = modelRecord(provider, model)
    const verdict = classifyFailure(failure, { strikes: record.strikes, now })

    // A malformed request, and a prompt that does not fit this model's window,
    // say nothing about the lane's health. Neither may enter the ledger:
    // cooling a healthy model for our own bad arguments — or for a prompt a
    // sibling model on the same lane could have taken — removes the very
    // candidate that can serve the next, correct request. The orchestrator
    // still reroutes on CONTEXT; it just does not blame the model.
    if (verdict.kind === KIND.REQUEST) {
      // A malformed request is our own mistake — once. A channel that refuses
      // what we send over and over is a different signal: the router is told
      // "our request is wrong, the lane is innocent", so it has no verdict to
      // act on, keeps choosing that lane, and every turn routed there dies
      // without a failover (LOCAL PATCH 2026-10-18; see REQUEST_REPEAT).
      const policy = requestPolicy()
      const windowMs = Math.max(60_000, Number(policy.requestRepeatWindowMs) || REQUEST_REPEAT.windowMs)
      const threshold = Math.max(1, Math.round(Number(policy.requestRepeatThreshold) || REQUEST_REPEAT.threshold))
      const repeats = record.rejectsAt > 0 && now - record.rejectsAt <= windowMs
        ? Number(record.rejects ?? 0) + 1
        : 1
      record.rejects = repeats
      record.rejectsAt = now
      record.lastAt = now
      dirty = true
      if (repeats < threshold) {
        return { ...verdict, repeats, lane: String(provider), model: String(model), ...meta }
      }
      // Past the threshold the verdict stops being about the request. Park the
      // model for a bounded while (no strike: this is a refusal pattern, not
      // proof the lane is broken) so the next step, and the next turn, route
      // somewhere else instead of hitting the same wall.
      const blockMs = Math.max(0, Number(policy.requestRepeatBlockMs) || REQUEST_REPEAT.blockMs)
      record.rejects = 0
      record.status = KIND.REQUEST
      record.reason = '连续 ' + repeats + ' 次请求被该渠道拒绝：' + verdict.reason
      record.until = blockMs > 0 ? now + blockMs : 0
      laneRecord(provider).lastAt = now
      return {
        ...verdict,
        repeats,
        blocked: true,
        cooldownMs: blockMs,
        reason: record.reason,
        lane: String(provider),
        model: String(model),
        ...meta,
      }
    }

    if (verdict.kind === KIND.CONTEXT) {
      return { ...verdict, lane: String(provider), model: String(model), ...meta }
    }

    record.strikes += 1
    record.strikesAt = now
    record.lastAt = now
    record.counters.errors += 1
    record.status = verdict.kind
    record.reason = verdict.reason
    record.until = verdict.cooldownMs > 0 ? now + verdict.cooldownMs : 0

    const bucket = bucketFor(provider, model)
    bucket.errors += 1

    if (verdict.scope === 'lane') {
      lane.status = verdict.kind
      lane.reason = verdict.reason
      lane.until = Math.max(lane.until, record.until)
      lane.strikes += 1
      lane.lastAt = now
      // A lane-wide verdict applies to every model the lane advertises.
      for (const sibling of models.values()) {
        if (sibling.provider !== provider) continue
        sibling.status = verdict.kind
        sibling.reason = verdict.reason
        sibling.until = Math.max(sibling.until, record.until)
      }
    } else {
      lane.lastAt = now
    }

    dirty = true
    return { ...verdict, lane: String(provider), model: String(model), ...meta }
  }

  /** Record one successful call: latency, throughput, tokens, and recovery. */
  function markSuccess(provider, model, observation = {}) {
    const now = clock()
    const record = modelRecord(provider, model)
    const lane = laneRecord(provider)

    record.counters.calls += 1
    record.lastAt = now
    record.lastOkAt = now
    record.status = KIND.OK
    record.until = 0
    record.reason = ''
    // A served request also ends a rejection streak: whatever the channel was
    // objecting to, it is not objecting now.
    record.rejects = 0
    record.rejectsAt = 0
    // A success forgives part of the decayed history rather than one whole
    // strike: with a half-life in play, "minus one" is meaningless at 0.3.
    decayStrikes(record, now)
    if (record.strikes > 0) record.strikes = Math.round(Math.max(0, record.strikes * 0.5) * 1000) / 1000
    record.strikesAt = now

    if (Number.isFinite(observation.ttftMs) && observation.ttftMs > 0) {
      record.counters.ttftSum += observation.ttftMs
      record.counters.ttftN += 1
      record.counters.ttftEwma = record.counters.ttftEwma > 0
        ? record.counters.ttftEwma * (1 - TTFT_EWMA_ALPHA) + observation.ttftMs * TTFT_EWMA_ALPHA
        : observation.ttftMs
    }
    if (Number.isFinite(observation.tps) && observation.tps > 0) {
      record.counters.tpsSum += observation.tps
      record.counters.tpsN += 1
    }

    const input = Number(observation.inputTokens ?? 0)
    const output = Number(observation.outputTokens ?? 0)
    record.counters.inTok += Number.isFinite(input) ? input : 0
    record.counters.outTok += Number.isFinite(output) ? output : 0

    const bucket = bucketFor(provider, model)
    bucket.in += Number.isFinite(input) ? input : 0
    bucket.out += Number.isFinite(output) ? output : 0
    bucket.calls += 1

    lane.counters.calls += 1
    lane.lastAt = now
    // A call that just succeeded is proof this lane is serving again. The old
    // condition (`lane.until <= now`) only cleared an *expired* cooldown, so a
    // lane parked until midnight stayed parked even after a successful call —
    // one bad minute really was a life sentence.
    if (LANE_WIDE.has(lane.status)) {
      lane.status = KIND.OK
      lane.until = 0
      lane.reason = ''
      // A lane-wide verdict was copied onto every sibling model; the same proof
      // that lifts the lane lifts them too.
      for (const sibling of models.values()) {
        if (sibling.provider !== provider) continue
        if (!LANE_WIDE.has(sibling.status)) continue
        sibling.status = KIND.OK
        sibling.until = 0
        sibling.reason = ''
      }
    }
    decayStrikes(lane, now)
    if (lane.strikes > 0) lane.strikes = Math.round(Math.max(0, lane.strikes * 0.5) * 1000) / 1000
    lane.strikesAt = now

    dirty = true
    return record
  }

  /** Append one routing decision for the panel. */
  function logDecision(decision, limit = 60) {
    decisions.unshift({ at: clock(), ...decision })
    if (decisions.length > limit) decisions.length = limit
  }

  /**
   * Aggregate observed latency for a model; falls back to the report value.
   *
   * `samples` and `lastOkAt` are what let the router decide whether the EWMA is
   * evidence or folklore: one cold start is not a measurement, and a number from
   * last week is not a measurement either. `ttftMeanMs` is the honest average,
   * kept for the panel because an EWMA can differ sharply from it after a burst.
   */
  function observed(provider, model) {
    const record = models.get(modelKey(provider, model))
    if (record === undefined) return { ttftMs: null, ttftMeanMs: null, tps: null, samples: 0, calls: 0, errors: 0, lastOkAt: 0 }
    const counters = record.counters
    return {
      // The EWMA, not the lifetime mean: a recovered lane must be able to win.
      ttftMs: counters.ttftEwma > 0 ? Math.round(counters.ttftEwma) : null,
      ttftMeanMs: counters.ttftN === 0 ? null : Math.round(counters.ttftSum / counters.ttftN),
      tps: counters.tpsN === 0 ? null : Math.round((counters.tpsSum / counters.tpsN) * 10) / 10,
      samples: Number(counters.ttftN ?? 0),
      calls: counters.calls,
      errors: counters.errors,
      lastOkAt: Number(record.lastOkAt ?? 0),
    }
  }

  /** Full ledger view, for the panel and the tool. */
  function snapshot() {
    const now = clock()
    const modelRows = []
    for (const record of models.values()) {
      const state = stateOf(record.provider, record.model)
      modelRows.push({
        provider: record.provider,
        model: record.model,
        status: state.status,
        available: state.available,
        scope: state.scope,
        reason: state.reason,
        cooldownMs: Math.max(0, state.until - now),
        strikes: state.strikes,
        ...observed(record.provider, record.model),
        windows: Object.fromEntries(TOKEN_WINDOWS.map(window => [window.id, windowSpend(record.provider, record.model, window.ms)])),
      })
    }
    const laneRows = []
    for (const record of lanes.values()) {
      laneRows.push({
        provider: record.provider,
        status: record.status,
        available: !(record.until > now && LANE_WIDE.has(record.status)),
        reason: record.reason,
        cooldownMs: Math.max(0, record.until - now),
        strikes: record.strikes,
        calls: record.counters.calls,
        errors: record.counters.errors,
        windows: Object.fromEntries(TOKEN_WINDOWS.map(window => [window.id, laneSpend(record.provider, window.ms)])),
      })
    }
    return { models: modelRows, lanes: laneRows, decisions: [...decisions] }
  }

  /** Persist the ledger; the caller decides cadence. */
  function persist() {
    if (file === null || !dirty) return false
    try {
      writeJsonAtomic(file, {
        version: 1,
        updatedAt: clock(),
        models: [...models.values()],
        lanes: [...lanes.values()],
        buckets: Object.fromEntries([...buckets.entries()].map(([key, entry]) => [key, entry.hours])),
      })
      dirty = false
      return true
    } catch {
      return false
    }
  }

  /** Load the previous ledger so a restart does not forget a spent quota. */
  function load() {
    if (file === null || loaded) return false
    loaded = true
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return false
    }
    if (raw?.version !== 1) return false
    const now = clock()

    /**
     * LOCAL PATCH 2026-10-16 (load-time self-heal): records persisted under the
     * old classifier can carry verdicts the current one would never issue — a
     * quota-coded *rate limit* that parked a whole lane until midnight (buddy's
     * "所有账号均受限，请稍后再试", live-probed working again within the hour),
     * or a *per-model* quota that cooled every sibling on the lane (zcode's
     * GLM-5.3 allowance, while GLM-5.3-Flash stayed live). Re-judge every
     * still-cooling quota record with the current classifier and repair it, so
     * the first restart after the fix does not resurrect the wrongful parks
     * from disk:
     *  - verdict is now RATE: the legitimate backoff was minutes at most, so a
     *    hours-old midnight park is stale by definition — lift it;
     *  - verdict is now model-scoped: a lane record may not hold it, and among
     *    the model records only the one named in the reason keeps its cooldown.
     */
    const NAMED_MODEL = /模型\s*["“]([^"”]+)["”]|on model "([^"]+)"/i
    function heal(record, isLane) {
      if (record.status !== KIND.QUOTA || !(record.until > now)) return { lift: false, named: null }
      const verdict = classifyFailure({ code: 'QUOTA', message: String(record.reason ?? '') }, { strikes: 0, now })
      if (verdict.kind === KIND.RATE) return { lift: true, named: null }
      if (verdict.scope === 'model') {
        const match = NAMED_MODEL.exec(String(record.reason ?? ''))
        const named = match === null ? null : String(match[1] ?? match[2] ?? '').toLowerCase()
        // A lane never holds a model-scoped verdict; a model record keeps it
        // only when it is the model the failure actually named.
        return { lift: isLane || named === null || String(record.model ?? '').toLowerCase() !== named, named }
      }
      return { lift: false, named: null }
    }

    for (const record of raw.models ?? []) {
      // A cooldown that expired while the process was down is already over.
      if (record.until > 0 && record.until <= now) {
        record.status = KIND.OK
        record.until = 0
        record.reason = ''
      }
      if (heal(record, false).lift) {
        record.status = KIND.OK
        record.until = 0
        record.reason = ''
      }
      // Local patch (2026-10-17): the on-disk strike count is decayed on load as
      // well, so an upgrade inherits an honest history instead of the frozen
      // totals that kept the strongest families out of the top ten.
      if (Number(record.strikesAt ?? 0) === 0) record.strikesAt = Number(record.lastAt ?? 0)
      decayStrikes(record, now)
      models.set(modelKey(record.provider, record.model), { counters: emptyCounters(), ...record })
    }
    for (const record of raw.lanes ?? []) {
      if (record.until > 0 && record.until <= now) {
        record.status = KIND.OK
        record.until = 0
        record.reason = ''
      }
      if (heal(record, true).lift) {
        record.status = KIND.OK
        record.until = 0
        record.reason = ''
      }
      if (Number(record.strikesAt ?? 0) === 0) record.strikesAt = Number(record.lastAt ?? 0)
      decayStrikes(record, now)
      lanes.set(laneKey(record.provider), { counters: emptyCounters(), ...record })
    }
    for (const [key, hours] of Object.entries(raw.buckets ?? {})) buckets.set(key, { hours })
    return true
  }

  /**
   * Drop history for lanes that have been gone for a whole day.
   *
   * A provider missing from one catalog refresh (a transient listModels
   * failure, an adapter reload, a session that has not asked for it yet) must
   * NOT lose its quota memory: surviving an unreachable provider is the entire
   * reason the ledger is on disk. Only a lane that has been absent *and* idle
   * for a day is considered retired.
   *
   * @param {string[]} liveProviders - provider ids the registry advertises.
   * @param {number} [now] - clock reading.
   * @param {number} [maxAgeMs] - how long a retired lane's history is kept.
   */
  function prune(liveProviders, now = clock(), maxAgeMs = 24 * 60 * 60_000) {
    const live = new Set(liveProviders)
    for (const [key, record] of [...models.entries()]) {
      const provider = key.split('\u0000')[0]
      if (!live.has(provider) && now - Number(record.lastAt ?? 0) > maxAgeMs) {
        models.delete(key)
        buckets.delete(key)
      }
    }
    for (const [key, record] of [...lanes.entries()]) {
      if (!live.has(key) && now - Number(record.lastAt ?? 0) > maxAgeMs) lanes.delete(key)
    }
  }

  return {
    KIND,
    classifyFailure,
    stateOf,
    markFailure,
    markSuccess,
    logDecision,
    observed,
    snapshot,
    windowSpend,
    laneSpend,
    persist,
    load,
    prune,
    get dirty() {
      return dirty
    },
    hasFile: file !== null,
    file,
    persistMs,
  }
}

export default createHealth
