/**
 * Model-family identity: turn any lane's model id into the family the priority
 * report scores, and describe what that family is good at.
 *
 * Why this exists: 162 advertised models are only 76 families. `glm-5.3` is the
 * same weights on six lanes — same intelligence, different quota and latency.
 * Intelligence therefore belongs to the family, and everything the router
 * decides per lane (health, quota, speed) belongs to the lane. Without this
 * split the router would rank `sn-glm-5-3` and `gmodel` as unrelated models.
 *
 * @module src/families
 */

/**
 * Vendor namespaces the free lanes prefix onto their model ids.
 *
 * LOCAL PATCH 2026-10-16 (cline): the Cline lane re-advertises OpenRouter's
 * whole catalogue, so it prefixes a namespace onto ids the other lanes serve
 * bare — `cline/deepseek/deepseek-v4.1-flash` never resolved to the family the
 * report scored, which cost every Cline deepseek row its intelligence (they all
 * fell to the 0.35 unknown floor). The list now covers every namespace the live
 * listing actually used (audited against 653 advertised ids), plus `cline-pass/`
 * and `cline-free/`, which are Cline's own tier markers rather than vendors.
 */
const VENDOR_PREFIXES = [
  'nvidia/', 'moonshotai/', 'inclusionai/', 'z-ai/', 'cohere/', 'liquid/',
  'openai/', 'deepseek-ai/', 'stepfun/', 'dots-studio/', 'poolside/', 'stealth/',
  'thinkingmachines/', 'google/', 'meta-llama/', 'qwen/', 'mistralai/', 'x-ai/',
  'anthropic/', 'minimaxai/', 'baidu/', 'bytedance/', 'alibaba/',
  // ── LOCAL PATCH 2026-10-16: namespaces seen only on the Cline lane ──────
  'deepseek/', '~deepseek/', '~openai/', '~anthropic/', '~google/', '~z-ai/',
  '~x-ai/', '~moonshotai/', '~unbiased/', 'cline-pass/', 'cline-free/',
  'meta/', 'minimax/', 'tencent/', 'bytedance-seed/', 'xiaomi/', 'amazon/',
  'perplexity/', 'aion-labs/', 'sakana/', 'upstage/', 'ibm-granite/',
  'inception/', 'nex-agi/', 'rekaai/', 'relace/', 'morph/', 'microsoft/',
  'moondream/', 'scaledown/', 'perceptron/', 'inference-net/', 'fireworks/',
  'prism-ml/', 'meituan/', 'arcee-ai/', 'writer/', 'typesafe/', 'openrouter/',
  'cognitivecomputations/', 'anthracite-org/', 'mancer/', 'undi95/', 'gryphe/',
  'nousresearch/', 'sao10k/', 'thedrummer/', 'unbiased/', 'kilo-auto/',
]

/**
 * Trailing markers that identify the lane, not the model.
 *
 * `-official` is deliberately here: TRAE advertises the same weights twice
 * (`DeepSeek-V4-Flash` and `DeepSeek-V4-Flash-Official`) with an identical
 * display name, so folding the marker lets the catalog collapse the pair
 * instead of spending two ranking slots on one route.
 */
const SUFFIX_PATTERNS = [
  /:free$/,
  /-free$/,
  /-official$/,
  /-contributor-free$/,
  /-\d{6}$/,
  /-\d{4}-\d{2}-\d{2}$/,
]

/**
 * Ids whose suffix marks a non-interactive endpoint, not a model.
 *
 * LOCAL PATCH 2026-10-16: OpenRouter's `:batch` SKUs are asynchronous batch
 * endpoints (submit now, collect later) and cannot serve a live agent step. The
 * health ledger proves it — all 8 recorded `:batch` calls returned an error and
 * not one token of output, while the same models without the suffix answered
 * normally. They keep their own family so they can never be scored as, or
 * confused with, the interactive route.
 */
export const NON_INTERACTIVE_SUFFIX = /:(?:batch|async)$/i

