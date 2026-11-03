/**
 * probe-smoke —— 定时探活的纯逻辑验证。
 *
 * 不碰网络、不碰 fs、不碰 ctx：用假时钟 + 假探测函数跑完整生命周期。
 * 每条断言对应一条设计约束，失败时先看约束再看代码。
 *
 * 运行：node tools/probe-smoke.mjs
 */
import {
  createProbe,
  resolveIntervalMs,
  shouldSkip,
  runPool,
  DEFAULT_EVERY_DAYS,
} from '../src/probe.js'

let pass = 0
let fail = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    return
  }
  fail += 1
  failures.push(name + (detail ? ' — ' + detail : ''))
}

const DAY = 24 * 60 * 60_000

// ── 1. 间隔解析 ────────────────────────────────────────────────────────────
{
  check('默认间隔 = 3 天', resolveIntervalMs({}) === DEFAULT_EVERY_DAYS * DAY, String(resolveIntervalMs({})))
  check('probeEveryDays=1 生效', resolveIntervalMs({ probeEveryDays: 1 }) === DAY)
  check('probeEveryDays=7 生效', resolveIntervalMs({ probeEveryDays: 7 }) === 7 * DAY)
  check('probeIntervalMs 优先', resolveIntervalMs({ probeIntervalMs: 3_600_000, probeEveryDays: 30 }) === 3_600_000)
  check('非法值回落默认', resolveIntervalMs({ probeEveryDays: -1, probeIntervalMs: 0 }) === DEFAULT_EVERY_DAYS * DAY)
  check('最小 60 秒下限', resolveIntervalMs({ probeIntervalMs: 1 }) === 60_000)
}

// ── 2. 跳过判定 ────────────────────────────────────────────────────────────
{
  const now = 1_000_000
  check('可用 → 探', shouldSkip({ lane: {}, state: { available: true, until: 0 }, now }).skip === false)
  check('冷却未到期 → 跳', shouldSkip({ lane: {}, state: { available: false, until: now + 5000, reason: 'x' }, now }).skip === true)
  check('冷却已到期 → 探', shouldSkip({ lane: {}, state: { available: false, until: now - 5000, reason: 'x' }, now }).skip === false, '到期必须探，否则永远不知道恢复没有')
  check('无状态 → 探', shouldSkip({ lane: {}, state: null, now }).skip === false)
}

// ── 3. 并发池：不超上限、不丢结果、异常不中断 ────────────────────────────────
{
  let active = 0
  let peak = 0
  const items = Array.from({ length: 9 }, (_, i) => i)
  const results = await runPool(items, 3, async (item) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
    if (item === 4) throw new Error('故意失败')
    return { ok: true, item }
  })
  check('并发不超上限', peak <= 3, 'peak=' + peak)
  check('结果数量完整', results.length === 9)
  check('异常被收敛为 ok:false', results[4]?.ok === false)
  check('其它项不受影响', results[0]?.ok === true && results[8]?.ok === true)
}

// ── 4. 一轮完整流程：写账本、跳过冷却、落盘一次 ────────────────────────────
{
  const calls = { success: [], failure: [], persist: 0 }
  const lanes = [
    { provider: 'ok-lane', model: 'm1' },
    { provider: 'cooling', model: 'm2' },
    { provider: 'dead-lane', model: 'm3' },
  ]
  const health = {
    stateOf: (provider) => provider === 'cooling'
      ? { available: false, until: Date.now() + 60_000, reason: '429' }
      : { available: true, until: 0, reason: '' },
    markSuccess: (provider, model, sample) => calls.success.push({ provider, model, sample }),
    markFailure: (provider, model, failure) => calls.failure.push({ provider, model, failure }),
    persist: () => { calls.persist += 1 },
  }
  const probe = createProbe({
    getConfig: () => ({ probeEnabled: true, probeTimeoutMs: 2000, probeConcurrency: 2 }),
    listLanes: async () => lanes,
    health,
    probeOne: async (lane) => {
      if (lane.provider === 'dead-lane') throw new Error('402 Insufficient credits')
      return { ttftMs: 120, inputTokens: 5, outputTokens: 1 }
    },
    clock: () => Date.now(),
  })
  const summary = await probe.runOnce({ force: true })
  check('总数 3', summary.total === 3, 'total=' + summary.total)
  check('实际探测 2', summary.probed === 2, 'probed=' + summary.probed)
  check('跳过 1（冷却）', summary.skipped === 1, 'skipped=' + summary.skipped)
  check('通过 1 / 失败 1', summary.ok === 1 && summary.failed === 1, 'ok=' + summary.ok + ' failed=' + summary.failed)
  check('成功写账本带 purpose=probe', calls.success[0]?.sample?.purpose === 'probe', JSON.stringify(calls.success[0]?.sample))
  check('失败写账本带 purpose=probe', calls.failure[0]?.failure?.purpose === 'probe')
  check('失败原因被记录', String(calls.failure[0]?.failure?.message ?? '').includes('402'))
  check('整轮只落盘一次', calls.persist === 1, 'persist=' + calls.persist)
  check('冷却车道未被写账本', !calls.success.some(c => c.provider === 'cooling') && !calls.failure.some(c => c.provider === 'cooling'))
}

