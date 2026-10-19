/**
 * Turn a refreshed report into the user's priority layer.
 *
 * The bundled dataset is a build artifact: it is regenerated with
 * `node tools/build-data.mjs` and travels with the package. A user who has a
 * newer report should not need a rebuild — this module parses the markdown at
 * runtime and produces the same shape, which `createDataset` merges over the
 * shipped facts. Later wins, so an import can correct a stale score without
 * touching the package.
 *
 * @module src/report-import
 */

import { parseReport } from './parse-report.js'
import { resolveFamily } from './families.js'

/**
 * Parse report markdown into a user dataset layer.
 *
 * @param {string} markdown - report source.
 * @param {object} [options]
 * @param {Record<string, string>} [options.baseCanonical] - families the shipped dataset already knows.
 * @returns {{dataset: object, stats: object}}
 */
export function datasetFromReport(markdown, options = {}) {
  const report = parseReport(markdown)
  if (report.families.length === 0 && report.lanes.length === 0) {
    throw new Error('这不是一份可识别的测速报告：既没有排名字段，也没有分车道明细')
  }

  const canonical = { ...(options.baseCanonical ?? {}) }
  for (const family of report.families) canonical[family.id.toLowerCase()] = family.id
  for (const estimate of report.estimates) {
    if (canonical[estimate.id.toLowerCase()] === undefined) canonical[estimate.id.toLowerCase()] = estimate.id
  }
  for (const entry of report.unscored) {
    if (canonical[entry.id.toLowerCase()] === undefined) canonical[entry.id.toLowerCase()] = entry.id
  }

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
        // Per-lane latency, because the same weights on six lanes differ only in
        // latency and quota: a single number would score a 6-second lane with the
        // 1-second lane's speed.
        byLane: {},
        lanes: [],
        ok: false,
      })
      if (!entry.lanes.includes(lane.name)) entry.lanes.push(lane.name)
      if (model.ttftMs !== null) entry.byLane[lane.name] = model.ttftMs
      if (entry.intel === null && model.intel !== null) entry.intel = model.intel
      if (entry.ttftMs === null && model.ttftMs !== null) entry.ttftMs = model.ttftMs
      entry.ok = entry.ok || model.ok
    }
  }

  const dataset = {
    canonical,
    families,
    models,
    lanes: report.lanes.map(lane => ({
      name: lane.name,
      meta: lane.meta,
      families: [...new Set(lane.models.map(model => resolveFamily(model.id, canonical)).filter(Boolean))],
      modelCount: lane.models.length,
      okCount: lane.models.filter(model => model.ok).length,
    })),
    importSource: { reportVersion: report.reportVersion, generatedAt: report.generatedAt },
  }

  return {
    dataset,
    stats: {
      reportVersion: report.reportVersion,
      generatedAt: report.generatedAt,
      lanes: report.lanes.length,
      /** Rows across all lanes — the report's "162 models" figure. */
      laneRows: report.lanes.reduce((total, lane) => total + lane.models.length, 0),
      /** Distinct advertised ids — the same family repeats on several lanes. */
      advertisedIds: Object.keys(models).length,
      /** Distinct resolved families — the report's "76 families" figure. */
      distinctFamilies: new Set(Object.values(models).map(model => model.family)).size,
      /** Family records the report has something to say about. */
      families: Object.keys(families).length,
      withIntel: Object.values(families).filter(family => family.intel !== null).length,
      unusable: report.unusable.length,
    },
  }
}

export default datasetFromReport