/**
 * Fold one advertised model id into a comparable key.
 * `z-ai/glm-5.3` -> `glm-5.3`; `sn-glm-5-3` -> `sn-glm-5-3` (channel-specific
 * ids are resolved by the alias table, not by guessing).
 *
 * @param {string} id - advertised model id.
 * @returns {string} lowercase, vendor- and lane-marker-stripped id.
 */
export function normalizeModelId(id) {
  let key = String(id ?? '').trim().toLowerCase()
  for (const prefix of VENDOR_PREFIXES) {
    if (key.startsWith(prefix)) {
      key = key.slice(prefix.length)
      break
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of SUFFIX_PATTERNS) {
      const next = key.replace(suffix, '')
      if (next !== key && next !== '') {
        key = next
        changed = true
      }
    }
  }
  return key
}

/**
 * Fold operations for ids whose lane marker or namespace the static tables have
 * never seen (LOCAL PATCH 2026-10-24).
 *
 * Why this exists: lanes rename the same weights all the time, and every rename
 * used to land on a *different* family. Raccoon served the V4.1 Flash weights as
 * `sn-deepseek-v4-1-flash` and then re-advertised the identical model as
 * `sn-deepseek-v4-1-flash-1017` (a 10/17 build stamp); our-free-model serves
 * `opencode/deepseek-v4.1-flash` under a namespace {@link VENDOR_PREFIXES} has
 * never heard of. Both fell to the unknown-quality floor and became singleton
 * families, so the preference picker listed three "different" DeepSeek rows, the
 * merged channel count was wrong, and locking a preference could only see one of
 * them.
 *
 * Handing every new spelling to a hand-maintained table does not scale, so the
 * fold is **verified instead of guessed**: {@link foldCandidates} proposes
 * progressively reduced spellings, and resolution accepts one only when it lands
 * exactly on a model the dataset already knows. A bad guess therefore costs
 * nothing, and a new build stamp, region marker or channel namespace resolves on
 * the next refresh with no code change.
 *
 * Confidence is the weakest operation on the path: stripping a build stamp from
 * weights we have measured is nearly free information (0.95), while guessing
 * through a channel's own prefix is worth less (0.85).
 */
const FOLD_STEPS = [
  // The date must win over the numeric rule, or `qwen3.5-plus-2026-04-20` would
  // be peeled one number at a time and could stop on a wrong spelling first.
  { op: 'snapshot-date', confidence: 0.95, apply: key => key.replace(/(?<=[a-z0-9])[-_]\d{4}[-_]\d{2}[-_]\d{2}$/, '') },
  // `-1017`, `-0731`, `-v2`, `-b3`: a build/revision stamp, not a model.
  { op: 'build-tag', confidence: 0.95, apply: key => key.replace(/(?<=[a-z0-9])[-_](?:\d{2,8}|[vbr]\d{1,4})$/, '') },
  // `deepseek-v4.1-flash-sg`: the region a lane serves from, not the weights.
  { op: 'region-tag', confidence: 0.95, apply: key => key.replace(/[-_](?:sg|my|us|eu|jp|cn|hk|tw|kr|intl|global|latest|apac|mea)$/, '') },
  // `opencode/deepseek-v4.1-flash`, `codearts/x`: one namespace level.
  { op: 'namespace', confidence: 0.95, apply: key => (key.includes('/') ? key.slice(key.indexOf('/') + 1) : null) },
  // `sn-glm-5-3`, `sn-kimi-k3`: a channel's own two-letter prefix.
  { op: 'channel-tag', confidence: 0.85, apply: key => key.replace(/^[a-z]{2,8}[-_](?=[a-z])/, '') },
  // `deepseek-v4-1-flash` spelled with dashes instead of dots.
  { op: 'version-dash', confidence: 0.85, apply: key => key.replace(/(?<=\d)[-_.](?=\d)/g, '.') },
]

