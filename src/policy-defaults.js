/**
 * Routing policy: what the orchestrator is allowed to do, and how it weighs a
 * candidate.
 *
 * Two rules shape this file.
 *
 * 1. **The report is a prior, not the truth.** The shipped report is a
 *    snapshot of a benchmark taken on a different day, at the benchmark's
 *    maximum reasoning effort. What this machine measures — success, failure,
 *    first-token latency, today's channel usage — is newer and more relevant,
 *    so it is allowed to outweigh the report. Only structural facts (a model
 *    is a guardrail classifier; a model is region blocked) are hard filters.
 *
 * 2. **Every weight is restated as a sentence.** Each term below is a bounded
 *    0..1 reading; the weights of a strategy are comparable and sum to 1. If a
 *    score cannot be explained from its inputs, the ordering is not auditable
 *    and "priority feels wrong" is the inevitable outcome.
 *
 * @module src/policy-defaults
 */

/** Ids that are structurally not general models, mapped to the reason. */
export const DEFAULT_NEVER_ROUTE = {
  'nvidia/nemotron-3.5-content-safety:free': '护栏分类器，不是通用模型',
  'nemotron-3.5-content-safety': '护栏分类器，不是通用模型',
  'nemotron-3.5-content-safety-free': '护栏分类器，不是通用模型',
  'jev-1.13': '概率输出模型，不是通用模型',
  'jev-1.13-free': '概率输出模型，不是通用模型',
  'glyph-cluster': '不支持结构化输出，无法用于 agent 循环',
  'stealth/glyph-cluster': '不支持结构化输出，无法用于 agent 循环',
  'muse-spark-1.2': '地区封锁，中国大陆出口被拒',
  'muse-spark-1.3': '地区封锁，中国大陆出口被拒',
  'muse-spark-1.2-contributor-free': '地区封锁，中国大陆出口被拒',
  'muse-spark-1.3-contributor-free': '地区封锁，中国大陆出口被拒',
}

/**
 * Report lane -> the provider routes that carry it, plus a latency floor for a
 * lane that is structurally slow.
 *
 * The provider ids are the ones the channel pack actually registers, read from a
 * live profile rather than guessed: CodeBuddy/WorkBuddy is `buddy`, Qoder 中国版
 * is `qodercn`. A lane absent from this table is still routed to; it simply has
 * no authored hint.
 *
 * `penalty` exists because the report gives some lanes no per-model latency at
 * all (CodeArts measured 37-87 s). Without a floor those models look merely
 * "unmeasured" and would be scored as if they were fast.
 */
export const LANE_HINTS = {
  'CodeBuddy/WorkBuddy 腾讯': { providers: ['buddy', 'codebuddy', 'workbuddy'] },
  'CodeArts 华为云': { providers: ['codearts'], penalty: 30000 },
  'DeepSeek 官方': { providers: ['deepseek-official', 'deepseek-account'] },
  'LobsterAI 有道': { providers: ['lobsterai'] },
  'Loomy 讯飞': { providers: ['loomy'] },
  MiniMax: { providers: ['minimax'] },
  '免费车道 (免密)': { providers: ['our-free-model', 'kilo'] },
  '免费车道-地区受限': { providers: ['our-free-model-region'] },
  'Qoder 中国版 阿里': { providers: ['qodercn', 'qoder'] },
  'Raccoon 商汤': { providers: ['raccoon'] },
  'TRAE 字节': { providers: ['trae'] },
  'ZCode 智谱': { providers: ['zcode'] },
  Cline: { providers: ['cline'] },
  'Gemini Code Assist': { providers: ['gemini'] },
  OpenCode: { providers: ['opencode'] },
}

/**
 * Strategies differ only in the weights they put on five bounded readouts.
 *
 * The weights sum to 1 in every strategy, so a strategy change re-distributes
 * importance instead of rescaling the whole score.
 *
 *   quality  measured intelligence / 46, shrunk toward neutral by confidence
 *   speed    1 / (1 + firstTokenMs / latencyGateMs)
 *   health   1 / (1 + 0.8 * decayed strikes)
 *   cost     1 / (1 + effective burn)
 *   usage    1 / (1 + today's tokens / usageUnit)
 *
 * `anchor` is not part of the normalized sum: it is a small additive bonus for
 * keeping the route already in use (see `anchorBonus`).
 */