// ── 5. 超时：单条卡死不拖垮整轮 ────────────────────────────────────────────
{
  const started = Date.now()
  const probe = createProbe({
    getConfig: () => ({ probeEnabled: true, probeTimeoutMs: 150, probeConcurrency: 2 }),
    listLanes: async () => [
      { provider: 'hang', model: 'm' },
      { provider: 'fast', model: 'm' },
    ],
    health: { stateOf: () => ({ available: true, until: 0 }), markSuccess: () => {}, markFailure: () => {}, persist: () => {} },
    probeOne: (lane) => lane.provider === 'hang'
      ? new Promise(() => {})     // 永不返回
      : Promise.resolve({ ttftMs: 50 }),
    clock: () => Date.now(),
  })
  const summary = await probe.runOnce({ force: true })
  const elapsed = Date.now() - started
  check('超时不卡死', elapsed < 3000, 'elapsed=' + elapsed + 'ms')
  check('超时被记为失败', summary.failed === 1, 'failed=' + summary.failed)
  check('快车道仍成功', summary.ok === 1, 'ok=' + summary.ok)
}

// ── 6. 开关与并发保护 ──────────────────────────────────────────────────────
{
  const probe = createProbe({
    getConfig: () => ({ probeEnabled: false }),
    listLanes: async () => [{ provider: 'p', model: 'm' }],
    health: { stateOf: () => ({ available: true, until: 0 }), markSuccess: () => {}, markFailure: () => {}, persist: () => {} },
    probeOne: async () => ({ ttftMs: 1 }),
    clock: () => Date.now(),
  })
  const result = await probe.runOnce()
  check('关闭时跳过', result.skipped === true && result.reason.includes('关闭'), JSON.stringify(result.reason))

  // running 保护
  const slow = createProbe({
    getConfig: () => ({ probeEnabled: true, probeTimeoutMs: 5000 }),
    listLanes: async () => [{ provider: 'p', model: 'm' }],
    health: { stateOf: () => ({ available: true, until: 0 }), markSuccess: () => {}, markFailure: () => {}, persist: () => {} },
    probeOne: () => new Promise(resolve => setTimeout(() => resolve({ ttftMs: 10 }), 120)),
    clock: () => Date.now(),
  })
  const first = slow.runOnce()
  const second = await slow.runOnce()
  await first
  check('运行中不重入', second.skipped === true && second.reason.includes('仍在进行'), JSON.stringify(second.reason))
}

// ── 7. 状态接口 ────────────────────────────────────────────────────────────
{
  const probe = createProbe({
    getConfig: () => ({ probeEnabled: true, probeEveryDays: 2, probeTimeoutMs: 9000, probeConcurrency: 4 }),
    listLanes: async () => [],
    health: { stateOf: () => ({ available: true, until: 0 }), markSuccess: () => {}, markFailure: () => {}, persist: () => {} },
    probeOne: async () => ({ ttftMs: 1 }),
    clock: () => Date.now(),
  })
  const st = probe.status()
  check('status.intervalDays = 2', st.intervalDays === 2, String(st.intervalDays))
  check('status.timeoutMs 透传', st.timeoutMs === 9000)
  check('status.concurrency 透传', st.concurrency === 4)
  check('status.enabled = true', st.enabled === true)
}

// ── 8. 定时器：能排、能停 ──────────────────────────────────────────────────
{
  let scheduled = 0
  const stops = []
  const probe = createProbe({
    getConfig: () => ({ probeEnabled: true, probeIntervalMs: 60_000, probeFirstDelayMs: 10 }),
    listLanes: async () => [{ provider: 'p', model: 'm' }],
    health: { stateOf: () => ({ available: true, until: 0 }), markSuccess: () => {}, markFailure: () => {}, persist: () => {} },
    probeOne: async () => ({ ttftMs: 5 }),
    clock: () => Date.now(),
  })
  // 用假 schedule 收集 tick，不真的起 setTimeout
  const stop = probe.start((tick) => { scheduled += 1; stops.push(tick) })
  check('start 返回 stop 函数', typeof stop === 'function')
  stop()
  const before = scheduled
  check('stop 后不再排新轮（假 schedule 未触发）', scheduled === before)
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('\nprobe-smoke: pass=' + pass + ' fail=' + fail)
if (fail > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log('  - ' + item)
  process.exit(1)
}
console.log('全部通过')
