/**
 * Build `src/priority-data.json` from the speed/intelligence report.
 *
 * Run: node tools/build-data.mjs [path/to/REPORT-模型测速与优先级.md]
 *
 * The shipped dataset carries measured facts only (intelligence, first-token
 * latency, composite score, which lane advertised which id). Routing policy
 * stays in `src/policy-defaults.js` so a re-import cannot silently change how
 * the orchestrator behaves.
 *
 * @module tools/build-data.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseReport } from '../src/parse-report.js'
import { resolveFamily, normalizeModelId } from '../src/families.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const DEFAULT_REPORT = process.env.DSH_MODEL_REPORT ?? path.join(ROOT, 'REPORT-模型测速与优先级.md')

const reportPath = process.argv[2] ?? DEFAULT_REPORT
if (!fs.existsSync(reportPath)) {
  console.error(`report not found: ${reportPath}`)
  console.error('usage: node tools/build-data.mjs <REPORT-模型测速与优先级.md>   (or set DSH_MODEL_REPORT)')
  process.exit(2)
}
const markdown = fs.readFileSync(reportPath, 'utf8')
const report = parseReport(markdown)

const canonical = {}
for (const family of report.families) canonical[family.id.toLowerCase()] = family.id
for (const estimate of report.estimates) {
  if (canonical[estimate.id.toLowerCase()] === undefined) canonical[estimate.id.toLowerCase()] = estimate.id
}
for (const entry of report.unscored) {
  if (canonical[entry.id.toLowerCase()] === undefined) canonical[entry.id.toLowerCase()] = entry.id
}

// ── families ────────────────────────────────────────────────────────────────
const families = {}
for (const family of report.families) {
  families[family.id] = {
    intel: family.intel,
    ttftMs: family.ttftMs,
    score: family.score,
    fastestLane: family.fastestLane,
    note: family.note,
    estimated: false,
  }
}
for (const estimate of report.estimates) {
  if (families[estimate.id] !== undefined) continue
  families[estimate.id] = {
    intel: null,
    estimatedIntel: estimate.estimatedIntel,
    ttftMs: estimate.ttftMs,
    score: null,
    fastestLane: estimate.lane,
    note: estimate.note,
    estimated: true,
  }
}
for (const entry of report.unscored) {
  if (families[entry.id] !== undefined) continue
  families[entry.id] = {
    intel: null,
    estimatedIntel: null,
    ttftMs: entry.ttftMs,
    score: null,
    fastestLane: entry.lane,
    note: entry.note,
    estimated: true,
    laneCount: entry.laneCount,
  }
}

// ── advertised ids, per lane ────────────────────────────────────────────────
const models = {}
for (const lane of report.lanes) {
  for (const model of lane.models) {
    const key = model.id.toLowerCase()
    const family = resolveFamily(model.id, canonical)
    const entry = models[key] ?? (models[key] = {
      id: model.id,
      family,
      intel: model.intel,
      ttftMs: model.ttftMs,
      outputTokens: model.outputTokens,
      // The same weights on six lanes differ only in latency and quota, so the
      // latency has to stay attached to the lane. Collapsing it to one number
      // would score a 6-second lane with the 1-second lane's speed.
      byLane: {},
      lanes: [],
      ok: false,
      status: model.status,
    })
    if (!entry.lanes.includes(lane.name)) entry.lanes.push(lane.name)
    if (model.ttftMs !== null) entry.byLane[lane.name] = model.ttftMs
    if (entry.intel === null && model.intel !== null) entry.intel = model.intel
    if (entry.ttftMs === null && model.ttftMs !== null) entry.ttftMs = model.ttftMs
    if (entry.outputTokens === null && model.outputTokens !== null) entry.outputTokens = model.outputTokens
    entry.ok = entry.ok || model.ok
  }
}

// ── lanes, for the UI and for lane-level policy ─────────────────────────────
const lanes = report.lanes.map(lane => ({
  name: lane.name,
  meta: lane.meta,
  families: [...new Set(lane.models.map(model => resolveFamily(model.id, canonical)).filter(Boolean))],
  modelCount: lane.models.length,
  okCount: lane.models.filter(model => model.ok).length,
}))

const output = {
  source: {
    reportVersion: report.reportVersion,
    generatedAt: report.generatedAt,
    parsedAt: new Date().toISOString(),
    reportPath,
    modelCount: Object.keys(models).length,
    familyCount: Object.keys(families).length,
    laneCount: lanes.length,
  },
  canonical,
  families,
  models,
  lanes,
  unusable: report.unusable,
}

const target = path.join(ROOT, 'src', 'priority-data.json')
fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const scored = Object.values(families).filter(family => family.intel !== null).length
const unresolved = Object.values(models).filter(model => model.family === null).length
const distinctFamilies = new Set(Object.values(models).map(model => model.family))
console.log(`wrote ${target}`)
console.log(`  report      : v${report.reportVersion} (${report.generatedAt})`)
console.log(`  lanes       : ${lanes.length}`)
console.log(`  advertised  : ${Object.keys(models).length} ids -> ${distinctFamilies.size} families`)
console.log(`  families    : ${Object.keys(families).length} (${scored} with a measured intelligence score)`)
console.log(`  unresolved  : ${unresolved}`)
const sample = ['sn-glm-5-3', 'gmodel', 'z-ai/glm-5.3', 'dfmodel', 'kmodel_latest', 'stepfun/step-5-preview-free']
for (const id of sample) {
  const key = id.toLowerCase()
  console.log(`  ${id.padEnd(30)} -> ${models[key]?.family ?? '(not advertised)'}   [normalized ${normalizeModelId(id)}]`)
}