/**
 * Progressively reduced spellings of one advertised id, breadth-first.
 *
 * Depth comes before breadth so the candidate that used the *fewest* operations
 * (i.e. the most faithful reading) is checked first, and a candidate is emitted
 * at most once. Nothing here decides anything: each key is a hypothesis for
 * {@link resolveFamily} to verify against the known families.
 *
 * @param {string} id - advertised model id.
 * @param {{maxDepth?: number, limit?: number}} [options]
 * @returns {{key: string, ops: string[], confidence: number}[]} hypotheses, best first.
 */
export function foldCandidates(id, options = {}) {
  const raw = String(id ?? '').trim().toLowerCase()
  if (raw === '') return []
  const maxDepth = Math.max(1, Math.min(4, options.maxDepth ?? 3))
  const limit = Math.max(1, options.limit ?? 48)
  const seen = new Set([raw])
  const out = []
  let frontier = [{ key: raw, ops: [], confidence: 1 }]
  for (let depth = 1; depth <= maxDepth && out.length < limit; depth += 1) {
    const next = []
    for (const parent of frontier) {
      for (const step of FOLD_STEPS) {
        const folded = step.apply(parent.key)
        if (typeof folded !== 'string' || folded === '' || folded === parent.key) continue
        if (seen.has(folded)) continue
        seen.add(folded)
        const entry = {
          key: folded,
          ops: [...parent.ops, step.op],
          confidence: Math.min(parent.confidence, step.confidence),
        }
        out.push(entry)
        next.push(entry)
        if (out.length >= limit) break
      }
      if (out.length >= limit) break
    }
    frontier = next
  }
  return out
}

/**
 * Corrections that outrank everything else, including the report's own canonical
 * table (LOCAL PATCH 2026-10-16).
 *
 * The report scored `deepseek-flash` as a family of its own with no
 * intelligence data, even though its note says the id is V4.1 Flash. Because
 * `resolveFamily` consults `canonical` first, an entry in {@link FAMILY_ALIASES}
 * alone would never be reached — the correction has to be checked before it.
 * Keep this table tiny and evidence-backed; it is the "the report is wrong about
 * this id" escape hatch, not a second alias list.
 */
export const FAMILY_CORRECTIONS = {
  'deepseek-flash': 'deepseek-v4.1-flash',
}

/**
 * Advertised id (lowercased) -> report family. Only ids whose spelling differs
 * from the family name need an entry; everything else resolves through the
 * canonical table and the patterns below.
 */