export const STRATEGIES = {
  /** Maximum measured intelligence; latency and price only break ties. */
  quality: { quality: 0.58, speed: 0.12, health: 0.14, cost: 0.08, usage: 0.08, anchor: 0.03 },
  /** The default: strong model, healthy lane, sensible price. */
  balanced: { quality: 0.46, speed: 0.18, health: 0.14, cost: 0.14, usage: 0.08, anchor: 0.04 },
  /** Cheapest adequate model: price and health beat raw intelligence. */
  economy: { quality: 0.34, speed: 0.14, health: 0.12, cost: 0.30, usage: 0.10, anchor: 0.04 },
  /** Lowest latency among models that can do the job. */
  speed: { quality: 0.34, speed: 0.34, health: 0.12, cost: 0.12, usage: 0.08, anchor: 0.04 },
}

/** Cooldowns, in milliseconds. `quota` resets at the next local midnight. */
/**
 * 故障域（连接层）短路（FIX 2026-11-16）。
 *
 * 连接层失败（ECONNRESET / ECONNREFUSED / getaddrinfo / TLS 握手）不是在说「这个模型不行」，
 * 而是在说「这个端点到不了」。旧实现把它当成每条车道各自的瞬时冷却，于是路由会在**同一个
 * 死端点**上换着模型反复撞：实测 2026-11-16 一次评审会话里 45 秒内出现 6 次
 * `switch-budget-exhausted`，每次 reason 都是同一个 cline ECONNRESET —— 8 次换道预算全部
 * 花在同一个线路上，整轮以错误收场。
 *
 * 现在的规则：同一渠道在窗口内连续 N 次连接层失败 ⇒ 判定「整域不通」，该渠道的**全部模型**
 * 一起退出候选；并且这类换道**不消耗**步骤/回合换道预算（改用按回合的独立配额，
 * 免得真断网时无限循环）。
 */
/**
 * 成本项的实测修正（FIX 2026-11-16）。
 *
 * 旧口径的 cost 只认「渠道倍率」——而倍率是从模型显示名里刮出来的（billingSource: 'name'）。
 * 实测反例：本机 35 天账本里 trae 吃掉了 11.4 亿输入 token、缓存重读为 **0**（每次请求
 * 全量重发上下文，in/out ≈ 152:1），而它在打分里因为名字上写着小倍率被当成「便宜」；
 * loomy 标着 x2.0 反而被判「贵」，可它的缓存重读是 11 亿 token —— 真实额度消耗只有
 * trae 的零头。对免费/额度型车道，「每次调用吃多少 token」才是账单。
 *
 * 修正不改倍率的语义，只把它乘上一个实测因子：
 *   effectiveIn = 每次调用输入 token × (1 − 0.9 × 缓存重读占比)
 *   tokenFactor = 1 / (1 + effectiveIn / refIn)
 *   cost = 倍率成本 × (1 − w + w × tokenFactor)
 * 缓存命中的那部分按 10% 计价（这是缓存单价与新增输入价差的经验近似）。
 */
export const TOKEN_COST = {
  /** 实测因子在成本项里占的权重（0 = 退回旧口径）。 */
  weight: 0.5,
  /** 「一次正常调用」的参考输入 token 数；超过它开始明显扣分。 */
  refInTokens: 20_000,
  /** 至少多少次成功样本才启用（少样本的均值不可信）。 */
  minSamples: 3,
  /** 缓存重读的计价折扣（1 = 完全免费，0 = 与新增输入同价）。 */
  cacheDiscount: 0.9,
}

export const CONNECTIVITY = {
  /** 同一渠道窗口内连续多少次连接层失败才算整域不通。 */
  strikes: 3,
  windowMs: 60_000,
  /** 整域短路时长：短、可自愈（一次成功调用或清单刷新会解除）。 */
  cooldownMs: 60_000,
  /** 每个回合允许多少次「不扣预算」的连接类换道。 */
  freeSwitchesPerTurn: 4,
}

