/**
 * Candidate scoring and selection.
 *
 * The router has two levels on purpose.
 *
 *   **model group** — one family of weights (\`glm-5.3\` on six channels is one
 *   model with six quotas). Intelligence belongs here; nothing else does.
 *   **lane** — one \`provider/model\` route. Quota, rate limits, measured latency
 *   and cost belong here.
 *
 * Splitting them is what makes "switch the channel, keep the model" possible:
 * when a lane runs out, the same model on another lane is the natural next
 * candidate, and only when the whole group is unusable does the router change
 * model at all. The old single-level scorer re-ranked every row from scratch on
 * each failure, so it could — and did — move to a weaker model while a perfectly
 * good lane of the strong one sat idle.
 *
 * Every term that enters a score is a bounded 0..1 reading with a sentence
 * behind it:
 *
 *   quality  measured intelligence, shrunk toward neutral by confidence
 *   speed    1 / (1 + firstTokenMs / gate), from live traffic first
 *   health   1 / (1 + 0.8 * decayed strikes)
 *   cost     1 / (1 + family burn * lane multiplier)
 *   usage    1 / (1 + today's channel tokens / usageUnit)
 *
 * @module src/router
 */

import { STRATEGIES, EFFORT_RANK, EFFORT_STRATEGY, DEFAULT_CONFIG, MAX_INTEL } from './policy-defaults.js'
import { laneVerdict } from './lanes.js'
import { PENALTY_TAGS } from './families.js'

/**
 * Tags whose meaning is enforced structurally and must not be charged twice.
 */
const TAGS_PRICED_ELSEWHERE = new Set([
  'verbose', 'slow-decode', 'not-a-model', 'region-blocked',
])

/** Authored tag penalties are written on the report's wide scale; halve them. */
const TAG_PENALTY_SCALE = 0.35

/** Extra deduction for using a non-vision lane because no vision lane is left. */
const VISION_FALLBACK_PENALTY = 0.25

/** Deduction while a cooling lane is still allowed (proactiveSwitch=false). */
const COOLING_PENALTY = 0.5

/**
 * Concurrency pressure: how busy one route is right now, as a 0..1 reading.
 *
 * The five readouts are all history. History cannot tell "two sessions at once"
 * from "one session asking twice", so N concurrent sessions all rank the same
 * lane first and stack onto it — splitting one per-key quota N ways and then
 * collecting a 429 burst whose cooldown is channel-scoped (LOCAL PATCH
 * 2026-10-26). This term is the only *live* input in the score.
 *
 * Both readings matter and they are not the same:
 *
 *   route — calls open on this exact `provider/model`; a second session on the
 *           same route gets nothing extra (the quota is already committed).
 *   lane  — calls open anywhere on the provider; a provider's allowance is
 *           usually one pool, so its other models are busy too.
 *
 * The route reading is weighted higher because it is the exact resource being
 * contended; the lane reading catches the shared-allowance case.
 */
function concurrencyPenalty(pressure, config) {
  if (config?.spreadConcurrency === false) return 0
  const route = Number(pressure?.route ?? 0)
  const lane = Number(pressure?.lane ?? 0)
  if (!(route > 0) && !(lane > 0)) return 0
  const cap = Math.max(1, Number(config?.concurrencySoftCap ?? 2))
  const weight = Math.max(0, Math.min(0.3, Number(config?.concurrencyWeight ?? 0.18)))
  // Saturation is per reading, then folded: the route count counts double
  // because it is the exact contended resource.
  const routeLoad = Math.min(1, route / cap)
  const laneLoad = Math.min(1, Math.max(0, lane - route) / cap)
  return weight * Math.min(1, routeLoad + 0.5 * laneLoad)
}

/** Max deduction for a lane whose recent calls failed often. */
const ERROR_RATE_PENALTY = 0.2

/** A live latency measurement is trusted only when it is this recent... */
const OBSERVATION_STALE_MS = 2 * 60 * 60_000

/** ...and has at least this many samples. */
const MIN_SAMPLES = 2

/** Saturation width of the latency term: at the gate, speed is 0.5. */
const DEFAULT_GATE_MS = 10_000

/** Highest measured intelligence in the report; used to normalize the scale. */
// MAX_INTEL 的唯一事实来源是 policy-defaults.js（catalog.js 的归一化用它）；
// 本文件只 re-export（见文件末），不再自写一份 46（FIX 2026-11-16）。

/**
 * Which strategy applies to this step.
 *
 * One function, used by selection and by the panel's ranking alike — the panel
 * used to rank with \`config.strategy\` while the router scored with a different
 * signal, so the table the user was reading was not the table the decision came
 * from.
 */
export function strategyFor(needs, config) {
  if (needs?.economy === true) return 'economy'
  if (needs?.escalate === true && config?.escalateOnFailure !== false) return 'quality'
  return config?.strategy ?? 'balanced'
}

/**
 * Describe what this step actually needs. Signals come from the step's own
 * messages and the accumulated turn, never from a model call of our own.
 *
 * Complexity is reported for the panel and used for exactly one thing: how eager
 * the router is to leave a healthy route. A formatting request should not churn
 * to another lane for a 0.04 gain; a refactor may.
 *
 * @param {object} input
 * @param {object} config - resolved plugin config.
 * @returns {{vision: boolean, tools: boolean, longContext: boolean, complexity: number, escalate: boolean, economy: boolean, switchMargin: number, estimatedTokens: number, turnTokens: number}}
 */
export function readNeeds(input = {}, config = {}) {
  const text = String(input.lastUserText ?? '')
  const estimated = Number(input.estimatedTokens ?? 0)
  const priorFailures = Number(input.priorFailures ?? 0)
  const turnTokens = Number(input.turnTokens ?? 0)
  const budget = Number(config.turnTokenBudget ?? 0)

  let complexity = 0.5
  const structural = (input.hasTools === true ? 0.12 : 0)
    + (estimated > 40_000 ? 0.15 : 0)
    + (estimated > 120_000 ? 0.15 : 0)
  complexity = Math.min(1, complexity + structural)
  const longTask = /重构|架构|设计|调试|排查|为什么|分析|实现|迁移|优化|refactor|architect|debug|analy[sz]e|design|implement|migrate/i.test(text)
  const shortTask = /^\s*(改|把|写|说|解释一下|什么是|格式化|rename|format|what is|explain briefly)/i.test(text) && text.length < 60
  if (longTask) complexity = Math.min(1, complexity + 0.2)
  if (shortTask) complexity = Math.max(0, complexity - 0.2)
  if (priorFailures > 0) complexity = Math.min(1, complexity + 0.15 * priorFailures)

  const base = Number(config.switchMargin ?? DEFAULT_CONFIG.switchMargin)
  const switchMargin = Math.max(0.01, base * (1.5 - complexity))

  return {
    vision: input.hasImage === true,
    tools: input.hasTools === true,
    longContext: estimated > Number(config.longContextThreshold ?? 120_000),
    complexity,
    escalate: priorFailures > 0,
    economy: budget > 0 && turnTokens > budget,
    estimatedTokens: estimated,
    turnTokens,
    switchMargin,
    cacheTokens: Number(input.cacheTokens ?? 0),
    cacheLane: input.cacheLane ?? null,
  }
}