export const FAMILY_ALIASES = {
  // ── Raccoon 商汤 ──────────────────────────────────────────────────────
  'sn-glm-5-3': 'glm-5.3',
  'sn-glm-5-3-flash': 'glm-5.3-flash',
  'sn-kimi-k3': 'kimi-k3',
  'sn-deepseek-v4-1-flash': 'deepseek-v4.1-flash',
  // ── Qoder 中国版 阿里: opaque SKU names, only the report knows the mapping ──
  qmodel_38max: 'qwen3.8-max',
  gmodel: 'glm-5.3',
  gfmodel: 'glm-5.3-flash',
  kmodel_latest: 'kimi-k3',
  dfmodel: 'deepseek-v4-flash',
  dmodel: 'deepseek-v4-pro',
  gm51model: 'glm-5.2',
  mmodel: 'minimax-m2.7',
  qmodel: 'qwen3.7-plus',
  qfmodel: 'qwen3.8-flash',
  kmodel: 'kimi-k2.8-preview',
  qmodel_latest: 'qwen3.7-max',
  q37fmodel: 'qwen3.7-flash',
  // ── CodeBuddy / WorkBuddy / CodeArts 腾讯·华为 ────────────────────────
  'kimi-k3-1': 'kimi-k3',
  'hy3-x': 'hunyuan-hy3',
  hy3: 'hunyuan-hy3',
  'hy4-preview': 'hunyuan-hy4-preview',
  'glm-5.2-sft-harmony': 'glm-5.2',
  'glm-5.2-arkts-spark': 'glm-5.2-arkts-spark',
  // ── 免费车道: vendor-prefixed ids ─────────────────────────────────────
  'step-5-preview-free': 'step-5-preview',
  'ling-3.1-flash-free': 'ling-3.1-flash',
  'mimo-v2.6-flash-free': 'mimo-v2.6-flash',
  'nemotron-3.5-lightning-free': 'nemotron-3.5-lightning',
  'space-bunny-free': 'space-bunny',
  'longcat-2.5-preview-free': 'longcat-2.5',
  'openrouter-free': 'auto-router',
  'kilo-auto': 'kilo-auto',
  'muse-spark-1.2-contributor-free': 'muse-spark-1.2',
  'muse-spark-1.3-contributor-free': 'muse-spark-1.3',
  // ── TRAE 字节: `Official` variants are the same family ────────────────
  'deepseek-v4-flash-official': 'deepseek-v4-flash',
  'deepseek-v4-pro-official': 'deepseek-v4-pro',
  'deepseek-v3': 'deepseek-v3',
  'deepseek-v3.1': 'deepseek-v3.1',
  'qwen-3.7-plus': 'qwen3.7-plus',
  'qwen-3.6-plus': 'qwen3.6-plus',
  'qwen-3.5': 'qwen3.5',
  'qwen-3.8-max': 'qwen3.8-max',
  'doubao-seed-2.0-code': 'doubao-seed-2.0-code',
  'doubao-seed-2.1-turbo': 'doubao-seed-2.1-turbo',
  'doubao-seed-2.1-pro': 'doubao-seed-2.1-pro',
  'doubao-seed-evolving': 'doubao-seed-evolving',
  'doubao-2.0-mini': 'doubao-2.0-mini',
  'doubao-seed-code': 'doubao-seed-code',
  'multimodal_image_kimi-k2.5': 'kimi-k2.5',
  // ── LobsterAI 有道: dated snapshots ──────────────────────────────────
  'qwen3.5-plus-2026-04-20': 'qwen3.5-plus',
  'doubao-seed-2-1-turbo': 'doubao-seed-2.1-turbo',
  'doubao-seed-2-1-pro': 'doubao-seed-2.1-pro',
  'doubao-seed-2-0-code-preview': 'doubao-seed-2-0-code-preview',
  'minimax-m3.1-flash-preview': 'minimax-m3.1-flash-preview',
  // ── Loomy 讯飞 ───────────────────────────────────────────────────────
  'deepseek-v4-flash-0731': 'deepseek-v4-flash',
  'deepseek-v4.1-flash': 'deepseek-v4.1-flash',
  // ── DeepSeek V4.1 Flash under a legacy id (local patch 2026-10-16) ────
  // Three lanes advertise V4.1 Flash under the bare id `deepseek-flash` while
  // the gateway display name says so outright: lobsterai "DeepSeek-V4.1-Flash ·
  // x0.05", deepseek-official/-account "DeepSeek-V41-Flash". The report itself
  // lists that id under "no intelligence data" yet its own note reads "DeepSeek
  // V4.1 Flash 采用了新的模型结构…" — so an unmapped family scored the x0.05
  // lane at the 0.35 unknown-quality floor and buried the cheapest V4.1 route
  // at rank #90. Same weights, same family: map it.
  'deepseek-flash': 'deepseek-v4.1-flash',
  // ── MiniMax / ZCode ──────────────────────────────────────────────────
  'minimax-m2.7-highspeed': 'minimax-m2.7-highspeed',
  'spark-x': 'spark-x2.5',
}

/**
 * Last-resort patterns for ids the alias table has never seen — a lane that
 * starts serving a new SKU should land on the right family without a rebuild.
 * Ordered: the first match wins, so put the more specific rules first.
 */