export const COOLDOWN = {
  rate: 20_000,
  rateMax: 5 * 60_000,
  transient: 30_000,
  /**
   * 瞬时故障连败后的冷却上限（LOCAL PATCH 2026-11-14）。
   *
   * 旧行为：transient 的退避是 `30s × 1.5^strikes`，但**封顶在 rateMax = 5 分钟**。
   * 而真正连败的线路根本不是 5 分钟能好的：近三天会话日志里
   * `transport error: fetch failed` 一条线上出现 48 次（trae）、39 次（qoder）、
   * 17 次（raccoon），每次只停 30 秒~5 分钟，于是同一个死车道在一轮对话里被
   * 反复选中、反复失败。封顶放宽到 30 分钟，让「这条线现在不通」真的能停一会儿，
   * 同时仍然留出自动恢复的余地（成功一次即清账，见 markSuccess）。
   */
  transientMax: 30 * 60_000,
  auth: 30 * 60_000,
  /** auth 类连败的上限：凭据不会自己修好，反复回锅只是反复让整轮报错。 */
  authMax: 6 * 60 * 60_000,
  /**
   * 「未配置凭据 / 请先登录」——这不是故障，是**没登录**。
   *
   * 实测（2026-11-13）：workbuddy 车道 status=auth、冷却 30 分钟，到期后被再次选中，
   * 立刻以 `未配置凭据，请先登录` 结束整轮（turn/end kind:error ×2）。等 30 分钟
   * 不会让任何人去登录，所以这一类按 12 小时停车；用户登录后一次成功调用即清账。
   */
  credential: 12 * 60 * 60_000,
  /**
   * 订阅/套餐不可用（试用到期、未订阅该模型、需付费积分）。
   *
   * 实测：qoder/qodercn 返回 `{"pricingUrl":...} (112/model_error)` 与
   * cline `Error 403: the user is not subscribed to required model plan`——三天内
   * 合计 55 次重试。它们既不匹配 QUOTA_TEXT（没有 quota/额度字样）也不匹配
   * AUTH 的语义（凭据是好的，是**套餐**不在），旧代码把它们判成 30 秒的 transient，
   * 于是每一轮都在撞同一堵墙。
   *
   * LOCAL PATCH 2026-11-20：6h → 24h。套餐问题不会自己好，6 小时意味着一天回锅
   * 4 次、每次撞墙都烧一次真实请求；24 小时把回锅降到一天一次，成功调用或手动
   * 恢复仍然即时清账。free-pi 的 `needs premium credits` 也归这一类（见 health.js
   * 的 PREMIUM_TEXT），此前被 QUOTA_TEXT 的 credit 一词误判成每日额度、天天回锅。
   */
  plan: 24 * 60 * 60_000,
  /**
   * 模型退役/EOL（LOCAL PATCH 2026-11-20）。
   *
   * 实测：our-free-model 的 deepseek-v4.1-flash 于 2026-11-16 EOL，上游明说
   * `has reached its end of life … no longer available`，旧分类器不认识这句话，
   * 判成 30 秒 transient——于是一条**永久**死掉的模型每半小时被重新选中一次。
   * EOL 是永久事实，7 天長停车；模型若复活，一次成功调用即清账。
   */
  retired: 7 * 24 * 60 * 60_000,
  unavailable: 10 * 60_000,
  region: 24 * 60 * 60_000,
  quotaFallback: 60 * 60_000,
  quotaDayRollover: true,
}

/**
 * 同一条路线上的**同类失败**连续出现时的冷却升级（LOCAL PATCH 2026-11-14）。
 *
 * 为什么需要它：各类冷却本身都是常数（auth 固定 30 分钟、transient 有 5 分钟上限），
 * 而账本里的 strikes 会按 3 小时半衰期衰减——一条**每半小时失败一次**的车道，
 * 每次失败时衰减后的 strikes 都回到 0 附近，于是它的冷却永远是初始值，永远在同一
 * 个时间尺度上回锅。这不是"抖动"，这是"这条路就是不通"。
 *
 * 判据刻意与 FAILURE_BURST 分开：burst 判的是"同一件事被报了两次"（去重），
 * 这里判的是"同一件事**一次又一次**发生"（升级）。两者的窗口与后果都不同——
 * burst 不延长冷却，升级才延长。
 */
export const ESCALATION = {
  /** 两次同类失败相隔多久之内算"连着来"。 */
  windowMs: 30 * 60_000,
  /** 第几次连着来开始升级（第 2 次即 ×2）。 */
  minRun: 2,
  /** 每次连败的倍数与倍数上限。 */
  factor: 2,
  maxFactor: 8,
}

/**
 * Repeated-request-rejection guard (LOCAL PATCH 2026-10-18).
 *
 * `INVALID_REQUEST` normally means *our* request was malformed, and cooling a
 * lane for it would punish a healthy channel — the ledger therefore records no
 * verdict at all. A channel that answers the same way again and again is a
 * different story: it refuses what we send, and because the router has no
 * verdict to act on it keeps choosing that lane and every turn dies with no
 * failover. Measured case: WorkBuddy (腾讯 CodeBuddy) returned
 * `HTTP 400 请求被拦截，请重新发送 request illegal` on two consecutive turns; the
 * session only recovered after a manual model switch.
 *
 * Counting the refusals inside a window and parking the model for a bounded
 * while turns that dead end into one wasted call.
 */