/** Sum the authored penalties for a family's tags on the normalized scale. */
function tagPenalty(tags) {
  let total = 0
  for (const tag of tags) {
    if (TAGS_PRICED_ELSEWHERE.has(tag)) continue
    const value = PENALTY_TAGS[tag]
    if (Number.isFinite(value)) total += value * TAG_PENALTY_SCALE
  }
  return total
}

/** Health of one route, from its time-decayed strike count. */
function healthFactor(strikes) {
  const count = Number.isFinite(strikes) ? Math.max(0, strikes) : 0
  return 1 / (1 + 0.8 * count)
}

/**
 * Today's counters for one lane, from whichever local source has them.
 *
 * The channel pack covers the account channels; the free lane reports its own
 * per-model counters. Both are "real traffic recorded on this machine", so they
 * are folded into one shape here instead of being treated as different kinds of
 * evidence.
 */
export function channelStats(row) {
  const channel = row.channel
  if (channel === null || channel === undefined) return null
  if (channel.today !== null && channel.today !== undefined) return channel.today
  const free = channel.freeToday
  if (free === null || free === undefined) return null
  return {
    requests: Number(free.calls ?? 0),
    errors: Number(free.failed ?? 0),
    inputTokens: Number(free.inputTokens ?? 0),
    outputTokens: Number(free.outputTokens ?? 0),
    ttftMs: free.ttftMs ?? null,
    ttftCount: Number(free.ttftSamples ?? 0),
  }
}

/**
 * The latency a lane is judged on, and where that number came from.
 *
 * Sources, in strict order of authority:
 *
 * 1. what this machine measured in the last two hours (>= 2 samples);
 * 2. the same measurement when it is older than that — still the best evidence
 *    this machine has, see the stale branch below (LOCAL PATCH 2026-11-14);
 * 3. the channel pack's own ledger for today (the exact lane, not a family);
 * 4. the report's per-lane figure (again the exact lane/model pair);
 * 5. a structural floor for a lane known to be slow.
 *
 * A family's fastest-lane number is deliberately NOT a source: a 45-second lane
 * inheriting a 1-second lane's speed is the largest single reason the old
 * ordering looked wrong.
 */
export function latencyFor(row, health, now = Date.now(), options = {}) {
  const observed = health.observed(row.provider, row.model)
  const live = Number.isFinite(observed?.ttftMs) && observed.ttftMs > 0
    && Number(observed.samples ?? 0) >= MIN_SAMPLES
    && Number(observed.lastOkAt ?? 0) > 0
    && now - Number(observed.lastOkAt) <= OBSERVATION_STALE_MS
  if (live) return { ms: Math.round(observed.ttftMs), source: 'live', samples: observed.samples }

  // ── 过期但**真实**的读数（LOCAL PATCH 2026-11-14）───────────────────────────
  //
  // 事故形状：our-free-model 的 `deepseek-ai/deepseek-v4.1-flash` 实测首字 304 秒
  // （免费池排队），但这条记录 lastOkAt 超过两小时被判过期，于是掉进「未知」拿到中性的
  // 速度分 0.5——「我们不知道它多慢」和「我们知道它慢得不能用」被当成了同一件事。
  // 同期 `upstream stream idle past its deadline` 出现 14 次，用户看到的是「经常卡死」。
  //
  // 一次成功调用就会刷新 lastOkAt 与 EWMA，车道随即回到 live 分支，所以这不是永久判决；
  // 宁可让它慢的车道自己用成绩证明自己，也不要让「没数据」自动等于「还行」。
  if (observed !== null && observed !== undefined
    && Number.isFinite(observed.ttftMs) && observed.ttftMs > 0
    && Number(observed.samples ?? 0) >= MIN_SAMPLES
    && options.staleLatencyMode !== 'neutral') {
    return { ms: Math.round(observed.ttftMs), source: 'stale', samples: observed.samples }
  }

  const today = channelStats(row)
  if (today !== null
    && Number.isFinite(today.ttftMs) && today.ttftMs > 0
    && Number(today.ttftCount ?? 0) >= MIN_SAMPLES) {
    return { ms: Math.round(today.ttftMs), source: 'channel', samples: today.ttftCount }
  }

  if (Number.isFinite(row.reportTtftMs) && row.reportTtftMs > 0) {
    return { ms: Math.round(row.reportTtftMs), source: 'report', samples: 0 }
  }

  const floor = Number.isFinite(row.lanePenaltyMs) && row.lanePenaltyMs > 0 ? row.lanePenaltyMs : null
  if (floor !== null) return { ms: floor, source: 'floor', samples: 0 }
  return { ms: null, source: 'none', samples: 0 }
}

/**
 * Inspect one row against the step's hard requirements.
 *
 * "Hard" is deliberately short: a capability the request genuinely needs (an
 * image, a context window) and a verdict that says the route is not a model at
 * all. Latency, price, age and a bad history are all scores, not gates — a
 * gated lane receives no traffic and can never prove it recovered.
 *
 * @returns {{eligible: boolean, reason: string, cooling?: boolean, until?: number}}
 */
