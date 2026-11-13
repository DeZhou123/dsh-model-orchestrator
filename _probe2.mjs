
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createDataset, familyFor, familyResolutionFor } from './src/dataset.js'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-'))
const dataset = createDataset({ userDir: tmp })
const ids = [
  'sn-qwen3.8-max-1017', 'deepseek-v4-pro-1017', 'glm-5.3-1017', 'glm-5.3-flash-20251017',
  'sn-glm-5-3-1017', 'kimi-k3-latest', 'kimi-k3-us', 'gpt-oss-20b-1017', 'nemotron-3-super-120b-a12b-1017',
  'deepseek-v4.1-flash-v2', 'deepseek-v4.1-flash-b3', 'mimo-v2.6-pro-intl', 'step-5-preview-20260420',
  'qwen3.8-max-sg', 'spark-x2.5-1017', 'minimax-m3.1-flash-preview-1017', 'totally-new-0424',
]
for (const id of ids) {
  const r = familyResolutionFor(dataset, id)
  console.log(id.padEnd(38), '->', String(r.key).padEnd(30), String(r.confidence).padEnd(5), r.source, r.foldedFrom ? JSON.stringify(r.foldedFrom) : '')
}
const t0 = process.hrtime.bigint()
for (let i = 0; i < 200; i++) familyResolutionFor(dataset, 'sn-deepseek-v4-1-flash-1017')
const ms = Number(process.hrtime.bigint() - t0) / 1e6
console.log('\n200 resolutions took', ms.toFixed(1), 'ms =>', (ms / 200).toFixed(3), 'ms per row')
