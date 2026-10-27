/**
 * Lane guard and duo pairing (v2.6.0).
 *
 * Two properties that used to be *declarations* become executable here:
 *
 * 1. **Isolation.** `_supervisor/policy.json` says which models lane A (main)
 *    and lane B (worker) own. Nothing enforced it: a candidate chain that
 *    overlapped the other lane meant two "independent" opinions could be the
 *    same brain, and a single shared gateway could stop a whole lane. The guard
 *    turns that declaration into a routing gate plus an audit that says, from
 *    the live catalog, whether the two lanes really share a model and whether
 *    this lane still has more than one upstream to fail over to.
 *
 * 2. **Duo pairing.** "Two independent opinions" is only true when the peer's
 *    model is read from the peer's *own* runtime record, not from a string the
 *    caller typed. `peerRuntime` reads the peer's health ledger first and the
 *    peer profile's default model second; `pairFor` then picks a local
 *    candidate that differs in family and provider.
 *
 * Every function here is read-only and never throws: a missing or malformed
 * policy file degrades to "do not intercept", because a guard that breaks
 * routing is worse than no guard.
 *
 * @module src/lanes
 */

import fs from 'node:fs'
import { foldKey } from './families.js'

/** The lane ids the supervisor policy declares. A = main, B = worker. */
export const LANE_IDS = ['a', 'b']

/** Which `policy.json` section carries each lane's declared models. */
export const LANE_SECTIONS = { a: 'main', b: 'worker' }