export function inspectLane(row, input) {
  const { needs, config, health } = input
  // Lane isolation (2026-10-27). Checked first, because it is a policy decision
  // rather than a measurement: a model the other instance owns must stay
  // unavailable even while it is healthy, cheap and fast. When the policy is
  // missing or unreadable `laneVerdict` returns `foreign: false`, so a broken
  // policy file degrades to v2.5.0 behaviour instead of grounding every request.
  const guard = config?.laneGuard
  if (guard !== null && guard !== undefined && guard.enabled === true && guard.enforce !== false
    && input.lanePolicy !== null && input.lanePolicy !== undefined) {
    const verdict = laneVerdict(row, input.lanePolicy)
    if (verdict.foreign) return { eligible: false, foreignLane: true, reason: '车道守卫：车道 ' + String(verdict.lane ?? '').toUpperCase() + ' 声明占用' }
  }
  if (input.exclude?.has?.(`${row.provider}\u0000${row.model}`)) {
    return { eligible: false, reason: '本次请求刚刚失败' }
  }
  if (row.denied) return { eligible: false, reason: row.deniedReason ?? '已屏蔽', denied: true }
  if (row.tags?.includes('not-a-model')) return { eligible: false, reason: '不是通用模型' }
  if (row.tags?.includes('region-blocked')) return { eligible: false, reason: '地区封锁' }
  if (needs.vision && row.vision !== true && input.visionFallback !== true) {
    return { eligible: false, reason: '不支持图片输入' }
  }
  if (needs.tools && row.tags?.includes('agent-weak')) {
    return { eligible: false, reason: '工具调用能力不足' }
  }
  if (needs.longContext && Number.isFinite(row.contextWindow)
    && row.contextWindow < Number(config.longContextThreshold ?? 120_000)) {
    return { eligible: false, reason: '上下文窗口不足' }
  }
  if (Number.isFinite(input.minContextWindow) && Number.isFinite(row.contextWindow)
    && row.contextWindow < input.minContextWindow) {
    return { eligible: false, reason: '上下文窗口比刚失败的模型更小' }
  }

  const state = health.stateOf(row.provider, row.model)
  const channel = row.channel
  const channelDown = channel !== null && channel !== undefined && channel.available === false
  const cooling = state.available === false || channelDown
  if (cooling && config.proactiveSwitch !== false) {
    return {
      eligible: false,
      cooling: true,
      reason: state.available === false ? state.reason : (channel?.free?.detail || '渠道不可用'),
      until: Math.max(Number(state.until ?? 0), Number(channel?.rateLimitedUntil ?? 0)),
    }
  }
  return { eligible: true, cooling, until: Math.max(Number(state.until ?? 0), Number(channel?.rateLimitedUntil ?? 0)) }
}

/**
 * Score one eligible lane.
 *
 * @returns {{utility: number, parts: object}}
 */
