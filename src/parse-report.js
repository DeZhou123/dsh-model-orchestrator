/**
 * The "Our Free Model 全渠道模型测速 + 智力排序" report parser.
 *
 * The report is the only place the Artificial Analysis v4.3.2 numbers exist —
 * they cannot be fetched at runtime — so re-importing a refreshed report has to
 * be a one-liner. Parsing beats hand-copying 150 rows into the source.
 *
 * @module src/parse-report
 */

/** Strip markdown emphasis and inline-code from one table cell. */
export function cell(text) {
  return String(text).replace(/\*\*/g, '').replace(/`/g, '').trim()
}

/** Split one markdown table row into trimmed cells. */
function cells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(part => part.trim())
}

/** A separator row is dashes and colons only. */
function isSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')
}

/**
 * Read one `| ... |` table starting at its header row.
 *
 * The report wraps long cells across physical lines: some rows end mid-cell
 * without a trailing `|`, and a few continuation lines do not start with one
 * either (the 备注 column of section 五 does both). Treating "no trailing pipe"
 * as "the row continues" is what keeps those rows intact instead of silently
 * truncating the table.
 */
function readTable(lines, start) {
  const columns = cells(lines[start]).length
  const rows = []
  let i = start + 1
  if (i < lines.length && isSeparator(lines[i])) i += 1

  for (; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim().startsWith('|')) break
    if (isSeparator(line)) continue

    let raw = line
    while (!raw.trim().endsWith('|') && i + 1 < lines.length) {
      i += 1
      raw = `${raw} ${lines[i].trim()}`
    }

    const row = cells(raw)
    // An embedded pipe inside cell text would over-split; fold the overflow back
    // into the last declared column.
    if (row.length > columns) {
      rows.push([...row.slice(0, columns - 1), row.slice(columns - 1).join(' | ')])
    } else {
      rows.push(row)
    }
  }
  return { rows, end: i }
}

/** Parse a latency cell such as `955ms`, `34.0s`, `—`. */
export function parseMs(text) {
  const value = cell(text)
  if (value === '' || value === '—' || value === '-' || value === '?') return null
  const seconds = /^([\d.]+)\s*s$/i.exec(value)
  if (seconds !== null) return Math.round(Number(seconds[1]) * 1000)
  const millis = /^([\d.]+)\s*ms$/i.exec(value)
  if (millis !== null) return Math.round(Number(millis[1]))
  const plain = Number(value)
  return Number.isFinite(plain) ? Math.round(plain) : null
}

/** Parse an intelligence cell; `未知` and empty mean "no verified score". */
export function parseIntel(text) {
  const value = cell(text)
  if (value === '' || value === '未知' || value === '—' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** First inline-code span in a cell, e.g. "**`glm-5.3`**" -> "glm-5.3". */
export function codeId(text) {
  const match = /`([^`]+)`/.exec(String(text))
  return match === null ? cell(text) : match[1].trim()
}

/**
 * Parse the whole report.
 * @param {string} markdown - report source.
 * @returns {{reportVersion: string, generatedAt: string, families: object[], lanes: object[], estimates: object[], unscored: object[], unusable: object[]}}
 */
export function parseReport(markdown) {
  const lines = markdown.split(/\r?\n/)

  let reportVersion = ''
  let generatedAt = ''
  const versionMatch = /插件版本\s*([\d.]+)/.exec(markdown)
  if (versionMatch !== null) reportVersion = versionMatch[1]
  const timeMatch = /生成时间：([^\s　·]+)/.exec(markdown)
  if (timeMatch !== null) generatedAt = timeMatch[1]

  const families = []
  const estimates = []
  const unscored = []
  const lanes = []
  const unusable = []

  let section = ''

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    const heading = /^##\s+([一二三四五六七八九十]+)、/.exec(line.trim())
    if (heading !== null) {
      section = heading[1]
      continue
    }

    // ── section 六: one <details> block per lane ──────────────────────────
    const summary = /<details><summary><b>(.+?)<\/b>\s*—\s*(.*?)<\/summary>/.exec(line)
    if (summary !== null && section === '六') {
      const name = cell(summary[1])
      const meta = cell(summary[2])
      let cursor = i + 1
      while (cursor < lines.length && !lines[cursor].trim().startsWith('|')) cursor += 1
      const table = readTable(lines, cursor)
      const models = []
      for (const row of table.rows) {
        const id = codeId(row[0] ?? '')
        if (id === '' || id === '模型' || id === 'Model') continue
        const status = cell(row[5] ?? '')
        const ok = status.startsWith('✅')
        models.push({
          id,
          intel: parseIntel(row[1] ?? ''),
          ttftMs: parseMs(row[2] ?? ''),
          outputTokens: Number.isFinite(Number(cell(row[3] ?? ''))) && cell(row[3] ?? '') !== '' ? Number(cell(row[3])) : null,
          ok,
          status: ok ? 'ok' : status,
        })
      }
      lanes.push({ name, meta, models })
      i = table.end - 1
      continue
    }

    // ── section 三: the ranked family table ──────────────────────────────
    if (section === '三' && line.trim().startsWith('| #')) {
      const table = readTable(lines, i)
      for (const row of table.rows) {
        const id = codeId(row[1] ?? '')
        if (id === '') continue
        families.push({
          id,
          intel: parseIntel(row[2] ?? ''),
          fastestLane: cell(row[3] ?? ''),
          ttftMs: parseMs(row[4] ?? ''),
          score: Number.isFinite(Number(cell(row[5] ?? ''))) ? Number(cell(row[5])) : null,
          note: cell(row[6] ?? ''),
          estimated: false,
        })
      }
      i = table.end - 1
      continue
    }

    // ── section 四: AA estimate-only families (never ranked) ─────────────
    if (section === '四' && line.trim().startsWith('| 模型家族')) {
      const table = readTable(lines, i)
      for (const row of table.rows) {
        const id = codeId(row[0] ?? '')
        if (id === '') continue
        estimates.push({
          id,
          estimatedIntel: parseIntel(String(row[1] ?? '').replace('~', '')),
          lane: cell(row[2] ?? ''),
          ttftMs: parseMs(row[3] ?? ''),
          note: cell(row[4] ?? ''),
        })
      }
      i = table.end - 1
      continue
    }

    // ── section 五: families with no intelligence data at all ────────────
    if (section === '五' && line.trim().startsWith('| # | 模型家族')) {
      const table = readTable(lines, i)
      for (const row of table.rows) {
        const id = codeId(row[1] ?? '')
        if (id === '') continue
        unscored.push({
          id,
          lane: cell(row[2] ?? ''),
          ttftMs: parseMs(row[3] ?? ''),
          laneCount: Number(cell(row[4] ?? '')) || null,
          note: cell(row[5] ?? ''),
        })
      }
      i = table.end - 1
      continue
    }

    // ── section 七: models whose every lane failed ───────────────────────
    if (section === '七' && line.trim().startsWith('| `')) {
      const row = cells(line)
      const fullId = codeId(row[0] ?? '')
      if (fullId !== '') unusable.push({ fullId, lane: cell(row[1] ?? ''), reason: cell(row[2] ?? '') })
    }
  }

  return { reportVersion, generatedAt, families, lanes, estimates, unscored, unusable }
}

export default parseReport