export const REQUEST_REPEAT = {
  /** Rejections on one lane, inside the window, that park it. */
  threshold: 2,
  /** The window those rejections must arrive in. */
  windowMs: 10 * 60_000,
  /** How long the parked model stays out of the ranking. */
  blockMs: 30 * 60_000,
}

/**
 * Concurrency spreading (LOCAL PATCH 2026-10-26).
 *
 * ## The defect this fixes
 *
 * The ledger scores lanes from history only, so N sessions open at the same
 * moment all rank the same lane first and stack onto it. A free channel's
 * allowance is per key (often per IP), so stacking does not go faster: it splits
 * one quota N ways and then collects a 429 burst whose cooldown is
 * channel-scoped — one session's rate limit stops every other session on that
 * lane for minutes.
 *
 * Measured consequence of NOT modelling it (2026-10-26, 5 concurrent sessions on
 * one free lane): the second 429 of a burst escalated the cooldown from 60 s to
 * 16 min, because each concurrent failure added its own strike to the same
 * route record.
 *
 * ## What the two knobs mean
 *
 * - `softCap` — open calls at which the penalty reaches full weight. 2 means "a
 *   lane already serving one call is worth noticeably less to a second
 *   session", which is exactly the fan-out point.
 * - `weight` — the maximum deduction. It must exceed `laneSwitchMargin` (0.05)
 *   and `anchorBonus` (0.04) or the router would keep a lane it has just been
 *   told is busy; 0.18 clears both with margin while staying below one full
 *   quality point (`0.46` in balanced), so a genuinely better model still wins.
 *
 * Both are bounded and restated as penalties, not weights: the five readouts
 * still sum to 1, so an existing ranking stays auditable.
 */
export const CONCURRENCY = {
  enabled: true,
  /** Open calls (on the route or its provider) at which the penalty is full. */
  softCap: 2,
  /** Maximum utility deduction for a saturated lane. */
  weight: 0.18,
  /** A lease older than this stops counting (a stream that never closed). */
  staleMs: 15 * 60_000,
}

/**
 * Failure-burst deduplication (LOCAL PATCH 2026-10-26).
 *
 * Concurrent sessions that hit the *same* wall report it one failure each, and
 * every one of those failures used to add a strike — so five parallel 429s on
 * one lane produced five strikes and an exponential cooldown (20 s → 300 s cap)
 * from what was a single upstream event.
 *
 * Rule: a failure of the same kind, on the same route, inside this window is
 * counted once for striking purposes. The cooldown is *not* extended either —
 * it is the same wall, and sliding the deadline forward on every retry is how a
 * burst turns into a park.
 */
export const FAILURE_BURST = {
  /** Same-kind failures on one route closer than this are one event. */
  windowMs: 5_000,
}

/**
 * Half-life of a recorded failure, in milliseconds.
 *
 * A strike used to be permanent until the same route succeeded again — and a
 * route that keeps losing the ranking never succeeds again. Exponential decay
 * makes the ledger forget the way a person would: what broke five minutes ago
 * still counts, what broke yesterday barely does.
 */
export const STRIKE_HALF_LIFE_MS = 3 * 60 * 60_000

/** Rolling windows the health registry keeps token spend for. */
export const TOKEN_WINDOWS = [
  { id: '15m', ms: 15 * 60_000 },
  { id: '1h', ms: 60 * 60_000 },
  { id: '5h', ms: 5 * 60 * 60_000 },
  { id: 'day', ms: 24 * 60 * 60_000 },
]

/** Highest measured intelligence in the report; used to normalize the scale. */
export const MAX_INTEL = 46

/** Intelligence a model with no verifiable score is assumed to have, as 0..1. */
export const NEUTRAL_INTEL_SCORE = 0.5

/**
 * How far a measured score is trusted, by the source that produced it.
 *
 * The report's own measurement is a third-party benchmark, not a run of this
 * machine, and it was taken at the benchmark's maximum effort; 0.9 keeps its
 * ranking without letting it pose as a fact. An AA estimate is worth far less,
 * and an id the report never saw gets the neutral prior only.
 */
export const INTEL_CONFIDENCE = {
  measured: 0.9,
  estimated: 0.45,
  unknown: 0,
}

/** Relative strength of reasoning effort ids, used to pick a target effort. */
export const EFFORT_RANK = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  extra_high: 6,
  max: 7,
}

/** Strategies whose automatic effort choice asks for the strongest tier. */
export const EFFORT_STRATEGY = {
  quality: 'max',
  balanced: 'default',
  economy: 'min',
  speed: 'min',
}

