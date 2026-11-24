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
import { CONNECTIVITY, COOLDOWN, ESCALATION, FAILURE_BURST, REQUEST_REPEAT, STRIKE_HALF_LIFE_MS, TOKEN_WINDOWS } from './policy-defaults.js'
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
  /**
   * 订阅/套餐不可用（LOCAL PATCH 2026-11-14）。
   *
   * 与 QUOTA 分开，因为处置与话术都不同：额度耗尽会自己回来（存到本地午夜），
   * 套餐/订阅问题要人去开通。旧的分类器两者都不认识，于是三天里让
   * qoder/qodercn（`{"pricingUrl":…} (112/model_error)`）与 cline
   * （`Error 403: the user is not subscribed to required model plan`）
   * 合计重试了 55 次，每次都只吃 30 秒的瞬时冷却，下一轮再撞同一堵墙。
   */
  PLAN: 'plan',
  UNAVAILABLE: 'unavailable',
  CONTEXT: 'context',
  TRANSIENT: 'transient',
  SLOW: 'slow',
  /** Our request was wrong — the lane is innocent and must not be cooled down. */
  REQUEST: 'request',
}

/** Failure kinds that mean "this lane cannot serve anything right now". */
const LANE_WIDE = new Set([KIND.QUOTA, KIND.PLAN, KIND.REGION, KIND.AUTH, KIND.UNAVAILABLE])

/**
 * Reason prefix that marks a verdict demoted from lane scope to model scope.
 *
 * 落在 reason 里而不是加一个字段：账本是一个 v1 的扁平 JSON，老进程读到多出来的
 * 字段会原样写回，但**判断**只认 status/until/scope 三件套；把「这条本来是车道级、
 * 因为 provider 是聚合体才降级」写进人读的 reason，既让面板的解释是实话，也让
 * load 时的自愈能重新认出它（见 healAggregator）。
 */
const AGGREGATOR_MARK = '〔聚合车道：仅本模型〕'

/** 故障域（连接层）整域短路的 reason 前缀；成功调用按它解除同渠道的兄弟停车。 */
const DOMAIN_DOWN_MARK = '〔整域短路〕'
/** 互借端点不可达的 reason 前缀（同一条解除规则）。 */
const PEER_ENDPOINT_MARK = '〔互借端点不可达〕'
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
const QUOTA_BUT_RATE_TEXT =
  /请稍后再试|稍后再试|稍候再试|均受限|受限，请|频率受限|限流|rate.?limit|too many requests|try again later|frequency limit|usage exceeds frequency/i
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
  /(?:改|换|使|试)用其[它他][^。；;，,\n]{0,16}?模型|试试其[它他]模型|switch(?:ing)? to (?:the )?(?:other|another) models?/i
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
/**
 * 线路问题（LOCAL PATCH 2026-11-04，A 侧实测断网事故）。
 *
 * 事故：WiFi 断了 3 分钟，探活把「Loomy 凭据探测网络失败：fetch failed」原样交给
 * 分类器，AUTH_TEXT 里的「凭据」命中（那是这条**链路的名字**，不是判决），于是
 * 整条 loomy lane 被判 auth、停 30 分钟——网络恢复后仍锁在原地。同一段断网在 B 侧
 * 是真实的 transport 文案，只吃 30 秒模型级冷却。
 *
 * 判据必须反过来问：「消息里有没有网络故障的证据」，而不是「有没有出现过凭据这个词」。
 * 真凭据失效（invalid api key / 401）不带任何网络词，故不受影响。
 */
const NETWORK_TEXT =
  /fetch failed|failed to fetch|network error|网络失败|网络错误|连不上上游|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|EPROTO|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|certificate|TLS|握手失败|连接被重置/i
/**
 * 其中更硬的一类：**端点本身不可达**（拒绝连接 / 域名解析失败 / 连接被重置）。
 *
 * 这一类失败证明的不是「某个模型坏了」，而是「这条路现在根本连不上」。对普通渠道
 * 它与线路抖动同义；对互借的聚合车道它意味着对侧整个端点没了——那时把判决降到模型级
 * 毫无意义（同一端点的几百条借入车道会在同一秒各自撞墙）。
 */
const NETWORK_CONNECT_TEXT =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|socket hang up|connect(?:ion)? (?:refused|reset)|connect ECONNREFUSED/i
/** 同样的判据，按 code 认：Node 的网络错误自带这些码，不必读文案。 */
const NETWORK_CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNABORTED',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EPROTO', 'UND_ERR_SOCKET',
])
const AUTH_TEXT = /unauthor|invalid api key|invalid credential|sign in|登录|凭据/i
/**
 * 「没登录」和「登录过期」是两种东西（LOCAL PATCH 2026-11-14）。
 *
 * 前者等多久都不会好——实测 2026-11-13：workbuddy 车道被判 auth、停 30 分钟，
 * 到期立刻被重新选中，然后在第一步就以 `未配置凭据，请先登录` 结束整轮
 * （`turn/end kind:error` 两次）。一个没人去点的登录框，冷却 30 分钟与冷却 12 小时
 * 的唯一区别就是"多久报一次同样的错"。
 *
 * 所以这一类单独认出来，按 {@link COOLDOWN.credential} 长停车，并在 reason 里
 * 说清楚要做什么。成功调用（用户登录后）会照常清账。
 */