export const FAMILY_PATTERNS = [
  [/^glm-5\.3-flashx$/, 'glm-5.3-flash'],
  [/^glm-5\.3-flash/, 'glm-5.3-flash'],
  [/^glm-5\.3/, 'glm-5.3'],
  [/^glm-5\.2/, 'glm-5.2'],
  [/^glm-5\.1/, 'glm-5.1'],
  [/^glm-5v/, 'glm-5v-turbo'],
  [/^glm-5$/, 'glm-5'],
  [/^glm-4\.7/, 'glm-4.7'],
  [/^kimi-k3/, 'kimi-k3'],
  [/^kimi-k2\.8/, 'kimi-k2.8-preview'],
  [/^kimi-k2\.7-code/, 'kimi-k2.7-code'],
  [/^kimi-k2\.7/, 'kimi-k2.7'],
  [/^kimi-k2\.6/, 'kimi-k2.6'],
  [/^kimi-k2\.5/, 'kimi-k2.5'],
  [/^deepseek-v4\.1-flash/, 'deepseek-v4.1-flash'],
  [/^deepseek-v4-flash/, 'deepseek-v4-flash'],
  [/^deepseek-v4-pro/, 'deepseek-v4-pro'],
  [/^deepseek-v3\.1/, 'deepseek-v3.1'],
  [/^deepseek-v3/, 'deepseek-v3'],
  // LOCAL PATCH 2026-10-16: every `deepseek-flash*` id a lane advertises is the
  // V4.1 Flash weights (see the alias-table note). Ordering still matters: the
  // v4-flash / v4-pro / v3 patterns above must win first, which they do.
  [/^deepseek-flash/, 'deepseek-v4.1-flash'],
  [/^qwen3\.8-max/, 'qwen3.8-max'],
  [/^qwen3\.8-flash/, 'qwen3.8-flash'],
  [/^qwen3\.8-omni-flash/, 'qwen3.8-omni-flash'],
  [/^qwen3\.7-max/, 'qwen3.7-max'],
  [/^qwen3\.7-plus/, 'qwen3.7-plus'],
  [/^qwen3\.7-flash/, 'qwen3.7-flash'],
  [/^qwen3\.6-plus/, 'qwen3.6-plus'],
  [/^qwen3\.5-plus/, 'qwen3.5-plus'],
  [/^qwen3\.5$/, 'qwen3.5'],
  [/^minimax-m3\.1-flash/, 'minimax-m3.1-flash-preview'],
  [/^minimax-m3/, 'minimax-m3'],
  [/^minimax-m2\.7-highspeed/, 'minimax-m2.7-highspeed'],
  [/^minimax-m2\.7/, 'minimax-m2.7'],
  [/^mimo-v2\.6-pro/, 'mimo-v2.6-pro'],
  [/^mimo-v2\.6-flash/, 'mimo-v2.6-flash'],
  [/^mimo-v2\.5/, 'mimo-v2.5'],
  [/^step-5-preview/, 'step-5-preview'],
  [/^ling-3\.1-flash/, 'ling-3.1-flash'],
  [/^nemotron-3-super/, 'nemotron-3-super-120b-a12b'],
  [/^nemotron-3-ultra/, 'nemotron-3-ultra-550b-a55b'],
  [/^nemotron-3\.5-lightning/, 'nemotron-3.5-lightning'],
  [/^nemotron-3-nano/, 'nemotron-3-nano-omni-30b-a3b-reasoning'],
  [/^nemotron-3\.5-content-safety/, 'nemotron-3.5-content-safety'],
  [/^north-mini-code/, 'north-mini-code'],
  [/^gpt-oss-20b/, 'gpt-oss-20b'],
  [/^inkling-small/, 'inkling-small'],
  [/^lfm-2\.5/, 'lfm-2.5-2.6b'],
  [/^laguna-s-2\.1/, 'laguna-s-2.1'],
  [/^laguna-xs-2\.1/, 'laguna-xs-2.1'],
  [/^dots-3-note/, 'dots-3-note-preview'],
  [/^longcat-2\.5/, 'longcat-2.5'],
  [/^glyph-cluster/, 'glyph-cluster'],
  [/^space-bunny/, 'space-bunny'],
  [/^sensenova-6\.8-flash-lite/, 'sensenova-6.8-flash-lite'],
  [/^sensenova-6\.8-flash/, 'sensenova-6.8-flash'],
  [/^openpangu-2\.0-pro/, 'openpangu-2.0-pro'],
  [/^openpangu-2\.0-flash/, 'openpangu-2.0-flash'],
  [/^hunyuan-hy4/, 'hunyuan-hy4-preview'],
  [/^hunyuan-hy3/, 'hunyuan-hy3'],
  [/^doubao-seed-2\.0-code/, 'doubao-seed-2.0-code'],
  [/^doubao-seed-2\.1-turbo/, 'doubao-seed-2.1-turbo'],
  [/^doubao-seed-2\.1-pro/, 'doubao-seed-2.1-pro'],
  [/^doubao-seed-code/, 'doubao-seed-code'],
  [/^doubao-seed-evolving/, 'doubao-seed-evolving'],
  [/^doubao-2\.0-mini/, 'doubao-2.0-mini'],
  [/^code-review-judge/, 'code-review-judge'],
  [/^spark-x2\.5/, 'spark-x2.5'],
  [/^muse-spark-1\.3/, 'muse-spark-1.3'],
  [/^muse-spark-1\.2/, 'muse-spark-1.2'],
]