/** Plugin config defaults; every one of them is overridable from `cordis.patch.yml`. */
export const DEFAULT_CONFIG = {
  enabled: true,
  /**
   * auto     — pick the best model group and lane for each step;
   * prefer   — use `preferModel` and only switch lanes inside that model;
   * manual   — keep the model the user (or the last route) chose, rescue only;
   * off      — never intervene.
   */
  mode: 'auto',
  /** Preferred model: a family key, or an exact model id (resolved to its group). */
  preferModel: '',
  /** Optional lane restriction for the preferred model (empty = any channel). */
  preferProvider: '',
  /** What to run while the preferred model has no usable lane. */
  preferFallback: 'auto',
  /** Raise a native notification when the preferred model becomes unusable. */
  preferNotify: true,
  /** Re-enter preference mode by itself once a lane recovers. */
  preferAutoResume: true,
  /** Follow an explicit picker change while in preference mode. */
  preferFollowSelection: true,
  strategy: 'balanced',
  /** Force an exact lane for every request when both are non-empty (legacy pin). */
  pinProvider: '',
  pinModel: '',
  /** Extra ids (or `provider/model` pairs) that must never be chosen. */
  deny: [],
  /** Extra ids that are always allowed, even if the report denies them. */
  allow: [],
  /** Provider routes to exclude. */
  denyProviders: [],
  /**
   * Lane isolation (2026-10-27). Off by default: with no policy path configured
   * the guard has nothing to read, and a guard that guesses is worse than none.
   *
   * `laneId` says which lane this instance owns ('a' = main, 'b' = worker);
   * `policyPath` points at `_supervisor/policy.json`; `enforce: false` keeps the
   * audit and stops blocking, which is what you want while re-balancing lanes.
   */
  laneGuard: {
    enabled: false,
    laneId: 'b',
    policyPath: '',
    enforce: true,
  },
  /**
   * Peers whose real running model the pairing action reads. `healthPath` is the
   * peer's own `model-orchestrator/health.json` (what it dispatched);
   * `patchPath` is its profile patch (what it would dispatch on boot).
   */
  duoPeers: [],
  /**
   * Maximum automatic route changes inside one step before giving up.
   *
   * LOCAL PATCH 2026-11-16: 3 was too tight for the free-lane catalog. 实测
   * 11-10..11-16 的 134 个会话里，38 个回合以 error 收场，其中 13 个回合在
   * **一个步骤**里撞了 10~22 次失败——偏好家族 deepseek-v4.1-flash 挂着 16 条
   * 同名车道，其中十几条同时是「未登录 / 未订阅 / 被安全拦截」的死路，3 次换道
   * 根本走不到一条活车道。5 次仍然有界，但足够穿过一整片死路。
   */
  maxSwitchesPerStep: 5,
  /** 预算外的「宁可换也不要死」余量（原 index.js 的硬编码 EXTRA_SWITCHES = 2）。 */
  switchOverdraft: 2,
  /** 成本项的实测修正权重与参考输入量（见 TOKEN_COST）。 */
  tokenCostWeight: TOKEN_COST.weight,
  tokenCostRefInTokens: TOKEN_COST.refInTokens,
  /** Maximum automatic route changes inside one turn. */
  maxSwitchesPerTurn: 16,
  /**
   * 由调度器而不是内核掌管重试预算（LOCAL PATCH 2026-11-16）。
   *
   * 事实：内核的 `llm-retry` 对 TRANSPORT/TIMEOUT/SERVER/RATE_LIMIT/EMPTY_RESPONSE
   * 有独立的 5 次同车道重试，而它注册在 `agent/request-error` 瀑布里；只要它先跑，
   * 一次失败就会被它吞掉 5 次（0.5s→10s 退避），调度器要到第 6 次才看得见——
   * 于是「同一条死车道重试 15~22 次」和「首轮必失败」同时成立。
   * 打开后调度器抢先接管：车道级故障立刻换道，瞬时故障才放给内核退避。
   * 关掉恢复旧行为（内核优先）。
   */
  ownRetryBudget: true,
  /**
   * 一个步骤内允许的「最后一搏」：所有车道都在冷却、或换道预算用尽时，
   * 不直接把回合判死，而是挑最早恢复的那条车道、等它的冷却结束再试一次。
   * 这是「运行一段时间后失败了，还得用户重置」的直接解药——那时账本里通常
   * 只剩冷却中的车道，旧代码返回 null ⇒ 裸错误 ⇒ 回合失败。
   */
  lastResortPerStep: 1,
  /**
   * 最后一搏最多愿意等多久（毫秒）；超过就放弃，交给回合级自动续跑。
   *
   * 20 秒是"界面看起来还在干活"的上限：瞬时冷却的基础值是 30 秒，等它的收益
   * 明确（等回来就能继续），但每一步都静默 30 秒以上会被当成卡死。更长的等待
   * 挪到回合边界去做——那里有自动续跑，而且用户能看见那条说明。
   */
  lastResortWaitMs: 20_000,
  /**
   * 回合因车道故障中断后自动续跑（LOCAL PATCH 2026-11-16）。
   *
   * 旧行为：turn 以 error 结束时内核直接抛 LlmError，界面弹「本轮运行失败」，
   * 用户必须自己点重试。打开后调度器在回合边界替用户按下那次重试——用一条
   * 明确的 user 消息续上原任务，并在消息里说明为什么中断。
   */
  autoResume: true,
  /** 同一条失败链上最多自动续跑几次（成功完成一个回合即归零）。 */
  autoResumeMax: 2,
  /** 第一次续跑前的停顿：给冷却中的车道一点恢复时间，也避免空转。 */
  autoResumeDelayMs: 1_500,
  /**
   * 自动续跑的等待上限（毫秒）。
   *
   * 续跑的时机应该跟账本对齐：如果最早恢复的车道还要 40 秒才回来，1.5 秒后就
   * 续跑等于立刻再撞一次同一堵墙。所以续跑延迟 = max(基础延迟，min(最早恢复时间, 上限))。
   * 上限存在的理由：凭据/订阅类停车是小时级的，等满没有意义，那时应该让用户看见
   * 一条明确的错误，而不是把回合挂在这里。
   */
  autoResumeWaitCapMs: 90_000,
  /** Switch away from a cooling model instead of waiting for it. */
  proactiveSwitch: true,
  /** After a failure, prefer a model at least as intelligent as the failed one. */
  escalateOnFailure: true,
  /** Downgrade once a turn's output tokens exceed this; 0 disables the budget. */
  turnTokenBudget: 0,
  /** Tokens above which the router insists on a long-context family. */
  longContextThreshold: 120_000,
  /** First-token latency at which a lane's speed score is 0.5 (0 disables). */
  latencyGateMs: 10_000,
  /**
   * 陈旧但真实的延迟读数该怎么算（LOCAL PATCH 2026-11-14）。
   *
   * 事故形状：our-free-model 的 `deepseek-ai/deepseek-v4.1-flash` 实测首字
   * **304 秒**（免费池排队），但这条记录 lastOkAt 超过 2 小时后被判为"过期"，
   * latencyFor 于是回退到 report/unknown，速度项拿到**中性**的 0.5——"我们不知道它多慢"
   * 与"我们知道它慢得不可用"被当成了同一件事。结果是偏好模式在这条车道上坐着出字，
   * 用户看到的是"经常卡住"（同期 `upstream stream idle past its deadline` 14 次）。
   *
   * `penalize` — 过期读数仍参与打分（source='stale'）：一次成功调用会刷新 EWMA，
   * 车道自己就能翻案，所以这不是永久门槛；
   * `neutral`  — 旧行为，把过期读数当未知。
   */
  staleLatencyMode: 'penalize',
  /** 同一条路线同类失败连败时，冷却按 ESCALATION 升级（关掉 = 每次都用基础冷却）。 */
  sameKindEscalation: true,
  /** Max utility penalty for abandoning the lane that still holds the prompt cache. */
  cacheSwitchPenalty: 0.35,
  /**
   * 缓存重读惩罚的基准 burn（LOCAL PATCH 2026-11-05）。
   *
   * 罚分的物理含义是「换道后整个上下文按未命中缓存重新计费」。既然它是**计费**，
   * 就必须乘上目标车道的价格：换到 x0.06 的车道上，同一份上下文的重读成本只有基准
   * 车道的几十分之一；旧代码给它一个固定 0.35，于是 x2.0 车道上的一次换道代价恒等于
   * 昂贵车道的代价，便宜的候选永远追不回来（实测：x0.06 与 x2.0 的效用差只有 0.137，
   * 而固定惩罚 0.35 ⇒ 净差 -0.213，迁移在结构上不可能发生）。
   */
  cacheRebillRefBurn: 0.45,
  /** Cached tokens at which the cache-switch penalty reaches its cap. */
  cacheAffinityTokens: 30_000,
  /** Bonus for keeping the lane and model already in use. */
  anchorBonus: 0.04,
  /** Utility gain required before the router leaves a healthy model group. */
  switchMargin: 0.04,
  /** Utility gain required before the router leaves a healthy lane. */
  laneSwitchMargin: 0.05,
  /**
   * Spread concurrent sessions across lanes instead of stacking them on one
   * (see CONCURRENCY). Off restores pure history-based ranking.
   */
  spreadConcurrency: true,
  /** Open calls at which the concurrency penalty is full. */
  concurrencySoftCap: CONCURRENCY.softCap,
  /** Maximum utility deduction for a saturated lane. */
  concurrencyWeight: CONCURRENCY.weight,
  /** An in-flight lease older than this stops counting (a stream that never closed). */
  concurrencyStaleMs: CONCURRENCY.staleMs,
  /** Same-kind failures on one route inside this window count as one event. */
  failureBurstWindowMs: FAILURE_BURST.windowMs,
  /** How long an explicit picker change is respected in auto mode. */
  userChoiceTtlMs: 30 * 60_000,
  /** Route subagent sessions too (off: their own model choice wins). */
  routeSubagents: false,
  /** Adopt a picker change as the new routing anchor. */
  adoptUserSelection: true,
  /**
   * 首轮接管：新会话的第一条消息就按调度结果调用模型。
   *
   * 关掉它时，首轮会先跑模型选择器里的那个（"上次用过的"）模型，从第二步起才
   * 由路由器纠正——用户看到的现象就是"自动调度开了，第一个回答却不是它选的"。
   * 打开时首轮直接选最优模型，并把选择写进内核的 selection，选择器同步跟着变。
   */
  routeFirstTurn: true,
  /**
   * 自动选择：模型完全由调度决定，官方模型选择器只作为展示。
   *
   * 关掉时（默认），auto 模式会尊重选择器改动 `userChoiceTtlMs`；打开后选择器里的
   * 模型与改选事件都不再是锚点，每一步都按当前策略（含偏好模式）重新选，路由结果
   * 会写回选择器——用户看到的就是「选择器跟着调度走」。
   */
  autoSelect: false,
  /**
   * auto     — the strategy decides (quality=max, balanced=default, economy/speed=min);
   * preserve — keep the session's effort where the target supports it;
   * <id>     — force one effort id wherever it is supported.
   */
  reasoningEffort: 'auto',
  /** Re-probe the live model catalog this often. */
  catalogRefreshMs: 120_000,
  /** Persist health state this often (dirty writes are coalesced). */
  persistIntervalMs: 15_000,
  /** Re-read the channel pack's ledger/state this often. */
  channelDataRefreshMs: 30_000,
  /** How long resolved model metadata is reused before asking the adapter again. */
  modelInfoTtlMs: 6 * 60 * 60_000,
  /** Per-provider listModels/resolveModelInfo deadline. */
  catalogTimeoutMs: 15_000,
  /** Keep at most this many recent decisions for the panel. */
  decisionLogSize: 80,
  /** Read the channel pack's per-account ledger and rate limits. */
  channelData: true,
  /** Read the free lane's own availability probe. */
  freeModelData: true,
  /** Override the channel-pack state directory (empty = `$DSH_HOME/channel-pack`). */
  channelPackDir: '',
  /** Override the free lane's state directory (empty = `$DSH_HOME/our-free-model`). */
  freeModelDir: '',
  /** Treat today's token spend as quota pressure at this volume. */
  usageUnitTokens: 2_000_000,
  /** Request-side rejections on one lane, inside the window, that park it. */
  requestRepeatThreshold: REQUEST_REPEAT.threshold,
  /** Window in which those rejections must arrive. */
  requestRepeatWindowMs: REQUEST_REPEAT.windowMs,
  /** How long a lane parked for repeated rejections stays out of the ranking. */
  requestRepeatBlockMs: REQUEST_REPEAT.blockMs,
  /**
   * 定时渠道巡检（2026-11-03）。
   *
   * 为什么需要它：免费车道会「静默死亡」——cline 的 402 额度耗尽、our-free-model
   * 的免费层永久限流、某渠道悄悄把模型下架。这些只有「被选中并失败一次」之后
   * health 账本才会知道；若很久没人选它，面板上的"可用"就是假的。
   * 打开后按间隔主动探一遍，把结果写回账本（见 src/probe.js）。
   *
   * 默认三天一次：探活本身要花额度，太勤等于替用户烧钱；太疏则账本又失真。
   * 首轮延迟 10 分钟，避免启动瞬间和用户正在进行的会话抢额度。
   */
  probeEnabled: true,
  /** 间隔（天）。被 probeIntervalMs 覆盖。 */
  probeEveryDays: 3,
  /** 间隔（毫秒）。给 0 或负数时回落到 probeEveryDays。 */
  probeIntervalMs: 0,
  /** 单条车道的探测超时。 */
  probeTimeoutMs: 20_000,
  /** 一轮内同时探测几条。 */
  probeConcurrency: 2,
  /** 首轮延迟，避开启动时的会话。 */
  probeFirstDelayMs: 10 * 60_000,
  /**
   * 是否连借来的车道一起探（默认否）。
   *
   * 借入行挂在同一个 peer provider 下，数量是对侧的全部模型（实测 B 侧 600 条）。
   * 探它们等于拿**对侧**的账号额度给本机做体检，而且每条失败都会写进本机账本——
   * 探活是「本机车道会不会静默死亡」的补丁，不是替对侧体检的工具。
   */
  probeBorrowed: false,
  /**
   * 冷却中的车道多久复核一次（LOCAL PATCH 2026-11-16）。
   *
   * 起因是一个真实事故：free-pi 在重启探测时用了占位 token，401 被判成 lane 级
   * AUTH，整条渠道停车 30 分钟。凭据在 5 分钟内就修好了，但 `shouldSkip` 认为
   * 「冷却未到期 = 探了也白探」，于是**没有任何一次探测去发现它已经好了**，
   * 活活等满 30 分钟。
   *
   * 判据错在把「外部状态」当成「自身状态」：AUTH / PLAN / REGION / QUOTA 这四类
   * 是账号、套餐、地区、账单的事，人在任何时刻都能改好，冷却期长短与它无关。
   * 所以这类判定允许按期复核：每条渠道每轮**只复核一个代表模型**（不是整渠道
   * 几百条一起探），成功后 markSuccess 会顺手解除整条车道的停车。
   *
   * 给 0 关闭复核，回到旧行为。
   */
  probeRecheckMs: 5 * 60_000,
  /**
   * 免费车道的显式加分（LOCAL PATCH 2026-11-16）。
   *
   * 为什么不能只靠 cost 项：cost = 1 / (1 + burn) 在 burn 很小时**饱和**。
   * 实测 free-pi（burn 0.0066）与 buddy（burn 0.0374）的 cost 读数差 0.0296，
   * 乘 economy 的 0.30 权重只有 0.009 效用——「免费」与「打一七折」在评分上几乎
   * 同一件事，于是 economy 策略并不真的省钱，只是碰巧顺序对。
   *
   * 所以把「免费」当成一个**离散事实**加分，而不是靠连续函数的尾巴：无限额度档
   * 拿满额加分，免费但有上限的渠道拿六成。它是加在 baseUtility 之后的独立项
   * （与 anchor 同一位置），不改动原有的五个读数。
   *
   * 给 0 关闭，回到只靠 cost 项的老行为。
   */
  freeLaneBonus: 0.05,
  /** Load the priority report from this path on start; empty disables it. */
  reportPath: '',
  /**
   * 渠道互借（2026-10-29）。
   *
   * 背景：A/B 两端注册的 provider 列表几乎一样，真正会先烧穿的是**某一端的账号额度**。
   * 打开后，额度充裕的一端可以把车道借给对侧用（见 src/peershare.js）。
   *
   * role 三态：
   *   off    — 不参与互借（默认，等价于关闭）；
   *   both   — 既出借也借用；
   *   lend   — 只出借；
   *   borrow — 只借用。
   *
   * borrowWhen 决定借用车道什么时候才参与打分：
   *   exhausted — 本机自己的车道全不可用时才借（默认；互借是兜底，不是常态）；
   *   always    — 一直参与打分（两端额度按打分自然分摊）。
   */
  peerShare: {
    enabled: false,
    role: 'both',
    label: '',
    /**
     * 只绑回环（2026-10-29 改）。
     *
     * 出借端点拿到 token 就能用对侧的额度，默认不该出现在局域网上：同一网段任何
     * 一台机器扫到 18326 都可以先发一个 GET /hello 试探。要跨机用就显式填局域网
     * 地址或 0.0.0.0（此时务必自己确认防火墙与 token 只发给可信的一端）。
     */
    host: '127.0.0.1',
    port: 18326,
    token: '',
    allowProviders: [],
    denyProviders: [],
    peerUrl: '',
    peerToken: '',
    peerProvider: 'peer',
    borrowWhen: 'exhausted',
    timeoutMs: 15_000,
  },
}

export default DEFAULT_CONFIG