/** Read JSON, returning null instead of throwing. */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Strip quotes and a trailing YAML comment from one scalar value. */
function scalar(text) {
  let value = String(text ?? '').trim()
  const hash = value.indexOf(' #')
  if (hash >= 0) value = value.slice(0, hash).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

/**
 * Normalize one `{provider, model}` declaration; null when unusable.
 *
 * The provider is folded to lower case here rather than only inside
 * {@link laneKey}: provider ids are canonical lower case, so a health file that
 * wrote `Raccoon` would otherwise surface as a second, differently-spelled
 * provider in the audit output and in the pair it proposes. Model ids keep their
 * case — they are display strings, and folding them would make `GLM-5.3` look
 * like a different model from `GLM-5.3` only when comparison happens to skip it.
 */
function entryOf(value) {
  if (value === null || typeof value !== 'object') return null
  const provider = scalar(value.provider).toLowerCase()
  const model = scalar(value.model)
  if (provider === '' || model === '') return null
  return { provider, model }
}

/** A comparable key for one `provider/model` declaration. */
export function laneKey(provider, model) {
  return String(provider ?? '').trim().toLowerCase() + '\u0000' + foldKey(model)
}

/** The lane a row belongs to, or null when neither lane declares it. */
function laneOfEntry(provider, model, lanes) {
  const key = laneKey(provider, model)
  for (const laneId of LANE_IDS) {
    const declared = lanes[laneId] ?? []
    if (declared.some(entry => laneKey(entry.provider, entry.model) === key)) return laneId
  }
  return null
}

/**
 * Parse the supervisor policy into two lane ownership tables.
 *
 * A missing file, invalid JSON, an unreadable section or an unknown `laneId`
 * all return `ok: false` with the reason — the caller must then route as if the
 * guard did not exist. This function never throws.
 *
 * @param {object} options
 * @param {string} options.policyPath - path to `_supervisor/policy.json`.
 * @param {'a'|'b'} options.laneId - which lane this instance belongs to.
 * @returns {{lanes: {a: object[], b: object[]}, own: object[], foreign: object[], laneId: string|null, ok: boolean, error: string, policyPath: string}}
 */
export function loadLanePolicy(options = {}) {
  const policyPath = scalar(options.policyPath)
  const laneId = scalar(options.laneId).toLowerCase()
  const lanes = { a: [], b: [] }
  const result = { lanes, own: [], foreign: [], laneId: laneId === '' ? null : laneId, ok: false, error: '', policyPath }

  if (policyPath === '') {
    result.error = '未配置 laneGuard.policyPath'
    return result
  }
  if (!LANE_IDS.includes(laneId)) {
    result.error = laneId === '' ? '未配置 laneGuard.laneId' : '未知车道 "' + laneId + '"（只认 a / b）'
    return result
  }
  const raw = readJsonFile(policyPath)
  if (raw === null) {
    result.error = '读不到或解析失败：' + policyPath
    return result
  }
  for (const id of LANE_IDS) {
    const section = raw?.[LANE_SECTIONS[id]]
    const models = Array.isArray(section?.models) ? section.models : null
    if (models === null) {
      result.error = 'policy.json 缺少 ' + LANE_SECTIONS[id] + '.models'
      return result
    }
    lanes[id] = models.map(entryOf).filter(entry => entry !== null)
  }
  result.own = lanes[laneId]
  result.foreign = LANE_IDS.filter(id => id !== laneId).flatMap(id => lanes[id])
  result.ok = true
  return result
}

/**
 * Whether a row is claimed by the *other* lane.
 *
 * Matching is by provider plus model id, folding case and separators the same
 * way the catalog folds family keys (`GLM-5.3` / `glm_5_3` are one model), so a
 * lane that renames the same weights is still recognised as an overlap.
 *
 * @param {{provider: string, model: string}} row
 * @param {ReturnType<typeof loadLanePolicy>} policy
 * @returns {{foreign: boolean, lane: string|null, match: {provider: string, model: string}|null}}
 */
export function laneVerdict(row, policy) {
  const verdict = { foreign: false, lane: null, match: null }
  if (policy === null || policy === undefined || policy.ok !== true) return verdict
  if (row === null || row === undefined) return verdict
  const provider = String(row.provider ?? '').trim()
  const model = String(row.model ?? '').trim()
  if (provider === '' || model === '') return verdict
  const key = laneKey(provider, model)
  for (const entry of policy.foreign ?? []) {
    if (laneKey(entry.provider, entry.model) !== key) continue
    verdict.foreign = true
    verdict.match = { provider: entry.provider, model: entry.model }
    verdict.lane = laneOfEntry(entry.provider, entry.model, policy.lanes ?? { a: [], b: [] })
    break
  }
  return verdict
}

/**
 * Audit the isolation the policy only *claims*.
 *
 * Two readings, both computed from the live catalog and nothing else (no
 * network, no writes):
 *
 * 1. **overlap** — of the models the two lanes declare, which ones this machine
 *    actually has, and whether the two sets intersect. Zero intersection = pass:
 *    the lanes cannot land on the same brain.
 * 2. **diversity** — the own lane's chain with the foreign lane's models removed
 *    spans how many providers. Fewer than two is one upstream wearing several
 *    model names, which is exactly the shape that produced
 *    "All models exhausted: 1 route checked".
 *
 * @param {object} options
 * @param {object[]} options.rows - live catalog rows.
 * @param {ReturnType<typeof loadLanePolicy>} options.policy
 * @param {'a'|'b'} [options.laneId] - defaults to the policy's own lane.
 * @returns {object} structured audit.
 */
export function auditLanes(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : []
  const policy = options.policy ?? null
  const laneId = scalar(options.laneId ?? policy?.laneId).toLowerCase()
  const audit = {
    ok: false,
    laneId: laneId === '' ? null : laneId,
    policyPath: policy?.policyPath ?? '',
    error: '',
    checks: [],
    declared: { a: [], b: [] },
    present: { a: [], b: [] },
    overlap: [],
    ownCandidates: [],
    ownProviders: [],
    rows: rows.length,
  }
  if (policy === null || policy === undefined || policy.ok !== true) {
    audit.error = policy?.error ?? '没有可用的车道策略'
    return audit
  }
  audit.ok = true
  audit.declared = { a: [...(policy.lanes?.a ?? [])], b: [...(policy.lanes?.b ?? [])] }

  const rowKeys = new Map()
  for (const row of rows) {
    rowKeys.set(laneKey(row.provider, row.model), row)
  }
  const presentOf = list => list.filter(entry => rowKeys.has(laneKey(entry.provider, entry.model)))
  audit.present = { a: presentOf(audit.declared.a), b: presentOf(audit.declared.b) }

  const aKeys = new Set(audit.present.a.map(entry => laneKey(entry.provider, entry.model)))
  audit.overlap = audit.present.b.filter(entry => aKeys.has(laneKey(entry.provider, entry.model)))
  const overlapKeys = new Set(audit.overlap.map(entry => laneKey(entry.provider, entry.model)))

  audit.checks.push({
    id: 'overlap',
    pass: audit.overlap.length === 0,
    detail: audit.overlap.length === 0
      ? '两条车道声明的模型零交集'
      : '两条车道共用 ' + audit.overlap.length + ' 个模型：'
        + audit.overlap.map(entry => entry.provider + '/' + entry.model).join('，'),
    evidence: {
      policyPath: audit.policyPath,
      present: {
        a: audit.present.a.map(entry => entry.provider + '/' + entry.model),
        b: audit.present.b.map(entry => entry.provider + '/' + entry.model),
      },
      overlap: audit.overlap.map(entry => entry.provider + '/' + entry.model),
    },
  })

  const own = laneId === 'a' || laneId === 'b' ? audit.present[laneId] : []
  audit.ownCandidates = own.filter(entry => !overlapKeys.has(laneKey(entry.provider, entry.model)))
  audit.ownProviders = [...new Set(audit.ownCandidates.map(entry => String(entry.provider).toLowerCase()))].sort()
  audit.checks.push({
    id: 'diversity',
    pass: audit.ownProviders.length >= 2,
    detail: audit.ownProviders.length >= 2
      ? '本车道去掉对侧占用后跨 ' + audit.ownProviders.length + ' 个 provider：' + audit.ownProviders.join('，')
      : '本车道去掉对侧占用后只剩 ' + audit.ownProviders.length + ' 个 provider'
        + (audit.ownProviders.length === 1 ? '（' + audit.ownProviders[0] + '）：单一上游，限流即整条车道停摆' : ''),
    evidence: {
      laneId: audit.laneId,
      candidates: audit.ownCandidates.map(entry => entry.provider + '/' + entry.model),
      providers: audit.ownProviders,
    },
  })
  return audit
}

/**
 * Read one peer's real running model.
 *
 * Order of authority: the peer's own health ledger `current.provider/model`
 * (what its scheduler actually dispatched), then the peer profile's
 * `agent-default-model` in `cordis.patch.yml` (what it would dispatch).
 * Nothing is guessed from a caller-supplied string.
 *
 * @param {object} options
 * @param {string[]} options.healthPaths - peer health.json files, most authoritative first.
 * @param {string[]} options.defaultModelPaths - peer cordis.patch.yml files.
 * @returns {{provider: string, model: string, source: 'health.json'|'patch'|'none', sourcePath: string, ok: boolean}}
 */
export function peerRuntime(options = {}) {
  const healthPaths = Array.isArray(options.healthPaths) ? options.healthPaths : []
  const defaultModelPaths = Array.isArray(options.defaultModelPaths) ? options.defaultModelPaths : []
  const none = { provider: '', model: '', source: 'none', sourcePath: '', ok: false }

  for (const file of healthPaths) {
    const raw = readJsonFile(file)
    const current = raw?.current
    if (current === null || current === undefined) continue
    const entry = entryOf(current)
    if (entry === null) continue
    return { ...entry, source: 'health.json', sourcePath: String(file), ok: true }
  }

  for (const file of defaultModelPaths) {
    const entry = readPatchDefaultModel(file)
    if (entry === null) continue
    return { ...entry, source: 'patch', sourcePath: String(file), ok: true }
  }
  return none
}

/** Read `agent-default-model`'s provider/model out of one cordis patch file. */
export function readPatchDefaultModel(file) {
  let text
  try {
    text = fs.readFileSync(String(file), 'utf8')
  } catch {
    return null
  }
  let provider = ''
  let model = ''
  let inside = false
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*-\s*id:\s*agent-default-model\s*$/.test(line)) {
      inside = true
      continue
    }
    if (inside && /^\s*-\s*id:/.test(line)) inside = false
    if (!inside) continue
    const providerMatch = line.match(/^\s*provider:\s*(.*)$/)
    if (providerMatch !== null) provider = scalar(providerMatch[1])
    const modelMatch = line.match(/^\s*model:\s*(.*)$/)
    if (modelMatch !== null) model = scalar(modelMatch[1])
  }
  if (provider === '' || model === '') return null
  return { provider, model }
}