const CREDENTIAL_MISSING_TEXT = /未配置凭据|未登录|请先登录|没有配置凭据|not (?:signed|logged) in|please (?:sign|log) in|no credentials? (?:configured|found|set)|missing (?:api key|credential)|api key (?:is )?missing|credentials? not configured/i
/**
 * 订阅/套餐不可用（LOCAL PATCH 2026-11-14）。见 {@link KIND.PLAN}。
 *
 * 分开两条是因为 qoder 的报错**没有任何一个 plan 词**：它只回一个
 * `{"pricingUrl":…} (112/model_error)`，指路到定价页；而 cline 是标准 403 +
 * "not subscribed to required model plan"。两条都要认出来。
 */
const PLAN_TEXT = /not subscribed|subscription (?:required|needed|expired|not active)|requires? (?:a )?(?:paid|pro|premium|team|enterprise) (?:plan|subscription)|pricingUrl|套餐|订阅|试用到期|续费/i
const PLAN_CODE_TEXT = /\(112\/model_error\)|"code"\s*:\s*112\b/i
/**
 * 模型退役/EOL（LOCAL PATCH 2026-11-20）。
 *
 * 实测：our-free-model 上游对 EOL 模型回 `The model '…' has reached its end of
 * life on 2026-11-16T08:00:00Z and is no longer available.`——没有任何旧规则认识
 * 这句话（`no longer available` 甚至会被 SERVER_TEXT 的 unavailable 蹭到），于是
 * 判成 30 秒 transient，一条永久死掉的模型每半小时回锅一次。EOL 是永久事实，
 * 按 COOLDOWN.retired 长停车；措辞刻意只认 end of life / retired / deprecated /
 * 已下线这类**明确宣告**，不认泛化的 "not available"（那可能只是临时维护）。
 */
const RETIRED_TEXT = /end of life|(?:model|it) (?:has been |is )?(?:retired|deprecated|sunset)|已退役|已下线|停止提供服务/i
/**
 * 需要付费积分/高级额度（LOCAL PATCH 2026-11-20）。
 *
 * 实测：free-pi 对高级模型回 403 `This model needs premium credits. Get premium
 * credits with /buy-credits…`。QUOTA_TEXT 的 credit 一词把它误判成**每日额度**
 * （停到本地午夜），于是天天回锅撞同一堵墙。它其实是 PLAN 语义：不买不会好，
 * 且同车道的免费模型不受影响，故按模型级停车。必须在 QUOTA 分支之前认出来。
 */
const PREMIUM_TEXT = /premium credits|buy-credits|needs? (?:a )?(?:paid|premium) (?:credits?|plan|subscription)|付费积分|高级额度/i
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
/**
 * 渠道签名门禁——“你这请求不是我们的客户端发的”（LOCAL PATCH 2026-11-24）。
 *
 * CodeBuddy 在 2026-10-21 起对社区客户端的请求返回 403
 * `Illegal API invocation from an unapproved channel`，WorkBuddy 另有一套
 * `request illegal / 账号存在异常行为` 文案。它既不是安全审核（不是内容问题），
 * 也不是额度（额度还在，同日同 model 其它账号能跑），更不是我们请求写错。
 *
 * 旧行为：文案没命中任何规则 → 掉进 transient 默认，只停 30 秒。于是「被风控拒」
 * 这件事每 30 秒重试一次，把风控喂得更大——measured：buddy 10-21 首次 10 次、
 * 11-03 起单日 35 次，一路到 11-24。签名门禁不会因为 30 秒而解除，
 * 所以按 PLAN 语义长停车（6 小时），并在 reason 里写清是签名问题而不是额度问题。
 */