export function scoreLane(row, needs, strategy, health, current, config, now = Date.now(), inflight = null) {
  const weights = STRATEGIES[strategy] ?? STRATEGIES.balanced
  const state = health.stateOf(row.provider, row.model)
  const latency = latencyFor(row, health, now, { staleLatencyMode: config.staleLatencyMode })
  const gate = Number(config.latencyGateMs ?? DEFAULT_GATE_MS)
  // 没有 live 样本时用渠道先验，而不是全局中性常数 0.5（LOCAL PATCH 2026-11-16）。
  // 新接入的渠道必然没有样本，旧逻辑把「刚接进来」直接钉成中性分，等于让它永远
  // 赢不了已有 live 数据的车道——那不是它慢，只是没人测过它。
  const priorMs = Number.isFinite(row.ttftPriorMs) && row.ttftPriorMs > 0 ? row.ttftPriorMs : null
  const speedMs = latency.ms === null ? priorMs : latency.ms
  const speed = speedMs === null || !(gate > 0)
    ? 0.5
    : 1 / (1 + speedMs / gate)

  const quality = Number.isFinite(row.quality) ? row.quality : 0.5
  const healthTerm = healthFactor(state.strikes)

  const burn = Number.isFinite(row.burn) ? row.burn : 0.45
  const cost = 1 / (1 + burn)

  const today = channelStats(row)
  const used = today === null
    ? 0
    : Number(today.inputTokens ?? 0) + Number(today.outputTokens ?? 0)
  const usageUnit = Math.max(10_000, Number(config.usageUnitTokens ?? 2_000_000))
  // 无限额度档（free-pi）：用量与可用性无关，usage 项必须失效（固定 1）。
  // 否则「这个渠道用得最多」会被当成「这个渠道快用完了」，把最该用的车道压下去，
  // 反过来逼调度去用真花钱的渠道——正是额度被烧穿的机制。
  const usage = row.unlimited === true ? 1 : 1 / (1 + used / usageUnit)

  const isCurrent = current !== null && current !== undefined
    && current.provider === row.provider && current.model === row.model
  const anchorWeight = Math.min(0.2, Math.max(0, Number(config.anchorBonus ?? DEFAULT_CONFIG.anchorBonus)))
  const anchor = isCurrent ? anchorWeight : 0

  // Switching lanes drops the upstream prompt cache, so the whole context
  // re-bills as uncached input on the new lane. A candidate that is NOT the lane
  // holding the hot cache pays for the volume it would abandon.
  const cacheTokens = Number(needs.cacheTokens ?? 0)
  const cacheLane = needs.cacheLane ?? null
  const holdsCache = cacheLane !== null
    && cacheLane.provider === row.provider && cacheLane.model === row.model
  // 重读缓存的价格随目标车道缩放（LOCAL PATCH 2026-11-05）：换道要重付的是**这份
  // 上下文在目标车道上**的钱，便宜车道的重读自然便宜。固定惩罚会让「用 x0.06 的车道
  // 替换 x2.0 的车道」在效用上永远不划算——那正是额度被最贵车道吃干的机制。
  const reBillRef = Math.max(0.05, Number(config.cacheRebillRefBurn ?? DEFAULT_CONFIG.cacheRebillRefBurn))
  const reBillScale = Math.min(1, Math.max(0.1, burn / reBillRef))
  const cachePenalty = holdsCache || !(cacheTokens > 0)
    ? 0
    : Number(config.cacheSwitchPenalty ?? DEFAULT_CONFIG.cacheSwitchPenalty)
      * Math.min(1, cacheTokens / Math.max(1, Number(config.cacheAffinityTokens ?? DEFAULT_CONFIG.cacheAffinityTokens)))
      * reBillScale

  // Live concurrency pressure (see concurrencyPenalty): the only input that
  // describes the present rather than the past.
  const pressure = inflight === null || typeof inflight?.pressure !== 'function'
    ? null
    : inflight.pressure(row.provider, row.model)
  const concurrent = concurrencyPenalty(pressure, config)

  const penalty = tagPenalty(row.tags ?? [])
  const fallbackPenalty = needs.vision && row.vision !== true ? VISION_FALLBACK_PENALTY : 0
  const coolingPenalty = state.available === false ? COOLING_PENALTY : 0

  const requests = Number(today?.requests ?? 0)
  const errors = Number(today?.errors ?? 0)
  const errorRate = requests >= 5 ? Math.min(1, errors / requests) : 0
  const errorPenalty = errorRate * ERROR_RATE_PENALTY

  // A request that is close to the model's window is a real risk of an
  // expensive round trip that dies at the end; charge for it.
  const estimated = Number(needs.estimatedTokens ?? 0)
  const windowRisk = Number.isFinite(row.contextWindow) && row.contextWindow > 0 && estimated > 0
    ? Math.max(0, Math.min(0.15, (estimated / row.contextWindow - 0.75) * 0.6))
    : 0

  // The anchor bonus is added AFTER the bounded sum on purpose: it is a
  // stickiness nudge, not one of the five readouts. Keeping it out of
  // `baseUtility` is what stops it from silently cancelling the model-switch
  // margin — the old scorer added it inside the comparison, so a default 0.04
  // anchor ate a 0.03 switch threshold and the router almost never changed
  // model at all.
  const baseUtility = weights.quality * quality
    + weights.speed * speed
    + weights.health * healthTerm
    + weights.cost * cost
    + weights.usage * usage
    - cachePenalty
    - penalty
    - fallbackPenalty
    - coolingPenalty
    - errorPenalty
    - windowRisk
    - concurrent
  // 免费车道的离散加分：cost 项在小 burn 区间饱和，分不出「免费」与「一七折」。
  // 无限额度档拿满额，免费有上限的渠道拿六成；付费车道不加。
  const freeBonusCap = Math.min(0.3, Math.max(0, Number(config.freeLaneBonus ?? DEFAULT_CONFIG.freeLaneBonus)))
  const freeBonus = row.unlimited === true
    ? freeBonusCap
    : (row.freeLane === true ? freeBonusCap * 0.6 : 0)
  const utility = baseUtility + anchor + freeBonus

  return {
    utility,
    baseUtility,
    parts: {
      quality: round(quality),
      speed: round(speed),
      health: round(healthTerm),
      cost: round(cost),
      usage: round(usage),
      burn: round(burn),
      ttftMs: latency.ms,
      latencySource: latency.source,
      samples: latency.samples,
      speedMs: round(speedMs === null ? 0 : speedMs),
      ttftPriorMs: priorMs,
      unlimited: row.unlimited === true,
      billingSource: row.billingSource ?? 'name',
      freeBonus: round(freeBonus),
      strikes: round(state.strikes),
      intel: row.intel ?? null,
      anchor: isCurrent,
      cachePenalty: round(cachePenalty),
      penalty: round(penalty),
      errorRate: round(errorRate),
      windowRisk: round(windowRisk),
      concurrent: round(concurrent),
      inFlight: pressure === null ? null : pressure.route,
      laneInFlight: pressure === null ? null : pressure.lane,
      cooling: state.available === false,
      visionFallback: fallbackPenalty > 0,
    },
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * Inspect and score every row for one need profile.
 *
 * @returns {{now: number, strategy: string, needs: object, all: object[], lanes: object[], groups: object[], allGroups: Map<string, object>, visionFallback: boolean}}
 */
export function evaluate(input) {
  const { rows, health, config } = input
  const needs = input.needs ?? readNeeds({}, config)
  const strategy = strategyFor(needs, config)
  const now = input.now ?? Date.now()
  const base = {
    needs,
    config,
    health,
    now,
    exclude: input.exclude,
    minContextWindow: input.minContextWindow,
    lanePolicy: input.lanePolicy ?? null,
  }

  const inspectAll = (visionFallback) => rows.map(row => ({
    row,
    inspection: inspectLane(row, { ...base, visionFallback }),
  }))

  let all = inspectAll(false)

  // ── 两道掩码（家族停车 / 渠道互借）────────────────────────────────────────
  //
  // 历史（LOCAL PATCH 2026-11-14）：偏好家族 deepseek-v4.1-flash 挂 16 条同名车道，
  // 其中十几条可能同时是「未登录 / 未订阅 / 额度到中午 / 被屏蔽 / 安全拦截」，而失败
  // 恢复的既有规则是「先在同一家族换个渠道」——三次换道预算全烧在兄弟车道上，整轮
  // 以最后一个错误结束。家族停车就是为这件事加的。
  //
  // 2026-11-16 重构（FIX）：旧实现是两个互相读对方结果的掩码，于是出现判据循环——
  //   · 家族侧用「过滤后还有别的家族」当守卫，而那个「别的家族」可能是随后必然被
  //     互借掩码挡住的借入车道 → 一个已经停掉的家族被重新放行；
  //   · 互借侧用同一个 all 数「本机是否还有活车道」，于是本机车道被家族停车挡掉时，
  //     闸门反着生效：借入车道在最不该参战的时候参战（实测可用构造用例复现）。
  //
  // 现在分两步，谁都不读对方的渲染结果：
  //   1. 先算资格：以「初始合格」集合为输入，算出本机哪些家族必须停；
  //   2. 再渲染：逐个条目应用掩码，原位保留原因串，任何条目都不会被重建。
  // 家族停车的守卫对象是 **local 车道**（借入车道从来不是「本机还有别的选择」的证据），
  // 且级联求解：某家族被停后不再能为另一个家族当 survivor。
  const memberCount = new Map()
  const hasBorrowedSibling = new Map()
  for (const entry of all) {
    if (entry.inspection.eligible !== true) continue
    const familyKey = entry.row.key ?? entry.row.family ?? entry.row.model
    memberCount.set(familyKey, (memberCount.get(familyKey) ?? 0) + 1)
    if (entry.row.borrowed === true) hasBorrowedSibling.set(familyKey, true)
  }
  const localAliveRegardless = [...memberCount.entries()]
    .some(([key, count]) => count > (hasBorrowedSibling.get(key) === true ? 1 : 0))

  const excludedFamilies = input.excludeFamilies
  const parkedFamilies = new Set()
  if (excludedFamilies !== null && excludedFamilies !== undefined && excludedFamilies.size > 0) {
    const familyOf = entry => entry.row.key ?? entry.row.family ?? entry.row.model
    const wanted = [...new Set(all.filter(entry => entry.inspection.eligible === true)
      .map(familyOf)
      .filter(key => excludedFamilies.has(key)))]
    // 从小到大处理，让级联判定与顺序无关。
    wanted.sort((a, b) => (memberCount.get(a) ?? 0) - (memberCount.get(b) ?? 0))
    for (const key of wanted) {
      let survivors = 0
      for (const [other, count] of memberCount) {
        if (other === key || parkedFamilies.has(other)) continue
        survivors += count
      }
      // 守卫：只在「本机停掉这个家族之后仍有本机车道可用」时才停它。否则一个只挂一两个
      // 家族的目录会因为「这个家族刚失败过」直接变成全灭——比它要修的问题更贵。
      if (survivors > 0 || localAliveRegardless !== true) parkedFamilies.add(key)
    }
  }

  // 互借闸门：只要本机还有任何一条合格车道，借入车道这一轮就不进入打分。判据只数 local
  // 车道（borrowed !== true）：借来的那条不算「本机还有别的选择」。
  // 互借闸门只有两个判据，且都指向「抑制」：
  //   1. 端点不可达 / 清单失效（borrowUsable === false）→ 借入车道一律不参战；
  //   2. exhausted 模式下，本机仍有**合格且未被家族停车**的 local 车道 → 留作兜底。
  // 名字是「抑制」而不是「允许」——上一版把布尔写反，端点已死时反而不掩码，构造用例当场
  // 把借入车道选了出来。
  const endpointDown = config?.peerShare?.borrowUsable === false
  const localCandidateLeft = all.some(entry => entry.inspection.eligible === true
    && entry.row.borrowed !== true
    && !parkedFamilies.has(entry.row.key ?? entry.row.family ?? entry.row.model))
  const borrowedSuppressed = config?.peerShare?.enabled === true
    && (endpointDown
      || (config.peerShare.borrowWhen !== 'always' && localCandidateLeft))

  // ── 三类掩码的判定（谁也不读对方的渲染结果）──────────────────────────────
  //
  // 早先的写法在掩码之后调 all = inspectAll(true)，那个构造器是对原始 rows 的 map ——
  // 一次赋值把刚上好的掩码整表丢掉：被本步骤停掉的家族与「本机还有活车道故留作兜底」的
  // 借入车道全部复活成合格候选。仅把重建改成「只重判合格条目」还不够：inspectLane 是纯
  // 判定，它对刚被掩码判掉的条目一无所知，于是 familyParked / borrowedIdle 在返回给调用方
  // 之前被重新抹掉（实测：borrowUsable=false 时借入车道复活并被选中）。
  //
  // 所以三类掩码一律只**记录判定**，统一的改动只发生在下面那一次渲染里：
  //   · vision 回退：本机没有「有资格的、非借入的」视觉车道时，允许无视觉能力的车道顶一下
  //     （只改打分口径与原因，不改谁有资格参战）；
  //   · 家族停车：见上面那段（级联 + local 守卫）；
  //   · 互借闸门：本机仍有合格 local 车道时，借入车道留作兜底。
  let visionFallback = false
  if (needs.vision) {
    const hasVisionLane = all.some(entry => entry.inspection.eligible === true
      && entry.row.vision === true
      && entry.row.borrowed !== true
      && !parkedFamilies.has(entry.row.key ?? entry.row.family ?? entry.row.model))
    if (!hasVisionLane) visionFallback = true
  }
  all = all.map(entry => {
    const familyKey = entry.row.key ?? entry.row.family ?? entry.row.model
    if (entry.inspection.eligible !== true) {
      // 只对「被图片要求挡住」的条目做回退（FIX 2026-11-16）：这类条目此前从来没有进过
      // 评分面，回退是唯一能让这一步跑下去的办法。被策略掩码判掉的条目（家族停车 /
      // 借入闸门）保持原样——那两类属于设计意图，不能借回退复活。
      if (visionFallback !== true
        || entry.row.vision === true
        || entry.inspection.familyParked === true
        || entry.inspection.borrowedIdle === true) return entry
      return { row: entry.row, inspection: inspectLane(entry.row, { ...base, visionFallback: true }) }
    }
    if (parkedFamilies.has(familyKey)) {
      return {
        row: entry.row,
        inspection: {
          eligible: false,
          familyParked: true,
          reason: '同一家族在本步骤内已连续失败，本轮改试其它模型',
        },
      }
    }
    if (visionFallback === true && entry.row.vision !== true) {
      // 合格但无视觉能力的车道：同样标记为回退（吃 fallbackPenalty），让面板解释得通。
      return { row: entry.row, inspection: inspectLane(entry.row, { ...base, visionFallback: true }) }
    }
    if (entry.row.borrowed === true && borrowedSuppressed === true) {
      return {
        row: entry.row,
        inspection: {
          eligible: false,
          borrowedIdle: true,
          reason: endpointDown
            ? '互借：对侧端点不可达或清单失效，借入车道本轮不参战'
            : '互借：本机仍有可用车道，借来的额度留作兜底',
        },
      }
    }
    return entry
  })
  const current = input.anchor ?? null
  const inflight = input.inflight ?? null
  const lanes = []
  for (const entry of all) {
    if (!entry.inspection.eligible) continue
    const scored = scoreLane(entry.row, needs, strategy, health, current, config, now, inflight)
    lanes.push({
      row: entry.row,
      utility: scored.utility,
      baseUtility: scored.baseUtility,
      parts: scored.parts,
      inspection: entry.inspection,
    })
  }
  lanes.sort(compareEntries)

  const allGroups = new Map()
  for (const entry of all) {
    const key = entry.row.key ?? entry.row.family ?? entry.row.model
    let group = allGroups.get(key)
    if (group === undefined) {
      group = {
        key,
        family: entry.row.family,
        label: entry.row.family ?? entry.row.model,
        intel: entry.row.intel ?? entry.row.estimatedIntel ?? null,
        quality: entry.row.quality ?? 0.5,
        tags: entry.row.tags ?? [],
        all: [],
        lanes: [],
        utility: -Infinity,
      }
      allGroups.set(key, group)
    }
    group.all.push(entry)
    if (entry.row.intel !== null && entry.row.intel !== undefined) {
      group.intel = Math.max(Number(group.intel ?? 0), Number(entry.row.intel))
    }
  }
  for (const lane of lanes) {
    const group = allGroups.get(lane.row.key ?? lane.row.family ?? lane.row.model)
    if (group !== undefined) group.lanes.push(lane)
  }
  const groups = []
  for (const group of allGroups.values()) {
    group.lanes.sort(compareEntries)
    const best = group.lanes[0]
    // Group utility deliberately excludes the lane-anchor bonus: whether this
    // model is the best choice must not depend on the fact that it is already
    // in use. The bonus still guides which LANE of the chosen model to take.
    const baseBest = group.lanes.reduce((top, entry) => Math.max(top, entry.baseUtility ?? entry.utility), -Infinity)
    group.utility = group.lanes.length === 0
      ? -Infinity
      : baseBest + Math.min(0.03, Math.max(0, group.lanes.length - 1) * 0.01)
    group.best = best ?? null
    groups.push(group)
  }
  groups.sort((left, right) => right.utility - left.utility)

  return { now, strategy, needs, all, lanes, groups, allGroups, visionFallback }
}

/** Order two scored entries, breaking exact ties toward the cheaper lane. */
function compareEntries(left, right) {
  const delta = right.utility - left.utility
  if (Math.abs(delta) > 1e-9) return delta
  return (left.parts?.burn ?? 0) - (right.parts?.burn ?? 0)
}

/** Find the model group a preference names, with optional channel restriction. */
export function resolvePreferenceGroup(allGroups, preferModel, preferProvider) {
  const raw = String(preferModel ?? '').trim().toLowerCase()
  if (raw === '') return null
  let group
  let provider = String(preferProvider ?? '').trim().toLowerCase()
  let model = raw
  if (raw.includes('/')) {
    const index = raw.indexOf('/')
    provider = provider === '' ? raw.slice(0, index) : provider
    model = raw.slice(index + 1)
  }
  for (const candidate of allGroups.values()) {
    if (candidate.key === fold(model) || String(candidate.family ?? '').toLowerCase() === model) {
      group = candidate
      break
    }
  }
  if (group === undefined) {
    for (const candidate of allGroups.values()) {
      if (candidate.all.some(entry => String(entry.row.model).toLowerCase() === model)) {
        group = candidate
        break
      }
    }
  }
  if (group === undefined) return null
  if (provider === '') return group
  const lanes = group.all.filter(entry => String(entry.row.provider).toLowerCase() === provider)
  if (lanes.length === 0) return null
  const restricted = {
    ...group,
    all: lanes,
    lanes: group.lanes.filter(entry => String(entry.row.provider).toLowerCase() === provider),
  }
  restricted.best = restricted.lanes[0] ?? null
  return restricted
}

/** Fold a key the same way the catalog does. */
function fold(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-')
}

/**
 * Choose the route for one request.
 *
 * @param {object} input
 * @param {object[]} input.rows - catalog rows.
 * @param {object} input.health - health ledger.
 * @param {object} input.config - resolved plugin config.
 * @param {{provider: string, model: string} | null} input.anchor - the lane currently in effect.
 * @param {object} input.needs - output of readNeeds.
 * @param {object} [input.preference] - { model, provider, fallback } when mode is prefer.
 * @param {string} [input.mode] - effective mode (auto | prefer | manual | off).
 * @returns {object|null} decision, or null when nothing is routable.
 */
export function selectRoute(input) {
  const { config } = input
  const mode = input.mode ?? config.mode ?? 'auto'
  if (mode === 'off') return null

  const evaluation = evaluate(input)
  const { strategy, needs, groups, allGroups, all } = evaluation
  const anchor = input.anchor ?? null
  const anchorKey = anchor === null ? null : (anchor.key ?? findKey(allGroups, anchor))
  const anchorGroup = anchorKey === null ? undefined : allGroups.get(anchorKey)

  const decision = (group, lane, reason, extra = {}) => {
    const effort = chooseEffort(lane.row, input.requestedEffort, config, strategy)
    return {
      provider: lane.row.provider,
      model: lane.row.model,
      key: group.key,
      family: group.family,
      strategy,
      utility: lane.utility,
      parts: lane.parts,
      reason,
      effort,
      group: summarizeGroup(group),
      alternatives: groups.filter(candidate => candidate.key !== group.key).slice(0, 4).map(summarizeGroup),
      laneAlternatives: laneAlternatives(group, lane),
      needs,
      ...extra,
    }
  }

  // A failure retries on the same model first: identical weights, no context
  // switch, only a different quota. Only when that whole group is out does the
  // normal mode logic below get a say.
  if (input.forceGroupKey !== undefined && input.forceGroupKey !== null) {
    const forced = allGroups.get(input.forceGroupKey)
    if (forced !== undefined && forced.lanes.length > 0) {
      const lane = pickLaneWithMargin(forced, anchor, config.laneSwitchMargin)
      if (lane !== null) {
        return decision(forced, lane, '同一模型的其它渠道', { mode, sameModel: true })
      }
    }
  }

  // ── preference mode ────────────────────────────────────────────────────
  if (mode === 'prefer' && input.preference !== undefined && input.preference.model !== '') {
    const preferred = resolvePreferenceGroup(allGroups, input.preference.model, input.preference.provider)
    const eligible = preferred === null ? [] : preferred.lanes
    // A request-specific filter (this prompt needs an image, or a bigger window
    // than the preferred model advertises) must NOT leave preference mode: the
    // model is still perfectly usable for the next request. Only a channel that
    // is globally out — cooling, denied, unavailable — counts as exhaustion.
    const globallyUsable = preferred === null ? [] : preferred.all.filter(entry => inspectLane(entry.row, {
      needs: { ...needs, vision: false, longContext: false, tools: false },
      config,
      health: input.health,
      now: evaluation.now,
      visionFallback: true,
    }).eligible)
    if (preferred !== null && eligible.length > 0) {
      const lane = pickLaneWithMargin(preferred, anchor, config.laneSwitchMargin)
      return decision(preferred, lane, '偏好模式：' + (preferred.family ?? preferred.key) + ' · ' + lane.row.provider, {
        mode: 'prefer',
        preference: {
          used: true,
          model: input.preference.model,
          provider: input.preference.provider ?? '',
          availableLanes: eligible.length,
          totalLanes: preferred.all.length,
        },
      })
    }
    if (globallyUsable.length > 0) {
      // Step-specific fallback: route this one request elsewhere, keep the
      // preference intact for the next one.
      const why = [...new Set(eligible.length === 0
        ? preferred.all.map(entry => entry.inspection.reason).filter(Boolean)
        : [])].join('，') || '本次请求的硬性要求该模型不满足'
      const fallbackMode = input.modeFallback ?? 'auto'
      if (fallbackMode === 'off') return { blocked: true, strategy, needs, mode: 'prefer', stepFallback: { reason: why } }
      const chosen = fallbackMode === 'manual' && anchorGroup !== undefined && anchorGroup.lanes.length > 0
        ? anchorGroup
        : pickGroup(groups, anchorGroup, needs, config, null)
      if (chosen === null) return { blocked: true, strategy, needs, mode: 'prefer', stepFallback: { reason: why } }
      const lane = pickLaneWithMargin(chosen, anchor, config.laneSwitchMargin)
      if (lane === null) return { blocked: true, strategy, needs, mode: 'prefer', stepFallback: { reason: why } }
      return decision(chosen, lane, '偏好模型不满足本次请求（' + why + '），仅本次改选', {
        mode: 'prefer',
        stepFallback: { reason: why },
        preference: { used: false, model: input.preference.model, provider: input.preference.provider ?? '', stepFallback: true },
      })
    }
    // The preference cannot serve *globally* — the model is missing or every
    // lane is cooling/denied. That is the one case that leaves preference mode.
    const exhausted = {
      model: input.preference.model,
      provider: input.preference.provider ?? '',
      reason: preferred === null
        ? '当前没有任何渠道提供该模型'
        : explainExhausted(preferred, evaluation.now),
      lanes: preferred === null ? [] : preferred.all.map(entry => ({
        provider: entry.row.provider,
        model: entry.row.model,
        modelName: entry.row.modelName,
        available: entry.inspection.eligible,
        reason: entry.inspection.reason ?? '',
        cooldownMs: Math.max(0, Number(entry.inspection.until ?? 0) - evaluation.now),
      })),
      // 被用户自己的 deny 挡住的那几条（见 preferenceConflicts）：它们不会随时间
      // 恢复，通知与面板必须点出来，否则"偏好模式坏了"这个误判会一直成立。
      conflicts: preferred === null ? [] : preferenceConflicts(preferred),
      at: evaluation.now,
    }
    const fallback = input.modeFallback ?? 'auto'
    if (fallback === 'off') {
      return { blocked: true, exhausted, strategy, needs, mode: 'prefer', fallback }
    }
    if (fallback === 'manual' && anchorGroup !== undefined && anchorGroup.lanes.length > 0) {
      const lane = pickLaneWithMargin(anchorGroup, anchor, config.laneSwitchMargin)
      return decision(anchorGroup, lane, '偏好模型不可用，按手动模式保留当前模型', { mode: 'manual', fallback, exhausted })
    }
    const chosen = pickGroup(groups, anchorGroup, needs, config, null)
    if (chosen === null) return { blocked: true, exhausted, strategy, needs, mode: 'prefer', fallback }
    const lane = pickLaneWithMargin(chosen, anchor, config.laneSwitchMargin)
    return decision(chosen, lane, '偏好模型不可用，已按' + modeName(fallback) + '模式改选', { mode: fallback, fallback, exhausted })
  }

  // ── manual mode ────────────────────────────────────────────────────────
  if (mode === 'manual') {
    if (anchorGroup !== undefined && anchorGroup.lanes.length > 0) {
      const lane = pickLaneWithMargin(anchorGroup, anchor, config.laneSwitchMargin)
      return decision(anchorGroup, lane, '手动模式：保持当前模型', { mode: 'manual' })
    }
    const chosen = pickGroup(groups, null, needs, config, null)
    if (chosen === null) return null
    const lane = pickLaneWithMargin(chosen, anchor, config.laneSwitchMargin)
    return decision(chosen, lane, '手动模式：当前模型不可用，救急改选', { mode: 'manual' })
  }

  // ── auto mode ──────────────────────────────────────────────────────────
  const chosen = pickGroup(groups, anchorGroup, needs, config, anchor)
  if (chosen === null) return null
  const lane = pickLaneWithMargin(chosen, anchor, config.laneSwitchMargin)
  const sameGroup = anchorGroup !== undefined && chosen.key === anchorGroup.key
  const reason = sameGroup
    ? '保持当前模型 ' + (chosen.family ?? chosen.key) + '（同模型内选最优渠道）'
    : '按 ' + strategy + ' 策略选择 ' + (chosen.family ?? chosen.key)
  return decision(chosen, lane, reason, { mode: 'auto' })
}

/** Choose between the anchor group and the best one, with hysteresis. */
function pickGroup(groups, anchorGroup, needs, config, anchor) {
  const eligible = groups.filter(group => group.lanes.length > 0)
  if (eligible.length === 0) return null
  const best = eligible[0]
  if (anchorGroup === undefined || anchorGroup.lanes.length === 0) return best

  // A fresh picker change is an instruction, not a suggestion: hold the chosen
  // model for its TTL even when the scorer prefers another one. A failure
  // (escalate) or a spent turn budget (economy) is a policy reason to override
  // it, and those are the only two.
  if (anchor !== null && anchor !== undefined && anchor.userChoice === true
    && !needs.escalate && !needs.economy && eligible.includes(anchorGroup)) {
    return anchorGroup
  }

  // Escalation: after a failure, prefer a model at least as intelligent as the
  // one that failed — but only while such a model exists. Otherwise the router
  // would rather strand the turn than step down, which is worse than a weak but
  // working answer.
  if (needs.escalate && config.escalateOnFailure !== false) {
    const floor = Number(anchorGroup.intel ?? -Infinity)
    if (Number.isFinite(floor)) {
      const stronger = eligible.find(group => Number(group.intel ?? -Infinity) >= floor)
      if (stronger !== undefined) return stronger
    }
  }

  const margin = Number(needs.switchMargin ?? config.switchMargin ?? 0.04)
  if (eligible.includes(anchorGroup)) {
    if (best.key === anchorGroup.key) return best
    if (best.utility - anchorGroup.utility < margin) return anchorGroup
  }
  return best
}

/** Pick a lane, keeping the anchor lane on a tie. */
function pickLaneWithMargin(group, anchor, margin) {
  const lanes = group.lanes
  if (lanes.length === 0) return null
  const best = lanes[0]
  if (anchor === null || anchor === undefined) return best
  const current = lanes.find(entry => entry.row.provider === anchor.provider && entry.row.model === anchor.model)
  if (current === undefined) return best
  if (best.utility - current.utility < Number(margin ?? 0.05)) return current
  return best
}

function laneAlternatives(group, chosen) {
  return group.lanes
    .filter(entry => !(entry.row.provider === chosen.row.provider && entry.row.model === chosen.row.model))
    .slice(0, 5)
    .map(entry => ({
      provider: entry.row.provider,
      model: entry.row.model,
      modelName: entry.row.modelName,
      utility: round(entry.utility),
      ttftMs: entry.parts.ttftMs,
      latencySource: entry.parts.latencySource,
    }))
}

function summarizeGroup(group) {
  // `vision` / `contextWindow` are the two facts a preference picker has to show:
  // locking a text-only or small-window model is a decision the user can only make
  // if the list says so up front.
  const vision = group.all.some(entry => entry.row.vision === true)
  let contextWindow = 0
  for (const entry of group.all) {
    if (Number.isFinite(entry.row.contextWindow)) contextWindow = Math.max(contextWindow, entry.row.contextWindow)
  }
  return {
    key: group.key,
    family: group.family,
    label: group.label,
    intel: group.intel,
    quality: round(group.quality),
    utility: group.utility === -Infinity ? null : round(group.utility),
    lanes: group.lanes.length,
    total: group.all.length,
    bestProvider: group.best?.row?.provider ?? null,
    bestModel: group.best?.row?.model ?? null,
    // LOCAL PATCH 2026-10-24: the advertised ids behind one family. A lane that
    // renames the same weights (`sn-deepseek-v4-1-flash-1017`) now lives in the
    // family it belongs to, so the picker's search has to look at those ids too —
    // otherwise typing the id a lane actually shows finds nothing.
    models: [...new Set(group.all.map(entry => entry.row.model))],
    vision,
    contextWindow: contextWindow > 0 ? contextWindow : null,
    tags: group.tags,
  }
}

/**
 * 目录层给「被用户自己屏蔽」的车道写的 reason 前缀（见 src/catalog.js 的
 * decorate()：`用户屏蔽：${extraDeny}`）。
 *
 * 复制常量而不是从 catalog 导入，是因为 router 不该依赖目录层的实现；代价是它可能
 * 漂移，所以 smoke 里有一条用例专门断言「被 deny 的行确实带这个前缀」。
 */
export const DENY_REASON_PREFIX = '用户屏蔽：'

/**
 * 偏好家族里被用户自己的 deny 列表挡住的渠道。
 *
 * 为什么值得单独列出来：偏好模式的"全灭"有两种，用户的处置完全不同——
 *   · 渠道真的坏了/冷却中：等它就够了；
 *   · 渠道被自己的 deny 挡住：**等一千年也不会好**，只能去删 deny 项。
 * 旧代码把两者混成一句「全部 N 条渠道不可用」，于是 2026-11-13 那次事故里
 * 用户看到的是"偏好模式坏了"，实际是两条健康的 OFM 免费 flash 车道被
 * `our-free-model/deepseek-v4.1-flash-free` 这类陈旧 deny 项挡在门外，
 * 而他手动选同一车道时请求根本不经过 deny（选择器直接指定路由）。
 *
 * @param {object|null} group - the preferred group from evaluate/resolvePreferenceGroup.
 * @returns {Array<{provider: string, model: string, modelName: string, denyEntry: string}>}
 */
export function preferenceConflicts(group) {
  if (group === null || group === undefined) return []
  const out = []
  for (const entry of group.all ?? []) {
    const reason = String(entry?.inspection?.reason ?? '')
    if (!reason.startsWith(DENY_REASON_PREFIX)) continue
    out.push({
      provider: String(entry.row?.provider ?? ''),
      model: String(entry.row?.model ?? ''),
      modelName: String(entry.row?.modelName ?? entry.row?.model ?? ''),
      denyEntry: reason.slice(DENY_REASON_PREFIX.length).trim(),
    })
  }
  return out
}

/** Explain why a preferred group cannot serve, in one sentence. */
export function explainExhausted(group, now) {
  if (group.lanes.length > 0) return '可用'
  const reasons = new Map()
  let soonest = 0
  for (const entry of group.all) {
    const reason = entry.inspection.reason ?? '不可用'
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    if (entry.inspection.until > 0) {
      soonest = soonest === 0 ? entry.inspection.until : Math.min(soonest, entry.inspection.until)
    }
  }
  const detail = [...reasons.entries()].map(([reason, count]) => reason + '×' + count).join('，')
  // 被自己的 deny 挡住的部分必须单独说，并给出可执行的下一步：它不会随时间恢复。
  const conflicts = preferenceConflicts(group)
  const conflictNote = conflicts.length === 0
    ? ''
    : '其中 ' + conflicts.length + ' 条是被你自己的屏蔽列表挡住的（'
      + conflicts.map(conflict => conflict.denyEntry).join('、')
      + '），删除对应 deny 项即可立刻恢复；'
  if (soonest > now) {
    const minutes = Math.max(1, Math.round((soonest - now) / 60_000))
    return conflictNote + '全部 ' + group.all.length + ' 条渠道不可用（' + detail + '），最早约 ' + minutes + ' 分钟后恢复'
  }
  return conflictNote + '全部 ' + group.all.length + ' 条渠道不可用（' + detail + '）'
}

function findKey(allGroups, anchor) {
  for (const group of allGroups.values()) {
    if (group.all.some(entry => entry.row.provider === anchor.provider && entry.row.model === anchor.model)) return group.key
  }
  return null
}

/**
 * Pick the reasoning effort the target lane should run at.
 *
 * The report's intelligence numbers are measured at the benchmark's maximum
 * effort, and the old router dropped the session's effort on every switch — so
 * a user who chose "max" silently fell back to the provider default. This
 * function keeps an explicit choice where the target supports it and otherwise
 * lets the strategy decide (quality = strongest, economy = cheapest).
 */
export function chooseEffort(row, requested, config, strategy) {
  const efforts = Array.isArray(row.reasoning?.efforts) ? row.reasoning.efforts : []
  const ids = efforts.map(effort => effort.id).filter(id => typeof id === 'string' && id !== '')
  if (ids.length === 0) return undefined
  const rank = id => EFFORT_RANK[id] ?? 3
  if (typeof requested === 'string' && ids.includes(requested)) return requested
  const configured = config?.reasoningEffort ?? 'auto'
  if (configured !== 'auto' && configured !== 'preserve' && ids.includes(configured)) return configured
  if (configured === 'preserve') return undefined
  const mode = EFFORT_STRATEGY[strategy] ?? 'default'
  if (mode === 'max') return ids.reduce((best, id) => (rank(id) > rank(best) ? id : best), ids[0])
  if (mode === 'min') return ids.reduce((best, id) => (rank(id) < rank(best) ? id : best), ids[0])
  const fallback = row.reasoning?.defaultEffort
  if (typeof fallback === 'string' && ids.includes(fallback)) return fallback
  return ids.reduce((best, id) => (rank(id) > rank(best) ? id : best), ids[0])
}

function modeName(mode) {
  if (mode === 'auto') return '自动'
  if (mode === 'manual') return '手动'
  if (mode === 'off') return '关闭'
  return '自动'
}

/**
 * Rank every model group for the panel.
 *
 * The panel has to show the ordering the router is actually working from,
 * including the budget-driven switch to economy.
 */
export function rankGroups(input) {
  const evaluation = evaluate(input)
  return evaluation.groups.map(group => ({
    ...summarizeGroup(group),
    lanesDetail: group.lanes.slice(0, 4).map(entry => ({
      provider: entry.row.provider,
      model: entry.row.model,
      modelName: entry.row.modelName,
      utility: round(entry.utility),
      ttftMs: entry.parts.ttftMs,
      latencySource: entry.parts.latencySource,
      strikes: entry.parts.strikes,
      free: entry.row.freeLane === true,
      multiplier: entry.row.multiplier,
    })),
    excluded: group.all.length - group.lanes.length,
  }))
}

/** Rank the lanes of one group for the panel. */
export function rankLanes(input, key) {
  const evaluation = evaluate(input)
  const group = evaluation.allGroups.get(key)
  if (group === undefined) return []
  return group.all.map(entry => ({
    provider: entry.row.provider,
    providerName: entry.row.providerName,
    model: entry.row.model,
    modelName: entry.row.modelName,
    available: entry.inspection.eligible,
    reason: entry.inspection.reason ?? '',
    cooling: entry.inspection.cooling === true,
    cooldownMs: Math.max(0, Number(entry.inspection.until ?? 0) - evaluation.now),
    utility: entry.inspection.eligible
      ? round(scoreLane(entry.row, evaluation.needs, evaluation.strategy, input.health, input.anchor ?? null, input.config, evaluation.now, input.inflight ?? null).utility)
      : null,
    ttftMs: latencyFor(entry.row, input.health, evaluation.now).ms,
    latencySource: latencyFor(entry.row, input.health, evaluation.now).source,
    todayTokens: channelStats(entry.row) === null
      ? null
      : Number(channelStats(entry.row).inputTokens ?? 0) + Number(channelStats(entry.row).outputTokens ?? 0),
  }))
}

export { MAX_INTEL, healthFactor }
export default selectRoute