/**
 * What each family is actually good at, taken from the report's findings rather
 * than from vendor claims. The router uses these to answer "does this task need
 * this family?".
 *
 * `agent-weak` is the one tag that overrides a high intelligence score: the
 * report measured `mimo-v2.6-flash` at Terminal-Bench 4.0 = 23% — a high
 * benchmark total does not mean the model can drive tools.
 */
export const FAMILY_TAGS = {
  'glm-5.3': ['agent-strong', 'long-context', 'flagship', 'six-lanes'],
  'glm-5.3-flash': ['agent-good', 'cheap', 'six-lanes', 'overclaimed'],
  'step-5-preview': ['agent-strong', 'long-context', 'fast-tier', 'thinking-mandatory'],
  'qwen3.8-max': ['long-context', 'flagship', 'verbose', 'slow-decode'],
  'kimi-k3': ['agent-strong', 'long-context', 'vision', 'expensive'],
  'mimo-v2.6-pro': ['top-open-weight', 'slow-tier', 'cheap'],
  'deepseek-v4-flash': ['fastest-tier', 'cheap', 'deprecated'],
  'ling-3.1-flash': ['fast-decode', 'verbose'],
  'deepseek-v4-pro': ['retired-upstream'],
  'glm-5.2': ['deprecated', 'cheap'],
  'minimax-m3': ['vision', 'fast-tier'],
  'kimi-k2.6': ['vision', 'fastest-tier', 'legacy'],
  'mimo-v2.6-flash': ['agent-weak'],
  'kimi-k2.7-code': ['coding-sku', 'fast-tier'],
  'deepseek-v4.1-flash': ['budget'],
  'nemotron-3-ultra-550b-a55b': ['long-context', 'budget'],
  'minimax-m2.7': ['non-commercial'],
  'qwen3.7-plus': ['slow-tier', 'verbose'],
  'glm-5.1': ['legacy'],
  'nemotron-3.5-lightning': ['fast-tier', 'budget', 'weak-reasoning'],
  'deepseek-v3': ['cheapest', 'non-reasoning'],
  'north-mini-code': ['coding-sku', 'budget'],
  'nemotron-3-super-120b-a12b': ['slow-tier', 'budget'],
  'gpt-oss-20b': ['unusable-slow'],
  'inkling-small': ['agent-strong', 'daily-quota'],
  'muse-spark-1.3': ['region-blocked'],
  'muse-spark-1.2': ['region-blocked'],
  'glm-5v-turbo': ['vision'],
  'qwen3.8-omni-flash': ['vision', 'omni'],
  'qwen3.8-flash': ['fast-tier'],
  'deepseek-flash': ['budget'],
  'minimax-m3.1-flash-preview': ['fast-tier'],
  'kimi-k2.7-code-highspeed': ['fast-tier', 'coding-sku'],
  'kimi-k2.8-preview': ['preview'],
  'kimi-k2.7': ['legacy'],
  'kimi-k2.5': ['vision', 'legacy'],
  'glm-5': ['legacy'],
  'glm-4.7': ['legacy'],
  'glm-5.2-arkts-spark': ['unusable-slow'],
  'nemotron-3.5-content-safety': ['not-a-model'],
  'doubao-seed-code': ['coding-sku'],
  'doubao-seed-2.0-code': ['coding-sku'],
  'qwen3.7-max': ['legacy'],
  'qwen3.6-plus': ['legacy'],
  'qwen3.5-plus': ['legacy'],
  'deepseek-v3.1': ['legacy', 'non-reasoning'],
  'code-review-judge': ['role-model'],
  'auto-router': ['provider-router'],
  'kilo-auto': ['provider-router'],
}

