
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createDataset } from './src/dataset.js'
import { createCatalog } from './src/catalog.js'
import { createHealth } from './src/health.js'
import { evaluate } from './src/router.js'
import { resolveConfig } from './src/config.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-probe-'))
const dataset = createDataset({ userDir: tmp })

// The rows the real registry advertises for the DeepSeek V4.1 Flash weights,
// copied from the picker screenshot + channel-pack/token-ledger.json.
const models = [
  ['raccoon', 'sn-deepseek-v4-1-flash-1017'],
  ['raccoon', 'sn-deepseek-v4-1-flash'],
  ['our-free-model', 'opencode/deepseek-v4.1-flash'],
  ['codearts', 'deepseek-v4.1-flash'],
  ['buddy', 'deepseek-v4.1-flash'],
  ['workbuddy', 'deepseek-v4.1-flash-sg'],
  ['loomy', 'DeepSeek-V4.1-Flash'],
  ['trae', 'deepseek/deepseek-v4.1-flash:batch'],
]
const byProvider = new Map()
for (const [provider, model] of models) {
  if (!byProvider.has(provider)) byProvider.set(provider, [])
  byProvider.get(provider).push({ id: model, name: model })
}
const ctx = { llm: {
  listProviders: () => [...byProvider.keys()].map(id => ({ id, name: id })),
  listModels: async (id) => byProvider.get(id) ?? [],
  resolveModelInfo: async () => ({ inputModalities: ['text'], context: { contextWindow: 1_000_000 } }),
} }
const catalog = createCatalog({ ctx, dataset, getConfig: () => resolveConfig({}, {}) })
await catalog.refresh('probe')
const rows = catalog.current.rows
const health = createHealth({ userDir: null })
const evaluation = evaluate({ rows, health, config: resolveConfig({}, {}), now: Date.now() })
const target = evaluation.groups.filter(g => String(g.key).includes('deepseek'))
console.log('groups touching deepseek:')
for (const g of target) {
  console.log('  family=' + String(g.family) + '  lanes=' + g.lanes.length + '/' + g.all.length +
    '  providers=' + [...new Set(g.all.map(e => e.row.provider))].join(',') +
    '  denied=' + g.all.filter(e => e.row.denied).length +
    '  intel=' + g.intel)
}
const row = catalog.current.rows.find(r => r.model === 'sn-deepseek-v4-1-flash-1017')
console.log('\nrow detail:', JSON.stringify({ family: row.family, key: row.key, source: row.familySource, conf: row.familyConfidence, quality: Math.round(row.quality * 1000) / 1000, intel: row.intel, tags: row.tags }))
