/**
 * The priority dataset: the shipped report facts plus whatever the user
 * imported later.
 *
 * Two layers, and the order matters. The package ships `src/priority-data.json`
 * built from the report; the user layer lives under `$DSH_HOME/model-orchestrator`
 * so a plugin upgrade never overwrites an import, and a re-import never needs a
 * package rebuild. Merging is per-family and per-model, newest-wins.
 *
 * The dataset is **prior knowledge**, not the routing input. The router reads
 * live traffic, the live catalog, and the channel pack's own ledger first; this
 * module only answers "what did the report measure about this family, and how
 * much should that measurement be trusted?".
 *
 * @module src/dataset
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { familyResolution, foldCandidates, foldKey, resolveFamily, tagsOf } from './families.js'
import { DEFAULT_NEVER_ROUTE, LANE_HINTS } from './policy-defaults.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHIPPED_PATH = path.join(HERE, 'priority-data.json')

/** Read JSON, returning undefined instead of throwing on a missing/corrupt file. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write JSON atomically enough for a cache: temp file, then rename. */
export function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

/**
 * The shipped dataset. Read once per process; the file is a build artifact and
 * does not change while the plugin runs.
 * @returns {object}
 */
export function shippedDataset() {
  return readJson(SHIPPED_PATH) ?? {
    source: { reportVersion: '', generatedAt: '', parsedAt: '', modelCount: 0, familyCount: 0, laneCount: 0 },
    canonical: {},
    families: {},
    models: {},
    lanes: [],
    unusable: [],
  }
}

/**
 * Build the live lookup table. Re-run whenever the user imports a new report,
 * so the router never has to restart to pick up new numbers.
 */
export function createDataset(options = {}) {
  const userDir = options.userDir ?? null
  const userFile = userDir === null ? null : path.join(userDir, 'priority.json')

  const shipped = shippedDataset()
  let user = userFile === null ? undefined : readJson(userFile)

  /** @type {object} */
  let state = null

  function rebuild() {
    const canonical = { ...shipped.canonical, ...(user?.canonical ?? {}) }
    const families = { ...shipped.families }
    for (const [id, info] of Object.entries(user?.families ?? {})) {
      const previous = families[id] ?? {}
      // A re-imported family must not lose fields the newer report omitted
      // (the parser writes only what the table actually said).
      families[id] = { ...previous, ...info }
    }
    const models = { ...shipped.models }
    for (const [id, info] of Object.entries(user?.models ?? {})) {
      const previous = models[id] ?? {}
      models[id] = {
        ...previous,
        ...info,
        byLane: { ...(previous.byLane ?? {}), ...(info.byLane ?? {}) },
        lanes: info.lanes ?? previous.lanes ?? [],
      }
    }
    const aliases = { ...(shipped.aliases ?? {}), ...(user?.aliases ?? {}) }
    const neverRoute = { ...DEFAULT_NEVER_ROUTE, ...(shipped.neverRoute ?? {}), ...(user?.neverRoute ?? {}) }
    const lanes = [...(shipped.lanes ?? [])]
    for (const lane of user?.lanes ?? []) {
      const index = lanes.findIndex(candidate => candidate.name === lane.name)
      if (index === -1) lanes.push(lane)
      else lanes[index] = { ...lanes[index], ...lane }
    }

    // A folded view of the canonical table: `glm_5_3` should find `glm-5.3`
    // without an alias entry for every spelling variation in the wild.
    const canonicalFolded = {}
    for (const [id, family] of Object.entries(canonical)) canonicalFolded[foldKey(id)] = family
    const aliasFolded = {}
    for (const [id, family] of Object.entries(aliases)) aliasFolded[foldKey(id)] = family

    state = {
      source: { shipped: shipped.source, imported: user?.source ?? null },
      canonical,
      canonicalFolded,
      aliases,
      aliasFolded,
      families,
      models,
      neverRoute,
      lanes,
      laneHints: { ...LANE_HINTS, ...(user?.laneHints ?? {}) },
    }
  }
  rebuild()

  return {
    /** The current merged dataset. */
    get current() {
      return state
    },
    /** Re-read the user layer from disk (after an import). */
    reload() {
      user = userFile === null ? undefined : readJson(userFile)
      rebuild()
      return state
    },
    /** Replace the user layer and persist it. */
    importDataset(next, source = {}) {
      if (userFile === null) throw new Error('dataset: no writable user directory configured')
      user = { ...(next ?? {}), source: { ...source, importedAt: new Date().toISOString() } }
      writeJsonAtomic(userFile, user)
      rebuild()
      return state
    },
    /** Where the user layer lives, for the panel. */
    get userFile() {
      return userFile
    },
    /** Reset to the shipped report only. */
    clearImport() {
      if (userFile === null) return state
      try {
        // One exact, plugin-owned path — never a recursive delete.
        fs.unlinkSync(userFile)
      } catch {
        /* a missing file is the desired end state */
      }
      user = undefined
      rebuild()
      return state
    },
  }
}

/**
 * Resolve a model id to its family using the merged dataset.
 * @param {ReturnType<typeof createDataset>} dataset - live dataset.
 * @param {string} modelId - advertised model id.
 * @returns {string | null}
 */