/** Tags that describe a task requirement; the router matches these. */
export const REQUIREMENT_TAGS = {
  vision: 'vision',
  tools: 'agent-strong',
  'long-context': 'long-context',
}

/** Tags that only ever reduce a candidate's score. */
export const PENALTY_TAGS = {
  'agent-weak': 0.45,
  'unusable-slow': 0.9,
  'region-blocked': 1,
  'not-a-model': 1,
  'deprecated': 0.12,
  'retired-upstream': 0.25,
  'preview': 0.04,
  'legacy': 0.06,
  verbose: 0.05,
  'slow-decode': 0.06,
  'slow-tier': 0.05,
  'non-commercial': 0.03,
  'overclaimed': 0.02,
  'provider-router': 0.08,
  'role-model': 0.5,
  'weak-reasoning': 0.08,
}

/** One exact lookup across the correction, canonical, user-alias and built-in tables. */
function exactFamily(key, canonical, extraAliases) {
  if (key === '') return null
  if (FAMILY_CORRECTIONS[key] !== undefined) return { family: FAMILY_CORRECTIONS[key], source: 'correction' }
  if (canonical[key] !== undefined) return { family: canonical[key], source: 'canonical' }
  if (extraAliases[key] !== undefined) return { family: extraAliases[key], source: 'alias' }
  if (FAMILY_ALIASES[key] !== undefined) return { family: FAMILY_ALIASES[key], source: 'alias' }
  return null
}

/** One pattern pass over the naming conventions no table lists. */
function patternFamily(key) {
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(key)) return family
  }
  return null
}

/**
 * Resolve an advertised model id to its report family.
 *
 * @param {string} modelId - the id a lane advertises.
 * @param {Record<string, string>} [canonical] - family ids the report scored,
 *   lowercased. Supplied by the loaded dataset so a refreshed report widens the
 *   set without a code change.
 * @param {Record<string, string>} [extraAliases] - user/imported aliases, which
 *   win over the built-in table.
 * @returns {string | null} family id, or null when the model has no known family.
 */
export function resolveFamily(modelId, canonical = {}, extraAliases = {}) {
  return familyResolution(modelId, canonical, extraAliases).key
}

