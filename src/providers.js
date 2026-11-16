/**
 * 渠道计费与信任声明层（LOCAL PATCH 2026-11-16）。
 *
 * 为什么要有这一层：`catalog.js` 里的 `laneMultiplier` / `laneIsFree` 从模型**显示名**
 * 的 `· x0.2` / `· 免费` 尾巴里猜价格。那套约定只对旧的 free-model 车队成立——那些
 * 插件的展示名刻意带倍率。新接入的两类渠道语义不同：
 *
 *   free-pi     无限档不消耗日预算（`· Free Unlimited`），但同渠道上还有 x22 / x37 的
 *               按倍率模型，所以**不能**把整条渠道一律当免费；
 *   freellmapi  本地路由器，7 个免密钥上游轮转，332 个模型**名字里根本没有价格尾巴**，
 *               猜不到就落 1.0（全价），于是 economy 策略永远不选它们——方向正好反了。
 *
 * 规则一句话：**名字里有价格就用名字，名字里没有才用渠道声明。** 没被声明的渠道走
 * 原来的逻辑，行为与改动前逐位相同（零回归）。
 *
 * @module src/providers
 */

/** 计费语义。 */
export const BILLING = {
  /** 额度与用量无关：用多少都不影响可用性（free-pi 的无限档）。 */
  UNLIMITED: 'unlimited',
  /** 免费但有额度上限：用多了会被限流，但不要钱。 */
  FREE: 'free',
  /** 按倍率真花钱：用量与 strikes 惩罚都要照常算。 */
  METERED: 'metered',
}

/**
 * 内置渠道声明。
 *
 * 字段含义：
 *   billing       计费语义（见 BILLING）
 *   burn          该渠道的燃烧基准 0..1，越小越便宜；仅在该渠道的模型名**没有**价格
 *                 尾巴时使用（名字有价格时以名字为准）
 *   ttftPriorMs   首字延迟先验。新渠道没有 live 样本，旧代码给它一个全局 0.5 的中性
 *                 分；有了实测先验才能和已有渠道公平比较，否则「刚接入 = 永远倒数」
 *   note          人看的说明（写进面板与日志）
 */
export const PROVIDER_PROFILES = {
  'free-pi': {
    billing: BILLING.UNLIMITED,
    burn: 0.02,
    ttftPriorMs: 2200,
    note: '广告资助免费推理；无限档不消耗日预算（实测 4 档 1.2–5.1s 出字）',
  },
  freellmapi: {
    billing: BILLING.FREE,
    burn: 0.05,
    ttftPriorMs: 3000,
    note: '本地 OpenAI 兼容路由器，7 个免密钥上游轮转（多一跳，故延迟先验放宽）',
  },
}

/** 渠道 id 归一化：大小写与首尾空白不参与匹配。 */
function normalize(provider) {
  return String(provider ?? '').trim().toLowerCase()
}

/**
 * 取一条渠道的声明。`overrides` 允许用户在配置里覆盖或新增（`providerProfiles`），
 * 覆盖是**整体替换**该渠道的那一条，不做字段级合并——与 profile 补丁的语义保持一致。
 *
 * @param {string} provider
 * @param {object} [overrides] - 形如 `{ 'free-pi': { billing, burn, ttftPriorMs } }`
 * @returns {{billing: string, burn: number, ttftPriorMs: number|null, note: string, id: string}|null}
 */
export function profileFor(provider, overrides = undefined) {
  const id = normalize(provider)
  if (id === '') return null
  const table = overrides !== null && typeof overrides === 'object' ? overrides : null
  let entry
  if (table !== null) {
    for (const [key, value] of Object.entries(table)) {
      if (normalize(key) !== id) continue
      entry = value
      break
    }
  }
  if (entry === undefined) entry = PROVIDER_PROFILES[id]
  if (entry === undefined || entry === null) return null
  const billing = [BILLING.UNLIMITED, BILLING.FREE, BILLING.METERED].includes(entry.billing)
    ? entry.billing
    : BILLING.METERED
  const burn = Number(entry.burn)
  const ttft = Number(entry.ttftPriorMs)
  return {
    id,
    billing,
    burn: Number.isFinite(burn) ? Math.min(1, Math.max(0, burn)) : 0.45,
    ttftPriorMs: Number.isFinite(ttft) && ttft > 0 ? ttft : null,
    note: typeof entry.note === 'string' ? entry.note : '',
  }
}

/** 显示名里是否真的带价格信息（`·` 之后那一截）。 */
export function hasPriceTail(modelName) {
  return String(modelName ?? '').lastIndexOf('·') !== -1
}

/**
 * 决定一条 lane 的燃烧值与「无限额度」标记。
 *
 * @param {object} input
 * @param {string} input.provider
 * @param {string} input.modelName - 展示名，可能带 `· x0.2` 尾巴
 * @param {number} input.tagCost - families 标签推出的燃烧基准（costFactor 的结果）
 * @param {number} input.multiplier - 名字尾巴解析出的倍率（laneMultiplier 的结果）
 * @param {boolean} input.freeLane - 名字是否声明免费（laneIsFree 的结果）
 * @param {object} [input.overrides] - 用户覆盖的 `providerProfiles`
 * @returns {{burn: number, unlimited: boolean, source: 'name'|'provider', profile: object|null}}
 */
export function resolveBilling(input) {
  const tagCost = Number.isFinite(input.tagCost) ? input.tagCost : 0.45
  const multiplier = Number.isFinite(input.multiplier) ? input.multiplier : 1
  const freeLane = input.freeLane === true
  const profile = profileFor(input.provider, input.overrides)
  const named = hasPriceTail(input.modelName)
  // 名字明说「倍率 >1」：即使在无限档渠道上，这个模型也是真花钱的（free-pi 的
  // kimi-k3.1-pro ~x22、qwen3.6-plus ~x37）。必须按倍率计，且不算无限额度，
  // 否则调度器会把日预算烧在这种模型上。
  const meteredByName = named && !freeLane && multiplier > 1 + 1e-9
  if (meteredByName) {
    return { burn: Math.min(1, tagCost * multiplier), unlimited: false, source: 'name', profile }
  }
  if (named && freeLane) {
    const unlimited = profile !== null && profile.billing === BILLING.UNLIMITED
    return { burn: tagCost * multiplier * 0.6, unlimited, source: 'name', profile }
  }
  if (profile !== null && profile.billing !== BILLING.METERED) {
    return {
      burn: Math.min(tagCost, profile.burn),
      unlimited: profile.billing === BILLING.UNLIMITED,
      source: 'provider',
      profile,
    }
  }
  // 无名无声明：与改动前完全一致。
  return { burn: tagCost * multiplier * (freeLane ? 0.6 : 1), unlimited: false, source: 'name', profile }
}