export function familyFor(dataset, modelId) {
  return familyResolutionFor(dataset, modelId).key
}

/**
 * Resolve a model id to its family plus the trustworthiness of that match.
 *
 * @param {ReturnType<typeof createDataset>} dataset - live dataset.
 * @param {string} modelId - advertised model id.
 * @returns {{key: string|null, confidence: number, source: string, foldedFrom?: string[]}}
 */
export function familyResolutionFor(dataset, modelId) {
  const current = dataset.current
  const raw = String(modelId ?? '').trim().toLowerCase()
  if (raw === '') return { key: null, confidence: 0, source: 'identity' }
  const aliased = current.aliases[raw]
  if (aliased !== undefined) return { key: aliased, confidence: 1, source: 'alias' }
  const resolution = familyResolution(modelId, current.canonical, current.aliases)
  if (resolution.confidence > 0) return resolution
  // Fall back to the folded tables before accepting the identity family: this
  // is what folds `glm_5_3` onto the report's `glm-5.3` without an alias row.
  //
  // LOCAL PATCH 2026-10-24: the folded tables are also consulted for every
  // reduced spelling the id admits, so a spelling variant of a *renamed* build
  // (`sn-deepseek-v4_1_flash-1017`) reaches the same row as its exact sibling
  // instead of depending on which separators the lane happened to pick.
  const spellings = [{ key: raw, confidence: 1, ops: [] }, ...foldCandidates(raw)]
  for (const spelling of spellings) {
    const folded = foldKey(spelling.key)
    const canonical = current.canonicalFolded?.[folded]
    if (canonical !== undefined) {
      return spelling.ops.length === 0
        ? { key: canonical, confidence: 1, source: 'canonical' }
        : { key: canonical, confidence: spelling.confidence, source: 'folded', foldedFrom: spelling.ops }
    }
    const alias = current.aliasFolded?.[folded]
    if (alias !== undefined) {
      return spelling.ops.length === 0
        ? { key: alias, confidence: 1, source: 'alias' }
        : { key: alias, confidence: spelling.confidence, source: 'folded', foldedFrom: spelling.ops }
    }
  }
  return resolution
}

/**
 * Everything known about one family: measured intelligence, latency, composite
 * score, and the capability tags derived from the report's findings.
 *
 * @param {ReturnType<typeof createDataset>} dataset - live dataset.
 * @param {string | null} family - family id.
 * @returns {{family: string|null, intel: number|null, intelConfidence: number, estimatedIntel: number|null, ttftMs: number|null, score: number|null, note: string, tags: string[], known: boolean}}
 */
export function familyInfo(dataset, family) {
  const record = family === null ? undefined : dataset.current.families[family]
  const intel = record?.intel ?? null
  const estimatedIntel = record?.estimatedIntel ?? null
  return {
    family,
    intel,
    // Measured beats estimated beats nothing. The catalog multiplies this by
    // the family-resolution confidence, so a pattern match cannot pose as a
    // measurement.
    intelConfidence: intel !== null ? 0.9 : estimatedIntel !== null ? 0.45 : 0,
    estimatedIntel,
    ttftMs: record?.ttftMs ?? null,
    score: record?.score ?? null,
    fastestLane: record?.fastestLane ?? '',
    note: record?.note ?? '',
    tags: family === null ? [] : tagsOf(family),
    known: record !== undefined && (intel !== null || estimatedIntel !== null || record.ttftMs !== null),
  }
}

/**
 * The report's measured latency for one exact (lane, model) pair, or null.
 *
 * Only the exact pair is returned. The old code fell back to the family's
 * fastest-lane number, which let a 45-second lane inherit a 1-second lane's
 * speed — the single largest source of "priority feels wrong".
 *
 * @param {ReturnType<typeof createDataset>} dataset - live dataset.
 * @param {string|null} lane - report lane name for the provider.
 * @param {string} modelId - advertised model id.
 * @returns {number|null} milliseconds.
 */
export function reportLaneTtft(dataset, lane, modelId) {
  if (lane === null || lane === undefined) return null
  const record = dataset.current.models[String(modelId ?? '').trim().toLowerCase()]
  const value = record?.byLane?.[lane]
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Whether an advertised model id is denied by the report-derived block list.
 *
 * Matching is intentionally broad on the model segment: a lane may advertise
 * `nvidia/x:free`, `x-free`, or bare `x`, and all three name the same SKU.
 *
 * @param {ReturnType<typeof createDataset>} dataset - live dataset.
 * @param {string} modelId - advertised model id.
 * @returns {string | null} the reason, or null when the id is routable.
 */
export function deniedReason(dataset, modelId) {
  const raw = String(modelId ?? '').trim().toLowerCase()
  const folded = foldKey(raw)
  for (const [pattern, reason] of Object.entries(dataset.current.neverRoute)) {
    const key = String(pattern).toLowerCase()
    if (raw === key || raw.endsWith(`/${key}`)) return reason
    const foldedPattern = foldKey(key)
    if (folded === foldedPattern || folded.endsWith(`-${foldedPattern}`)) return reason
  }
  return null
}

export { resolveFamily, foldKey }
export default createDataset
