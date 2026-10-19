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
export const COOLDOWN = {
  rate: 20_000,
  rateMax: 5 * 60_000,
  transient: 30_000,
  auth: 30 * 60_000,
  unavailable: 10 * 60_000,
  region: 24 * 60 * 60_000,
  quotaFallback: 60 * 60_000,
  quotaDayRollover: true,
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
  /** Maximum automatic route changes inside one step before giving up. */
  maxSwitchesPerStep: 3,
  /** Maximum automatic route changes inside one turn. */
  maxSwitchesPerTurn: 12,
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
  /** Max utility penalty for abandoning the lane that still holds the prompt cache. */
  cacheSwitchPenalty: 0.35,
  /** Cached tokens at which the cache-switch penalty reaches its cap. */
  cacheAffinityTokens: 30_000,
  /** Bonus for keeping the lane and model already in use. */
  anchorBonus: 0.04,
  /** Utility gain required before the router leaves a healthy model group. */
  switchMargin: 0.04,
  /** Utility gain required before the router leaves a healthy lane. */
  laneSwitchMargin: 0.05,
  /** How long an explicit picker change is respected in auto mode. */
  userChoiceTtlMs: 30 * 60_000,
  /** Route subagent sessions too (off: their own model choice wins). */
  routeSubagents: false,
  /** Adopt a picker change as the new routing anchor. */
  adoptUserSelection: true,
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
  /** Load the priority report from this path on start; empty disables it. */
  reportPath: '',
}

export default DEFAULT_CONFIG
