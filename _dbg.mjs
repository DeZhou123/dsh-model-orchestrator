
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createDataset } from './src/dataset.js'
import { createCatalog } from './src/catalog.js'
import { resolveConfig } from './src/config.js'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'))
const dataset = createDataset({ userDir: tmp })
const models = { buddy: ['sn-deepseek-v4-1-flash-1017'], trae: ['opencode/deepseek-v4.1-flash'] }
const llm = { listProviders: () => Object.keys(models).map(id => ({ id, name: id })), listModels: async id => models[id].map(m => ({ id: m, name: m })), resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
const cfg = resolveConfig({ deny: ['buddy/sn-deepseek-v4-1-flash-1017'] }, {})
console.log('resolved deny =', JSON.stringify(cfg.deny))
const catalog = createCatalog({ ctx: { llm }, dataset, channelData: null, getConfig: () => cfg })
await catalog.refresh('t')
for (const row of catalog.current.rows) console.log(row.provider + '/' + row.model, 'family=' + row.family, 'denied=' + row.denied, row.deniedReason ?? '')