/**
 * Resolve an id to a family **and** say how much that identification is worth.
 *
 * The router needs both: a family found by an exact alias is the model the
 * report measured, while a family found by a loose pattern is a guess that
 * merely shares a naming convention. Scoring a guess with the measured
 * intelligence of its namesake is how `glm-5.3-flashx` inherited the full
 * 42-point score of `glm-5.3-flash` without anyone measuring it.
 *
 * Four passes, strongest evidence first (LOCAL PATCH 2026-10-24 adds the third):
 *
 * 1. **exact** — the id, or the id with its static vendor/lane markers stripped,
 *    is already a family or alias. Unchanged from before.
 * 2. **folded exact** — a spelling reached by one of the {@link FOLD_STEPS}
 *    (build stamp, region, channel namespace, dashed version) lands exactly on a
 *    known family. This is what keeps `sn-deepseek-v4-1-flash-1017` and
 *    `opencode/deepseek-v4.1-flash` on the family the report measured, instead of
 *    giving each build its own singleton family. It outranks the loose patterns
 *    because landing on an exact known id is better evidence than a shared
 *    prefix.
 * 3. **patterned** — the naming conventions in {@link FAMILY_PATTERNS}, which is
 *    still a guess and therefore scores 0.7.
 * 4. **identity** — an unknown id is still a family of one: routing needs a
 *    stable identity even when the report has nothing to say about it.
 *
 * @param {string} modelId - the id a lane advertises.
 * @param {Record<string, string>} [canonical] - families the report scored.
 * @param {Record<string, string>} [extraAliases] - user/imported aliases.
 * @returns {{key: string|null, confidence: number, source: 'correction'|'alias'|'canonical'|'folded'|'pattern'|'identity', foldedFrom?: string[]}}
 */
export function familyResolution(modelId, canonical = {}, extraAliases = {}) {
  const raw = String(modelId ?? '').trim().toLowerCase()
  if (raw === '') return { key: null, confidence: 0, source: 'identity' }
  const normalized = normalizeModelId(raw)

  // LOCAL PATCH 2026-10-16: a non-interactive endpoint keeps its own identity.
  // Without this, stripping the vendor namespace turns `deepseek-v4.1-flash:batch`
  // into something the `/^deepseek-v4\.1-flash/` pattern happily folds into the
  // interactive family — the exact mix-up this guard exists to prevent.
  if (NON_INTERACTIVE_SUFFIX.test(raw)) {
    return { key: raw, confidence: 0, source: 'identity' }
  }

  const legacyKeys = normalized === raw ? [raw] : [raw, normalized]

  // 1. exact, on the id as advertised and after the static marker strip.
  for (const key of legacyKeys) {
    const hit = exactFamily(key, canonical, extraAliases)
    if (hit !== null) return { key: hit.family, confidence: 1, source: hit.source }
  }

  // 2. fold-and-verify. The candidate list is ordered best-first by how few
  //    operations it needed, and every hit below is a model the dataset knows.
  const folds = foldCandidates(raw)
  for (const candidate of folds) {
    const hit = exactFamily(candidate.key, canonical, extraAliases)
    if (hit !== null) {
      return {
        key: hit.family,
        confidence: candidate.confidence,
        source: 'folded',
        foldedFrom: candidate.ops,
      }
    }
  }

  // 3. naming conventions.
  for (const key of legacyKeys) {
    const family = patternFamily(key)
    if (family !== null) return { key: family, confidence: 0.7, source: 'pattern' }
  }
  for (const candidate of folds) {
    const family = patternFamily(candidate.key)
    if (family !== null) return { key: family, confidence: 0.65, source: 'pattern', foldedFrom: candidate.ops }
  }

  // 4. identity.
  return { key: normalized === '' ? null : normalized, confidence: 0, source: 'identity' }
}

/**
 * A grouping key that folds spelling differences the report did not list.
 *
 * `GLM-5.3`, `glm-5.3` and `glm_5_3` are one model on three lanes; the live
 * catalog is full of such spellings. The key is only used to decide "same
 * model?" — the authoritative family id still comes from
 * {@link familyResolution}.
 *
 * @param {string} family - resolved family id.
 * @returns {string} case- and separator-insensitive key.
 */
export function foldKey(family) {
  return String(family ?? '').trim().toLowerCase().replace(/[._\s]+/g, '-')
}

/** Family description tags, defaulting to none. */
export function tagsOf(family) {
  return FAMILY_TAGS[family] ?? []
}

export default resolveFamily