const CHANNEL_SIGNATURE_TEXT = /unapproved channel|illegal api invocation|not an approved (?:channel|client)|unauthorized client|客户端签名|非法调用|账号存在异常行为|异常行为，已被限制/i
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

  // ── 渠道签名门禁：不是内容、不是额度、不是我们的请求写错（LOCAL PATCH 2026-11-24）──
  // 放在 SAFETY 之后、REQUEST 之前：正文里的 "illegal" 会让 REQUEST_CODES 的
  // 兜底读成「我们的请求错了」，而这类拒绝恰恰**与请求内容无关**——同一个请求换
  // 官方客户端签名就能过。车道级停车，因为拒的是这个渠道对我们这套客户端的识别，
  // 不是某一条模型。
  if (!authoritative && CHANNEL_SIGNATURE_TEXT.test(detail)) {
    return {
      kind: KIND.PLAN,
      // 6 小时而不是 PLAN 的 24 小时：这类门禁实测会自己解除（2026-11-24 复测
      // buddy 两个账号在完全相同的请求头下均返回 200），而 24 小时停车会让一条
      // 已经恢复的车道白停一天。6 小时足够让上游的风控窗口过期，又不会被
      // 30 秒级的重试喂大。
      cooldownMs: 6 * 60 * 60_000,
      scope: 'lane',
      reason: '渠道签名门禁（非额度、非内容）：' + (message === '' ? code : message.slice(0, 160)),
      retryable: false,
    }
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

  // ── 模型退役/EOL：永久事实，不是瞬时故障（LOCAL PATCH 2026-11-20）──────────
  // 放在 QUOTA/SERVER 之前：EOL 文案里的 "no longer available" 会被 SERVER_TEXT
  // 蹭成 transient。权威码优先的原则不变——适配器自己报了结构化判决时不读文案。
  if (code === 'MODEL_RETIRED' || (!authoritative && RETIRED_TEXT.test(detail))) {
    return {
      kind: KIND.UNAVAILABLE,
      cooldownMs: COOLDOWN.retired,
      scope: 'model',
      reason: '模型已退役/EOL（长期停车，复活需一次成功调用证明）：' + (message === '' ? code : message.slice(0, 160)),
      retryable: false,
    }
  }

  // ── 付费积分/高级额度：PLAN 语义，不是每日额度（LOCAL PATCH 2026-11-20）────
  // 必须在 QUOTA 之前：free-pi 的 `needs premium credits` 带着 credit 一词，
  // 落进 QUOTA_TEXT 就被停到午夜、天天回锅。同车道免费模型不受影响 → 模型级。
  if (!authoritative && PREMIUM_TEXT.test(detail)) {
    return {
      kind: KIND.PLAN,
      cooldownMs: COOLDOWN.plan,
      scope: 'model',
      reason: '需要付费积分/高级额度（购买或改用免费模型才恢复）：' + (message === '' ? code : message.slice(0, 160)),
      retryable: false,
    }
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

  // ── 线路问题先于凭据问题（LOCAL PATCH 2026-11-04）──────────────────────────
  // 顺序就是判决：同一个字符串「凭据探测网络失败：fetch failed」既是「凭据」也是
  // 「网络」。凭据失效是账号层面的长期状态（值得停 30 分钟、值得整条车道停），
  // 网络抖动不是（30 秒、模型级，下一轮自己会好）。把更短、更可自愈的那个判在前面，
  // 误判的代价就从「锁死半小时」降到「浪费半分钟」。
  //
  // 权威码仍然优先：适配器自己报 TRANSPORT/TIMEOUT 时由下面的分支处理，
  // 这里只接管「没有结构化判决、只能读文案」的失败（探活就属于这一类）。
  const connectCode = NETWORK_CONNECT_CODES.has(code)
  if (connectCode || (!authoritative && NETWORK_TEXT.test(detail))) {
    const connectivity = connectCode || NETWORK_CONNECT_TEXT.test(detail)
    return {
      kind: KIND.TRANSIENT,
      cooldownMs: Math.min(COOLDOWN.transient * 1.5 ** strikes, COOLDOWN.transientMax),
      scope: 'model',
      connectivity,
      reason: '线路问题（非凭据）：' + (message === '' ? code : message.slice(0, 200)),
      retryable: true,
    }
  }

  // ── 订阅/套餐：不是额度、不是凭据，是「这个模型你没买」（LOCAL PATCH 2026-11-14）──
  // 放在 AUTH 之前：cline 的 `Error 403: the user is not subscribed…` 带着 403，
  // 而 403 那条分支会把它判成凭据问题（30 分钟冷却 + 升级），处置反而更松。
  if (PLAN_CODE_TEXT.test(detail) || byText(PLAN_TEXT) || /not subscribed/i.test(detail)) {
    return {
      kind: KIND.PLAN,
      cooldownMs: COOLDOWN.plan,
      scope: 'lane',
      reason: '需要订阅/套餐不可用：' + (message === '' ? code : message.slice(0, 160)),
      retryable: false,
    }
  }

  // ── 「没登录」先于「凭据失效」：处置时间差 24 倍（LOCAL PATCH 2026-11-14）─────
  if (CREDENTIAL_MISSING_TEXT.test(detail)) {
    return {
      kind: KIND.AUTH,
      cooldownMs: COOLDOWN.credential,
      scope: 'lane',
      credentialMissing: true,
      reason: '该渠道未配置凭据（登录后才会恢复）：' + (message === '' ? code : message.slice(0, 160)),
      retryable: false,
    }
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
      cooldownMs: Math.min(COOLDOWN.transient * 2 ** strikes, COOLDOWN.transientMax),
      scope: 'model',
      reason: message === '' ? '请求超时' : message.slice(0, 200),
      retryable: true,
    }
  }

  if (code === 'SERVER' || code === 'TRANSPORT' || byText(SERVER_TEXT)) {
    return {
      kind: KIND.TRANSIENT,
      cooldownMs: Math.min(COOLDOWN.transient * 2 ** strikes, COOLDOWN.transientMax),
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
  return {
    calls: 0,
    errors: 0,
    inTok: 0,
    outTok: 0,
    // 缓存重读的输入（单价通常比新增输入低一个数量级，但不为零）。实测里它区分度极高：
    // 同一段时间 trae 的 cacheRead = 0、loomy = 11 亿 —— 「每次全量重发上下文」的车道
    // 看起来倍率很便宜，实际把免费额度吃得最快（FIX 2026-11-16）。
    cacheReadTok: 0,
    ttftSum: 0,
    ttftN: 0,
    ttftEwma: 0,
    tpsSum: 0,
    tpsN: 0,
  }
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
 * @param {{userDir: string|null, clock?: () => number, persistMs?: number,
 *   requestPolicy?: () => object, isAggregator?: (provider: string) => boolean}} options
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
  /**
   * Whether a provider id is an **aggregator** rather than a real channel.
   *
   * 互借车道（provider 名 = peerShare.peerProvider）就是这样一条：它下面挂的是对侧
   * 几百个模型，本机并不拥有它。对真实渠道而言「这条车道不能服务」是准确的话——一条
   * cline 402 意味着 cline 这条路断了；但对聚合车道，同一句话意味着「对侧那几百个
   * 模型全部断掉」，而那从来不是一次失败能证明的事（实测 2026-11-03：一个
   * xiaomi/mimo-v2.6-pro 的 402 把 10 条借来的 deepseek-v4.1-flash 一起停车到午夜，
   * 而同一个中继上的 buddy/deepseek-v4.1-flash 当时是活的）。
   *
   * 所以聚合车道上的判决一律降为模型级：失败的那个模型冷却，兄弟模型照常参战。
   */
  const isAggregator = typeof options.isAggregator === 'function' ? options.isAggregator : () => false

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
      record = {
        provider: key,
        status: KIND.OK,
        until: 0,
        reason: '',
        strikes: 0,
        lastAt: 0,
        // 故障域（连接层）连败计数与时间戳，见 markFailure 的整域短路段。
        connectStrikes: 0,
        connectAt: 0,
        counters: emptyCounters(),
      }
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
        // Last failure kind and when it arrived, for burst deduplication: five
        // concurrent sessions hitting one wall must not strike five times.
        lastKind: '',
        lastKindAt: 0,
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
    if (lane !== undefined && lane.until > now
      && (LANE_WIDE.has(lane.status) || lane.endpointDown === true)) {
      return {
        status: lane.status,
        available: false,
        until: lane.until,
        reason: lane.reason,
        scope: 'lane',
        endpointDown: lane.endpointDown === true,
        strikes: laneStrikes,
      }
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

  /**
   * Lane-wide verdicts on an aggregator provider become model-scoped.
   *
   * 聚合车道（互借）下面挂的是对侧的全部模型，一次失败只证明**那一个模型**在对侧
   * 不可用：cline 的 402 是 mimo 的额度，不是「对侧所有模型都死了」。降级时把原始
   * scope 写进 reason 前缀，落盘后由 {@link healAggregator} 在下次加载时照样认得。
   *
   * @param {string} provider
   * @param {object} verdict - output of classifyFailure
   * @returns {object} the verdict the ledger will actually apply
   */
  /**
   * 探活的判决必须比真实调用更轻（LOCAL PATCH 2026-11-04）。
   *
   * 探活是插件自己发的 8 token 心跳，不是用户的一次请求。它的失败最多说明「这一刻这条
   * 路不通」，而它出现的时机是**定时器排的**，不是用户需要它的时候——A 侧事故正是如此：
   * 断网那 3 分钟里定时探活恰好砸在 loomy 上，把一条正在出字的车道停到 01:08。
   *
   * 所以：探活失败一律模型级、且冷却不超过 transient 的两倍。真正的凭据失效/额度耗尽
   * 会在用户的下一次真实请求上再次出现，那时再按重判决处理，代价只是晚一步。
   */
  function capProbeVerdict(failure, verdict) {
    if (String(failure?.purpose ?? '') !== 'probe') return verdict
    const cap = COOLDOWN.transient * 2
    const kind = verdict.kind
    // 上下文与自身请求错误与车道健康无关，保持原样。
    if (kind === KIND.CONTEXT || kind === KIND.REQUEST) return verdict
    return {
      ...verdict,
      scope: 'model',
      cooldownMs: Math.min(verdict.cooldownMs > 0 ? verdict.cooldownMs : cap, cap),
      probeCapped: true,
      reason: '〔探活〕' + verdict.reason,
    }
  }

  function demoteOnAggregator(provider, verdict) {
    if (verdict === null || verdict === undefined) return verdict
    if (verdict.kind === KIND.CONTEXT) return verdict
    if (isAggregator(provider) !== true) return verdict
    // ── 方向一：端点本身不可达 ⇒ 升回车道级（整片下线）────────────────────
    // 降级的理由是「一个模型的失败证明不了对侧几百个模型都死了」。但连接层失败根本不
    // 是在说某个模型：ECONNREFUSED 说的是**这个端口上没有监听**。互借的几百条借入车道
    // 共用同一个 base URL（src/peershare-adapter.js 一个 provider 一个端点），所以
    // 端点不可达恰恰是「整片都不可用」的严格证明——此时留在模型级，等于让路由在同
    // 一个死端口上把 3 次换道预算烧光、整轮失败（2026-11-04 00:09 实测三连）。
    if (verdict.connectivity === true) {
      return {
        ...verdict,
        scope: 'lane',
        endpointDown: true,
        domainDown: true,
        reason: PEER_ENDPOINT_MARK + verdict.reason,
      }
    }
    // ── 方向二：其它车道级判决照旧降为模型级 ───────────────────────────────
    if (verdict.scope !== 'lane') return verdict
    return {
      ...verdict,
      scope: 'model',
      demoted: true,
      reason: AGGREGATOR_MARK + verdict.reason,
    }
  }

  /**
   * 同类连败的冷却上限（每类各不相同）。
   *
   * 上限必须存在：一条**永久**不通的车道（域名没了、套餐没买）不该被升级成
   * 「永远不选」——那只能靠 probe 或用户的显式操作发现它回来了，而账本没有那条通路。
   * 所以升级到上限即停，剩下的交给衰减与成功调用清账。
   */
  function cooldownCapFor(kind) {
    if (kind === KIND.AUTH || kind === KIND.SAFETY) return Math.max(COOLDOWN.auth, COOLDOWN.authMax)
    if (kind === KIND.PLAN) return Math.max(COOLDOWN.plan, COOLDOWN.authMax)
    if (kind === KIND.QUOTA) return 24 * 60 * 60_000
    if (kind === KIND.REGION) return COOLDOWN.region
    if (kind === KIND.UNAVAILABLE) return COOLDOWN.unavailable
    if (kind === KIND.RATE) return COOLDOWN.rateMax
    return COOLDOWN.transientMax
  }

  /**
   * 同一条路线上「同一种病」连着犯时的冷却升级（LOCAL PATCH 2026-11-14）。
   *
   * 与 FAILURE_BURST 的去重刻意分开：去重管的是「同一件事被报了两次」（5 秒窗口，
   * 不延长冷却），升级管的是「同一件事一次又一次发生」（30 分钟窗口，按倍数延长）。
   *
   * 为什么必须有：各类冷却都是常数，而 strikes 按 3 小时半衰期衰减——一条每半小时
   * 失败一次的车道，每次失败时衰减后的 strikes 都贴近 0，于是它的冷却永远停在初始值，
   * 永远在同一个节奏上回锅。日志里这就是 trae/qoder 的 transport failed 被选中 48/39 次。
   */
  function escalateCooldown(record, verdict, now) {
    const base = Math.max(0, Number(verdict.cooldownMs ?? 0))
    const previous = String(record.sameKind ?? '')
    const previousAt = Number(record.sameKindAt ?? 0)
    const run = previous === verdict.kind && previousAt > 0 && now - previousAt <= ESCALATION.windowMs
      ? Number(record.sameKindRun ?? 1) + 1
      : 1
    const enabled = requestPolicy().sameKindEscalation !== false
    if (!enabled || base <= 0 || run < ESCALATION.minRun) return { cooldownMs: base, run }
    const factor = Math.min(ESCALATION.maxFactor, ESCALATION.factor ** Math.min(run - 1, 8))
    // 升级只能延长、不能缩短（LOCAL PATCH 2026-11-20）：旧式 Math.min(cap, base×factor)
    // 在 base 大于 cap 时会把冷却**砍到 cap**——EOL 的 7 天停车连犯两次就变 10 分钟。
    return { cooldownMs: Math.max(base, Math.min(cooldownCapFor(verdict.kind), base * factor)), run }
  }

  /** Apply one failure to the ledger and return the verdict. */
  function markFailure(provider, model, failure, meta = {}) {
    const now = clock()
    const lane = laneRecord(provider)
    const record = modelRecord(provider, model)
    let verdict = capProbeVerdict(failure,
      demoteOnAggregator(provider, classifyFailure(failure, { strikes: record.strikes, now })))

    // ── 故障域短路：连接层失败是「端点到不了」，不是「这个模型不行」（FIX 2026-11-16）──
    //
    // 实测形状：一次会话里 45 秒内 6 次 switch-budget-exhausted，全部撞在同一个
    // cline ECONNRESET 上 —— 每一次都换到同一条死线路的另一个模型，8 次换道预算烧光，
    // 整轮以错误收场。连接失败在**渠道层**是同一个事实：这个 base URL 此刻不通。
    //
    // 判据刻意要 3 次而不是 1 次：单次连接抖动（代理偶发 reset）不值得整域下车。
    // 达到阈值后升为车道级 + endpointDown，该渠道的全部模型一起退出候选（stateOf 认这两条），
    // 冷却短（60 秒）且一次成功调用即可解除 —— 与「凭据/套餐」那种需要人介入的停车不同。
    if (verdict.connectivity === true && verdict.scope !== 'lane') {
      const inWindow = Number(lane.connectAt ?? 0) > 0
        && now - Number(lane.connectAt) <= CONNECTIVITY.windowMs
      lane.connectStrikes = inWindow ? Number(lane.connectStrikes ?? 0) + 1 : 1
      lane.connectAt = now
      if (lane.connectStrikes >= CONNECTIVITY.strikes) {
        verdict = {
          ...verdict,
          cooldownMs: CONNECTIVITY.cooldownMs,
          scope: 'lane',
          endpointDown: true,
          domainDown: true,
          reason: DOMAIN_DOWN_MARK + lane.connectStrikes + ' 次连接失败/'
            + Math.round(CONNECTIVITY.windowMs / 1000) + 's：' + verdict.reason,
        }
      }
    }

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
      const windowMs = Number.isFinite(Number(policy.requestRepeatWindowMs))
        ? Math.max(60_000, Math.round(Number(policy.requestRepeatWindowMs)))
        : REQUEST_REPEAT.windowMs
      const threshold = Number.isFinite(Number(policy.requestRepeatThreshold))
        ? Math.max(1, Math.round(Number(policy.requestRepeatThreshold)))
        : REQUEST_REPEAT.threshold
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
      // 「显式写下的 0」与「没写」必须分开（FIX 2026-11-16）：README 承诺
      // requestRepeatBlockMs: 0 = 只换渠道、不暂停，而 Number(x) || fallback 把合法的
      // 0 当 falsy，于是用户设了 0 仍然被停 30 分钟——配置面在说谎。
      const blockMs = Number.isFinite(Number(policy.requestRepeatBlockMs))
        ? Math.max(0, Math.round(Number(policy.requestRepeatBlockMs)))
        : REQUEST_REPEAT.blockMs
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

    // ── failure-burst deduplication (LOCAL PATCH 2026-10-26) ────────────────
    //
    // Concurrent sessions that hit the same wall report one failure each. Every
    // one of them used to add a strike, so five parallel 429s on one lane made
    // five strikes and an exponential cooldown (20 s → 300 s) out of a single
    // upstream event — measured 2026-10-26: the second failure of a burst took
    // the cooldown from 60 s to 16 min.
    //
    // The rule is deliberately narrow: same *kind*, same route, inside
    // failureBurstWindowMs. A different kind on the same route is real news
    // (429 then 401 means the key died mid-burst), and the same kind on another
    // route is another lane's problem.
    const burstWindowMs = Math.max(0, Number(requestPolicy().failureBurstWindowMs ?? FAILURE_BURST.windowMs))
    const burst = burstWindowMs > 0
      && record.lastKind === verdict.kind
      && record.lastKindAt > 0
      && now - record.lastKindAt <= burstWindowMs
    record.lastKind = verdict.kind
    record.lastKindAt = now
    record.lastAt = now
    record.counters.errors += 1
    record.status = verdict.kind
    record.reason = verdict.reason

    // What the caller is told to wait. Set by the escalation branch below; on a
    // burst the ledger keeps the deadline it already booked (see the comment).
    let effectiveCooldownMs = Math.max(0, Number(verdict.cooldownMs ?? 0))

    if (burst) {
      // Same event, reported twice. Neither the strike nor the deadline may
      // move: the classifier derives its backoff from the strike count, so a
      // burst report would otherwise *escalate* the very cooldown the
      // deduplication exists to protect (measured: 20 s → 40 s on the second
      // report of one wall). The first verdict already booked the deadline, and
      // a live cooldown must never be shortened by a later, milder report
      // either — so it is simply left alone.
      effectiveCooldownMs = Math.max(0, Number(record.until ?? 0) - now)
    } else {
      record.strikes += 1
      record.strikesAt = now
      // 同类连败升级（见 escalateCooldown）。记录写在 model 记录上，因为它是
      // 「这条路线上的这个病」的证据；车道级停车由下面那一段用同一个 until 兜住。
      const escalated = escalateCooldown(record, verdict, now)
      record.sameKind = verdict.kind
      record.sameKindRun = escalated.run
      record.sameKindAt = now
      record.lastCooldownMs = escalated.cooldownMs
      record.sameKindEscalated = escalated.cooldownMs > Math.max(0, Number(verdict.cooldownMs ?? 0))
      record.until = escalated.cooldownMs > 0 ? now + escalated.cooldownMs : 0
      effectiveCooldownMs = Math.max(0, record.until - now)
    }

    const bucket = bucketFor(provider, model)
    bucket.errors += 1

    // 车道级计数此前没有任何递增点（实测 15 条 lane 记录的 errors 全是 0，inTok/outTok 也全是 0），
    // 面板的「渠道」页因此永远显示 0 —— 字段存在但语义为 0 比没有字段更坏（FIX 2026-11-16）。
    lane.counters.errors += 1
    lane.lastAt = now

    if (verdict.scope === 'lane') {
      lane.status = verdict.kind
      lane.reason = verdict.reason
      lane.until = Math.max(lane.until, record.until)
      if (verdict.endpointDown === true) lane.endpointDown = true
      if (!burst) lane.strikes += 1
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
    // 长停车即时落盘（LOCAL PATCH 2026-11-20）。15 秒节流对短冷却是对的（失败路径
    // 上一步最多 7 次全量写，见 index.js recover 的 FIX 注释），但 ≥30 分钟的停车
    // 是**稀有事件**（一天几次），丢在硬杀里的代价是「重启后重撞同一堵墙」——
    // EOL/套餐/凭据这类墙撞一次就是一次真实请求浪费。只豁免长停车，短冷却仍走节流。
    if (effectiveCooldownMs >= 30 * 60_000) persist()
    // The returned cooldown must be the one that is actually in effect — after
    // escalation, and (on a burst report) the deadline the ledger already holds,
    // not the fresh backoff derived from the now-higher strike count.
    return { ...verdict, cooldownMs: effectiveCooldownMs, burst, lane: String(provider), model: String(model), ...meta }
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
    // 一次成功就是「这条线路此刻通」的证据：故障域连败清零（FIX 2026-11-16）。
    lane.connectStrikes = 0
    lane.connectAt = 0
    // And it ends a failure burst: the next failure is a fresh event and must
    // earn its own strike (see markFailure's burst deduplication).
    record.lastKind = ''
    record.lastKindAt = 0
    // 也结束同类连败：下一次失败重新从基础冷却算起（否则一条车道会永远背着
    // 上次的升级倍数，成功一次也翻不了身）。
    record.sameKind = ''
    record.sameKindRun = 0
    record.sameKindAt = 0
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
    if (Number.isFinite(observation.cacheReadTokens)) record.counters.cacheReadTok += Math.max(0, observation.cacheReadTokens)

    const bucket = bucketFor(provider, model)
    bucket.in += Number.isFinite(input) ? input : 0
    bucket.out += Number.isFinite(output) ? output : 0
    bucket.calls += 1

    lane.counters.calls += 1
    lane.counters.inTok += Number.isFinite(input) ? input : 0
    lane.counters.outTok += Number.isFinite(output) ? output : 0
    if (Number.isFinite(observation.ttftMs) && observation.ttftMs > 0) {
      lane.counters.ttftSum += observation.ttftMs
      lane.counters.ttftN += 1
    }
    lane.lastAt = now
    // 一次成功的调用就是「端点还活着」的证明：聚合车道的 endpointDown 必须就地清掉，
    // 否则对侧恢复之后本机仍在整片跳过借入车道（LOCAL PATCH 2026-11-04）。
    if (lane.endpointDown === true) {
      lane.endpointDown = false
      if (LANE_WIDE.has(lane.status)) {
        lane.status = KIND.OK
        lane.reason = ''
        lane.until = 0
      }
    }
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
    // 故障域短路留下的停车也要一起解除（FIX 2026-11-16）。
    //
    // 整域短路的判决是 TRANSIENT（分钟级、可自愈），而 TRANSIENT **不在** LANE_WIDE 里——
    // 于是上面那段「车道级判决要连兄弟一起放」的分支管不到它：一次成功调用解除了 lane 的
    // endpointDown，同一渠道的兄弟模型却还各自背着 60 秒的停车。判据只看 reason 前缀：
    // 只有「由故障域判决写下的」记录才清，别的瞬时冷却（我们自己的抖动）不动。
    if (lane.endpointDown !== true) {
      for (const sibling of models.values()) {
        if (sibling.provider !== provider) continue
        if (sibling === record) continue
        const reason = String(sibling.reason ?? '')
        if (!reason.startsWith(DOMAIN_DOWN_MARK) && !reason.startsWith(PEER_ENDPOINT_MARK)) continue
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

  /**
   * 端点恢复的显式信号（LOCAL PATCH 2026-11-04）。
   *
   * 借入车道的「端点不可达」不能只靠一次成功的模型调用解除：对侧恢复后，本机的第一条
   * 请求恰恰会因为**整片被跳过**而永远不会发出——没人调用它，就没人证明它活着。
   * 所以清单刷新成功时由调用方显式通知一次（见 index.js 的 refreshBorrowedCatalog）。
   *
   * @param {string} provider
   * @returns {boolean} whether anything was lifted
   */
  function clearEndpointDown(provider) {
    const lane = lanes.get(laneKey(provider))
    if (lane === undefined || lane.endpointDown !== true) return false
    lane.endpointDown = false
    if (LANE_WIDE.has(lane.status) && lane.status === KIND.TRANSIENT) {
      lane.status = KIND.OK
      lane.reason = ''
      lane.until = 0
    }
    dirty = true
    return true
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
      // 实测用量口径（FIX 2026-11-16）：每次成功调用平均吃掉多少输入/输出 token，
      // 以及缓存重读占输入的比例。路由用它修正「从模型名刮出来的倍率」。
      tokensPerCall: counters.calls > 0
        ? { in: counters.inTok / counters.calls, out: counters.outTok / counters.calls }
        : null,
      cacheReuse: counters.inTok > 0 ? counters.cacheReadTok / counters.inTok : null,
      cacheReadTokens: counters.cacheReadTok,
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
        // 车道级的真实累计 token（2026-11-16 起真正被写入；此前 markSuccess 只加 calls，
        // 于是面板的渠道页永远显示 0）。与 windows 里的滚动窗口是两回事：这是全寿命。
        tokens: { in: record.counters.inTok, out: record.counters.outTok },
        ttftMs: record.counters.ttftN > 0 ? Math.round(record.counters.ttftSum / record.counters.ttftN) : null,
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
      }, { pretty: false })
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
    /**
     * 聚合车道的历史车道级停车（2026-11-03）。
     *
     * 旧分类器把「一个模型的额度问题」写成车道级 verdict，而互借车道的 lane 记录
     * 一旦带 QUOTA/REGION/AUTH/UNAVAILABLE，stateOf() 就会把**对侧所有模型**判成不可用
     * ——实测 B 侧因此把 10 条活着的借入车道停到午夜。这里在加载时把这些记录降回模型级：
     *  - 车道记录：直接清掉（车道本身不该持有这种判决）；
     *  - 模型记录：保留自己的冷却，但 reason 打上标记，面板解释才是实话。
     *
     * 判据刻意保守：只动聚合 provider 的记录，真实渠道的历史停车一个字节都不碰。
     *
     * 两条分支的区别就在 reason 前缀上——那是唯一能区分「降级后的模型级冷却」和
     * 「旧代码泼过来的车道级停车」的信息：
     *  - 带标记：是 v2.6.1 写的模型级冷却，**保留**（那个模型确实坏了）；
     *  - 不带标记却是车道级状态：旧代码把一条车道判决复制到了每个兄弟模型上，
     *    它从来没描述过这个模型，**清掉**。
     * 车道记录两种情况下都不该持有车道级判决（聚合车道的 lane 根本不是一条渠道）。
     */
    function healAggregator(record, isLane) {
      if (isAggregator(record.provider) !== true) return { lift: false }
      const marked = String(record.reason ?? '').startsWith(AGGREGATOR_MARK)
      if (isLane) return { lift: record.until > now && LANE_WIDE.has(record.status) }
      if (marked) return { lift: false }
      return { lift: record.until > now && LANE_WIDE.has(record.status) }
    }

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
      if (healAggregator(record, false).lift) {
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
      if (healAggregator(record, true).lift) {
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
  function prune(liveProviders, liveKeys = null, now = clock(), maxAgeMs = 24 * 60 * 60_000) {
    const live = new Set(liveProviders)
    const keys = liveKeys === null || liveKeys === undefined || liveKeys.length === 0
      ? null
      : new Set(liveKeys)
    for (const [key, record] of [...models.entries()]) {
      const provider = key.split('\u0000')[0]
      const served = Number(record?.counters?.calls ?? 0) > 0
      if (!live.has(provider) && now - Number(record.lastAt ?? 0) > maxAgeMs) {
        models.delete(key)
        buckets.delete(key)
      }
    }
    for (const [key, record] of [...lanes.entries()]) {
      if (!live.has(key) && now - Number(record.lastAt ?? 0) > maxAgeMs) lanes.delete(key)
    }

    // ── 幽灵记录清理（FIX 2026-11-16）────────────────────────────────────────
    //
    // 实测：health.json 611KB / 569 条 model 记录，其中 444 条**一次请求都没成功过**
    // （cline 一家占 395 条）。来源是定时探活与车道级判决的扇出：探活会遍历目录里每一条
    // provider×model（本机 751 条），失败一次就落一条永久记录；而旧的 prune 只在
    // 「provider 从清单里消失」时才删，同在清单内的幽灵记录永不回收。
    //
    // 判据分三档，都只动「从未成功服务过」的记录（calls === 0）：
    //   1. 清单里已经没有这个 id → 立刻清（探活留下的幽灵）；
    //   2. 从未成功且超过 72 小时没有任何动静 → 清（覆盖一轮探活间隔 3 天）；
    //   3. 仍然超量时按渠道与全局设上限，先清最旧的幽灵。
    // 只要这条记录成功服务过一次（calls > 0），它就走上面那条「闲置 24 小时」的老规则 ——
    // 真实流量的历史不能被这条清理顺手抹掉。
    const ghostMaxAgeMs = 72 * 60 * 60_000
    const drop = (key) => {
      models.delete(key)
      buckets.delete(key)
    }
    for (const [key, record] of [...models.entries()]) {
      const provider = key.split('\u0000')[0]
      if (Number(record?.counters?.calls ?? 0) > 0) continue
      const lastAt = Number(record?.lastAt ?? 0)
      if (keys !== null && !keys.has(key) && live.has(provider)) {
        drop(key)
        continue
      }
      if (now - lastAt > ghostMaxAgeMs) drop(key)
    }

    // 每渠道的幽灵上限：探活一轮可能给一个渠道写几百条，面板与落盘都不需要那么多。
    const GHOSTS_PER_PROVIDER = 40
    const MAX_MODEL_RECORDS = 400
    const ghostsByProvider = new Map()
    for (const [key, record] of models.entries()) {
      if (Number(record?.counters?.calls ?? 0) > 0) continue
      const provider = key.split('\u0000')[0]
      const list = ghostsByProvider.get(provider) ?? []
      list.push(key)
      ghostsByProvider.set(provider, list)
    }
    for (const list of ghostsByProvider.values()) {
      if (list.length <= GHOSTS_PER_PROVIDER) continue
      list.sort((a, b) => Number(models.get(b)?.lastAt ?? 0) - Number(models.get(a)?.lastAt ?? 0))
      for (const key of list.slice(GHOSTS_PER_PROVIDER)) drop(key)
    }
    if (models.size > MAX_MODEL_RECORDS) {
      const spare = [...models.entries()]
        .filter(([, record]) => Number(record?.counters?.calls ?? 0) === 0)
        .sort((a, b) => Number(a[1]?.lastAt ?? 0) - Number(b[1]?.lastAt ?? 0))
      for (const [key] of spare) {
        if (models.size <= MAX_MODEL_RECORDS) break
        drop(key)
      }
    }
  }

  return {
    KIND,
    classifyFailure,
    stateOf,
    markFailure,
    clearEndpointDown,
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