/**
 * Pair this lane with a candidate that is genuinely a different brain.
 *
 * The peer comes from {@link peerRuntime}; the local side is the first candidate
 * (by utility, then quality) whose family and provider both differ from the
 * peer's — and, when a lane policy is supplied, that the guard would not block.
 * Skipping the guard here would let this function propose a model the router is
 * about to refuse, which is the sort of disagreement between two helpers that
 * looks like a bug in both of them.
 *
 * The returned `checks` are the evidence, so a caller can write this into a
 * collision record instead of a self-reported model name.
 *
 * @param {object} options
 * @param {object[]} options.candidates - live catalog rows or `{provider, model, family, utility}`.
 * @param {ReturnType<typeof peerRuntime>} [options.peer]
 * @param {ReturnType<typeof loadLanePolicy>} [options.policy] - optional lane guard.
 * @returns {{self: object|null, peer: object, checks: {id: string, pass: boolean, detail: string}[]}}
 */
export function pairFor(options = {}) {
  const peer = options.peer ?? peerRuntime({})
  const policy = options.policy ?? null
  const candidates = Array.isArray(options.candidates) ? [...options.candidates] : []
  const checks = []

  const peerKnown = peer?.ok === true
    && String(peer.provider ?? '').trim() !== ''
    && String(peer.model ?? '').trim() !== ''
  checks.push({
    id: 'peer',
    pass: peerKnown,
    detail: peerKnown
      ? '对侧当前模型 ' + peer.provider + '/' + peer.model + '（来源 ' + peer.source + '：' + peer.sourcePath + '）'
      : '读不到对侧运行状态（health.json 与 patch 都没有可用的 provider/model）',
  })

  candidates.sort((left, right) => {
    const byUtility = Number(right.utility ?? -Infinity) - Number(left.utility ?? -Infinity)
    if (Number.isFinite(byUtility) && byUtility !== 0) return byUtility
    return Number(right.quality ?? 0) - Number(left.quality ?? 0)
  })

  const peerFamily = peerKnown ? foldKey(peer.family ?? peer.model) : ''
  const peerProvider = peerKnown ? String(peer.provider).trim().toLowerCase() : ''

  let self = null
  let rejectedSameFamily = 0
  let rejectedSameProvider = 0
  let rejectedForeignLane = 0
  for (const candidate of candidates) {
    const provider = String(candidate.provider ?? '').trim()
    const model = String(candidate.model ?? '').trim()
    if (provider === '' || model === '') continue
    if (!peerKnown) break
    if (laneVerdict({ provider, model }, policy).foreign) {
      rejectedForeignLane += 1
      continue
    }
    const family = foldKey(candidate.family ?? model)
    if (family === peerFamily) {
      rejectedSameFamily += 1
      continue
    }
    if (provider.toLowerCase() === peerProvider) {
      rejectedSameProvider += 1
      continue
    }
    self = { provider, model, family, utility: candidate.utility ?? null }
    break
  }

  checks.push({
    id: 'family',
    pass: self !== null,
    detail: self === null
      ? '候选里没有与对侧不同 family 的模型（同 family 被跳过 ' + rejectedSameFamily + ' 个）'
      : '本侧 family ' + self.family + ' ≠ 对侧 ' + peerFamily,
  })
  checks.push({
    id: 'provider',
    pass: self !== null,
    detail: self === null
      ? '候选里没有与对侧不同 provider 的模型（同 provider 被跳过 ' + rejectedSameProvider + ' 个）'
      : '本侧 provider ' + self.provider + ' ≠ 对侧 ' + peerProvider,
  })
  if (policy !== null && policy !== undefined && policy.ok === true) {
    checks.push({
      id: 'lane',
      pass: rejectedForeignLane === 0 || self !== null,
      detail: rejectedForeignLane === 0
        ? '候选里没有对侧车道的模型'
        : '跳过了 ' + rejectedForeignLane + ' 个对侧车道的模型',
    })
  }

  return { self, peer, checks }
}

export default loadLanePolicy
