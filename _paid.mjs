
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createDataset } from './src/dataset.js'
import { createCatalog } from './src/catalog.js'
import { createHealth } from './src/health.js'
import { evaluate, resolvePreferenceGroup, selectRoute } from './src/router.js'
import { resolveConfig } from './src/config.js'

const overrides = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'model-orchestrator', 'overrides.json'), 'utf8'))
console.log('live config:', JSON.stringify({ mode: overrides.mode, preferModel: overrides.preferModel, denyProviders: overrides.denyProviders }))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-probe-'))
const dataset = createDataset({ userDir: tmp })

// Free lanes + BOTH paid lanes, exactly as the registry advertises them.
const models = {
  raccoon: ['sn-deepseek-v4-1-flash-1017'],
  'our-free-model': ['opencode/deepseek-v4.1-flash'],
  codearts: ['deepseek-v4.1-flash'],
  'deepseek-official': ['deepseek-v4.1-flash', 'deepseek-flash'],
  'deepseek-account': ['deepseek-v4.1-flash'],
}
const ctx = { llm: {
  listProviders: () => Object.keys(models).map(id => ({ id, name: id })),
  listModels: async (id) => models[id].map(m => ({ id: m, name: m })),
  resolveModelInfo: async () => ({ inputModalities: ['text'], context: { contextWindow: 1_000_000 } }),
} }
const config = resolveConfig(overrides, overrides)
const catalog = createCatalog({ ctx, dataset, getConfig: () => config })
await catalog.refresh('probe')
const health = createHealth({ userDir: null })
const now = Date.now()

console.log('\n-- every row in the merged family --')
for (const row of catalog.current.rows.filter(r => r.family === 'deepseek-v4.1-flash')) {
  console.log('  ' + (row.provider + '/' + row.model).padEnd(46), 'denied=' + String(row.denied).padEnd(5), row.deniedReason ?? '')
}
const evaluation = evaluate({ rows: catalog.current.rows, health, config, now })
const group = resolvePreferenceGroup(evaluation.allGroups, config.preferModel, config.preferProvider)
console.log('\n-- preference group --')
console.log('  all lanes (' + group.all.length + '):', group.all.map(e => e.row.provider + '/' + e.row.model).join(', '))
console.log('  eligible  (' + group.lanes.length + '):', group.lanes.map(e => e.row.provider + '/' + e.row.model).join(', '))
const decision = selectRoute({ rows: catalog.current.rows, health, config, now, mode: 'prefer', preference: { model: config.preferModel, provider: config.preferProvider, fallback: config.preferFallback } })
console.log('\n-- actual route --')
console.log('  mode=' + decision.mode, 'lane=' + decision.provider + '/' + decision.model, 'family=' + decision.family)
const paid = ['deepseek-official', 'deepseek-account']
console.log('\npaid lane reachable?', decision.provider !== undefined && paid.includes(decision.provider), '| paid lane in eligible set?', group.lanes.some(e => paid.includes(e.row.provider)))
