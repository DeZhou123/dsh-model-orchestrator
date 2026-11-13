/**
 * Rebuild REPORT-模型测速与优先级.md as a view of src/priority-data.json.
 *
 * Why this exists: the hand-maintained report is the only carrier of the
 * Artificial Analysis numbers, and on 2026-11-12 the working copy was
 * overwritten with a 174-line fragment (the parse-able file was 559 lines,
 * 13 lanes / 121 ids). `tools/smoke.mjs` then failed outright, because
 * `datasetFromReport` refuses a file with neither a ranking section nor
 * per-lane detail. The measured facts survived in the shipped dataset and in
 * the user import store, so the report can be regenerated from them instead of
 * hand-typed again.
 *
 * Run: node tools/_rebuild-report.mjs [--write]
 *
 * The emitted file is DERIVED, not measured: everything in it is a projection of
 * `src/priority-data.json`, and `tools/build-data.mjs` can read it back to the
 * same dataset. Keep the hand-measured rows (section 七 reasons, section 二
 * corrections) in this file's header when re-measuring for real.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA = path.join(ROOT, 'src', 'priority-data.json')
// Same location tools/smoke.mjs reads: the workspace root, one level above the package.
const TARGET = process.env.DSH_MODEL_REPORT ?? path.resolve(ROOT, '..', 'REPORT-模型测速与优先级.md')

const write = process.argv.includes('--write')
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'))

const families = Object.entries(data.families)
const scored = families.filter(([, f]) => f.intel !== null)
const estimated = families.filter(([, f]) => f.intel === null && f.estimatedIntel !== null && f.estimatedIntel !== undefined)
const unscored = families.filter(([, f]) => f.intel === null && (f.estimatedIntel === null || f.estimatedIntel === undefined))

const ms = value => (value === null || value === undefined ? '—' : (value >= 10000 ? (value / 1000).toFixed(1) + 's' : Math.round(value) + 'ms'))
const num = value => (value === null || value === undefined ? '未知' : String(value))
const dash = value => (value === null || value === undefined || value === '' ? '—' : String(value))

const out = []
out.push('# 全渠道模型测速 + 智力排序')
out.push('')
out.push('> 本文件由 `node tools/_rebuild-report.mjs` 从 `src/priority-data.json` 重新生成 ——')
out.push('> 它是数据集的一个**视图**，不是一次新的实测。重新实测请保留本段并替换下方各表。')
out.push('')
out.push('- 插件版本 ' + (data.source?.reportVersion ?? '2.2.0'))
out.push('- 生成时间：' + (data.source?.generatedAt ?? '2026/10/14'))
out.push('- 重建时间：' + new Date().toISOString().slice(0, 10))
out.push('- 覆盖：' + Object.keys(data.models).length + ' 个 id / ' + families.length + ' 个家族 / ' + data.lanes.length + ' 条车道')
out.push('')

out.push('## 一、口径')
out.push('')
out.push('- **智力**取 Artificial Analysis 推理版 (max) 档，按家族填同一个值；同家族跨渠道只有延迟与配额差异。')
out.push('- **首字延迟 (TTFT)** 取第一个可见正文增量到达的时刻，单位 ms；`—` 表示该车道未取到。')
out.push('- 综合分只对实测家族给出，未实测家族留空。')
out.push('')

out.push('## 二、修正记录')
out.push('')
out.push('- 2026-11-12 本文件的工作副本被截断为 174 行片段，已按数据集重建；原始实测片段保留在 git 之外，见 `_report-fragment-20261112.bak`。')
out.push('- 智谱宣传 GLM-5.3-Flash 在 AA 上得 57（称媲美 Opus 4.8），AA 实测 42，按 42 计。')
out.push('')

out.push('## 三、智力排序（有实测智力分的家族）')
out.push('')
out.push('| # | 模型家族 | 智力 | 最快车道 | 首字延迟 | 综合分 | 备注 |')
out.push('| ---: | --- | ---: | --- | ---: | ---: | --- |')
scored.sort((a, b) => (b[1].intel ?? 0) - (a[1].intel ?? 0)).forEach(([id, f], i) => {
  out.push('| ' + (i + 1) + ' | `' + id + '` | ' + num(f.intel) + ' | ' + dash(f.fastestLane) + ' | ' +
    ms(f.ttftMs) + ' | ' + dash(f.score) + ' | ' + dash(f.note) + ' |')
})
out.push('')

out.push('## 四、仅有估算智力的家族')
out.push('')
out.push('| 模型家族 | 估算智力 | 车道 | 首字延迟 | 备注 |')
out.push('| --- | ---: | --- | ---: | --- |')
for (const [id, f] of estimated) {
  out.push('| `' + id + '` | ~' + num(f.estimatedIntel) + ' | ' + dash(f.fastestLane) + ' | ' + ms(f.ttftMs) + ' | ' + dash(f.note) + ' |')
}
out.push('')

out.push('## 五、没有智力数据的家族')
out.push('')
out.push('| # | 模型家族 | 车道 | 首字延迟 | 车道数 | 备注 |')
out.push('| ---: | --- | --- | ---: | ---: | --- |')
unscored.forEach(([id, f], i) => {
  out.push('| ' + (i + 1) + ' | `' + id + '` | ' + dash(f.fastestLane) + ' | ' + ms(f.ttftMs) + ' | ' +
    dash(f.laneCount ?? Object.keys(data.models).filter(k => data.models[k].family === id).length) + ' | ' + dash(f.note) + ' |')
})
out.push('')

out.push('## 六、分车道明细')
out.push('')
for (const lane of data.lanes) {
  const rows = Object.entries(data.models).filter(([, m]) => (m.lanes ?? []).includes(lane.name))
  const okCount = rows.filter(([, m]) => m.ok === true).length
  const famCount = new Set(rows.map(([, m]) => m.family)).size
  out.push('<details><summary><b>' + lane.name + '</b> — ' + famCount + ' 个家族，' + okCount + ' 个实测成功</summary>')
  out.push('')
  out.push('| 模型 | 智力 | 首字延迟 | 输出 tok | tok/s | 状态 |')
  out.push('| --- | ---: | ---: | ---: | ---: | --- |')
  for (const [, model] of rows) {
    const id = model.id ?? ''
    const ttft = model.byLane?.[lane.name] ?? model.ttftMs ?? null
    out.push('| \`' + id + '\` | ' + num(model.intel) + ' | ' + ms(ttft) + ' | ' +
      dash(model.outputTokens) + ' | — | ' + (model.ok === true ? '✅' : dash(model.status) || '❌') + ' |')
  }
  out.push('')
  out.push('</details>')
  out.push('')
}

out.push('## 七、全部渠道实测失败的模型')
out.push('')
out.push('| 模型 | 车道 | 原因 |')
out.push('| --- | --- | --- |')
for (const entry of data.unusable ?? []) {
  out.push('| `' + entry.fullId + '` | ' + dash(entry.lane) + ' | ' + dash(entry.reason) + ' |')
}
out.push('')

out.push('## 八、方法说明与已知坑')
out.push('')
out.push('- 测速口径：每个模型发一条流式 `chat/completions`，内容为 `Reply with exactly: OK`，`max_tokens: 4096`，`include_usage: true`。')
out.push('- `tok/s` 带星号表示不可信："OK" 只有 2 个 token，除以接近 0 的时间窗会算出 666 tok/s；排序一律用 TTFT。')
out.push('- 超时 120 秒（重试轮 180 秒，最多 3 次，429 退避 25 秒）。思考型模型长时间静默会被记成超时，不代表其正常速度。')
out.push('- 排除项：`nemotron-3.5-content-safety` 是护栏分类器、`jev-1.13` 是概率输出模型，结构上不是通用智能模型。')
out.push('')

out.push('## 九、别名与指纹（渠道异名 -> 家族）')
out.push('')
out.push('| 别名 id | 家族 | 置信度 | 依据 |')
out.push('| --- | --- | --- | --- |')
const familyIds = new Set(families.map(([id]) => id))
const aliasRows = Object.entries(data.canonical ?? {}).filter(([alias, family]) => alias !== family.toLowerCase() && !familyIds.has(alias))
for (const [alias, family] of aliasRows) {
  out.push('| \`' + alias + '\` | \`' + family + '\` | verified | 渠道异名归一（见 src/families.js 与 _fingerprint-report.md） |')
}
if (aliasRows.length === 0) out.push('| — | — | — | 暂无 |')
out.push('')

const text = out.join('\n') + '\n'
console.log('report would be', text.split('\n').length, 'lines,', text.length, 'bytes')
console.log('  scored   :', scored.length)
console.log('  estimated:', estimated.length)
console.log('  unscored :', unscored.length)
console.log('  lanes    :', data.lanes.length)
if (!write) { console.log('(dry run — pass --write to persist)') } else {
  if (fs.existsSync(TARGET)) fs.copyFileSync(TARGET, TARGET.replace(/\.md$/, '') + '.bak-' + new Date().toISOString().slice(0, 10) + '.md')
  fs.writeFileSync(TARGET, text, 'utf8')
  console.log('wrote', TARGET)
}
