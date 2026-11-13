/**
 * Merge a fresher priority dataset (the per-user import store) into the shipped
 * built-in reference, and optionally fold in verified identity fingerprints.
 *
 * Why: `src/priority-data.json` is built from REPORT-模型测速与优先级.md, but the
 * report file on disk was overwritten with a 174-line fragment on 2026-11-12 while
 * the 2026-10-23 import had already parsed the full 559-line report into
 * `~/.dsh/model-orchestrator/priority.json` (13 lanes / 121 ids / 79 families).
 * Rebuilding from the surviving parsed copy is the only way to get the extra lane
 * and the 6 families back.
 *
 * Run: node tools/_merge-priority.mjs [--write]
 *
 * Without --write it only reports the delta. The routing policy is untouched:
 * this script edits data, never `src/policy-defaults.js`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TARGET = path.join(ROOT, 'src', 'priority-data.json')
const STORE = process.env.DSH_PRIORITY_STORE ?? path.join(os.homedir(), '.dsh', 'model-orchestrator', 'priority.json')

const write = process.argv.includes('--write')
const built = JSON.parse(fs.readFileSync(TARGET, 'utf8'))
if (!fs.existsSync(STORE)) {
  console.error('priority store not found: ' + STORE)
  process.exit(2)
}
const store = JSON.parse(fs.readFileSync(STORE, 'utf8'))

const added = { families: [], models: [], lanes: [], canonical: [] }

for (const [key, family] of Object.entries(store.families ?? {})) {
  if (built.families[key] !== undefined) continue
  built.families[key] = family
  added.families.push(key)
}
for (const [key, model] of Object.entries(store.models ?? {})) {
  if (built.models[key] !== undefined) continue
  built.models[key] = { status: model.ok ? 'ok' : 'failed', ...model }
  added.models.push(key)
}
for (const [key, value] of Object.entries(store.canonical ?? {})) {
  if (built.canonical[key] !== undefined) continue
  built.canonical[key] = value
  added.canonical.push(key)
}
for (const lane of store.lanes ?? []) {
  const existing = built.lanes.find(entry => entry.name === lane.name)
  if (existing === undefined) {
    built.lanes.push(lane)
    added.lanes.push(lane.name)
    continue
  }
  const merged = [...new Set([...(existing.families ?? []), ...(lane.families ?? [])])]
  if (merged.length !== (existing.families ?? []).length) existing.families = merged
}

// Verified aliases from a live catalog sweep (_catalog-diff.json): only ids that
// were actually observed on a lane and resolved to a family we already ship.
const diffPath = path.join(ROOT, '_catalog-diff.json')
if (fs.existsSync(diffPath)) {
  const diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'))
  const shipped = new Set(Object.keys(built.families))
  for (const entry of diff.newIds ?? []) {
    if (entry.scope !== 'observed') continue
    if (Number(entry.confidence) < 0.6) continue
    // Skip ids the pipeline already folds on its own: a lane marker (-1017), a
    // tier marker (-free / :free / -official) or an OpenRouter preset. Adding
    // those to canonical would turn a reported fold ("folded", 0.95, foldedFrom:
    // ["build-tag"]) into a silent exact hit, which tools/smoke.mjs guards.
    if (entry.family === null) continue
    if (/[-:]\d{4}$/.test(String(entry.id))) continue
    if (/[:\-](?:free|official|async|batch)$/.test(String(entry.id))) continue
    if (String(entry.id).includes('@preset/')) continue
    if (entry.family === null || !shipped.has(entry.family)) continue
    const alias = String(entry.id).toLowerCase()
    if (built.canonical[alias] === entry.family) continue
    built.canonical[alias] = entry.family
    added.canonical.push(entry.id)
  }
}

built.source = {
  ...built.source,
  parsedAt: new Date().toISOString(),
  modelCount: Object.keys(built.models).length,
  familyCount: Object.keys(built.families).length,
  laneCount: built.lanes.length,
  derivedFrom: [
    'REPORT-模型测速与优先级.md v' + (store.source?.reportVersion ?? '?') +
      ' (' + (store.source?.generatedAt ?? '?') + ') via import ' + (store.source?.importedAt ?? '?'),
  ],
}

console.log('target :', TARGET)
console.log('store  :', STORE)
console.log('delta  : +' + added.families.length + ' families, +' + added.models.length +
  ' ids, +' + added.lanes.length + ' lanes, +' + added.canonical.length + ' canonical')
if (added.families.length !== 0) console.log('  families:', added.families.join(', '))
if (added.lanes.length !== 0) console.log('  lanes   :', added.lanes.join(', '))
if (added.models.length !== 0) console.log('  models  :', added.models.join(', '))
console.log('totals : ' + Object.keys(built.models).length + ' ids / ' +
  Object.keys(built.families).length + ' families / ' + built.lanes.length + ' lanes')

if (!write) {
  console.log('(dry run — pass --write to persist)')
} else {
  fs.writeFileSync(TARGET, JSON.stringify(built, null, 2) + '\n', 'utf8')
  console.log('wrote', TARGET)
}
