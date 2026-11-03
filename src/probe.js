/**
 * Periodic lane probing.
 *
 * 免费车道会静默死亡：cline 的 402、our-free-model 的免费层耗尽、某个渠道的
 * 模型下架——这些只有"被选中并失败一次"之后 health 账本才知道。间隔越久没人
 * 选它，面板上的"可用"就越假。本模块定期把所有车道探一遍，把结果写回账本。
 *
 * 设计约束（每条都有代价，别随意放松）：
 *  1. 探活请求走一条独立的 purpose，绝不进入会话的 token 预算；
 *  2. 单条 lane 独立超时，一条挂死不拖垮整轮；
 *  3. 冷却未到期的 lane 直接跳过——它本来就不会被选中，探了只是白烧额度；
 *  4. 每轮结束才落盘一次，不是每条一次；
 *  5. 定时器由调用方的 ctx.effect 托管，插件卸载必须能停。
 *
 * @module src/probe
 */

/** 默认间隔：三天。 */
export const DEFAULT_EVERY_DAYS = 3
/** 默认首轮延迟：10 分钟，避开启动时正在进行的会话。 */
export const DEFAULT_FIRST_DELAY_MS = 10 * 60_000
/** 单条 lane 的探测超时。 */
export const DEFAULT_TIMEOUT_MS = 20_000
/** 一轮内同时进行的探测数。 */
export const DEFAULT_CONCURRENCY = 2

const DAY_MS = 24 * 60 * 60_000

/**
 * 把「多少天」这类人写的配置收敛成毫秒。
 *
 * 两条路都认：`probeIntervalMs` 直接给毫秒（优先），否则 `probeEveryDays`
 * 乘一天。都给时以毫秒为准，因为它是更精确的那一个。
 *
 * @param {object} config - resolved orchestrator config.
 * @returns {number} interval in ms, always > 0.
 */
export function resolveIntervalMs(config = {}) {
  const raw = Number(config.probeIntervalMs)
  if (Number.isFinite(raw) && raw > 0) return Math.max(60_000, raw)
  const days = Number(config.probeEveryDays)
  const useDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_EVERY_DAYS
  return Math.max(60_000, Math.round(useDays * DAY_MS))
}

/**
 * 一条 lane 该不该探。
 *
 * 只有两个理由跳过：账本说它在冷却且没到期（探了必失败，还刷高 strikes），
 * 或者调用方明确把它排除（本次请求刚失败的车道）。
 *
 * @param {object} input
 * @param {{provider: string, model: string}} input.lane
 * @param {{available: boolean, until: number}} input.state - health.stateOf() 的结果
 * @param {number} input.now
 * @returns {{skip: boolean, reason: string}}
 */
export function shouldSkip(input) {
  const state = input.state
  if (state !== null && state !== undefined && state.available === false) {
    const until = Number(state.until ?? 0)
    // 冷却未到期 → 跳。到期了反而必须探：那正是"它到底恢复了没有"的答案。
    if (until > input.now) return { skip: true, reason: '冷却中：' + String(state.reason ?? '') }
  }
  return { skip: false, reason: '' }
}

/**
 * 按并发上限跑完一批任务，任一失败只记录不中断。
 *
 * @param {Array} items - 待处理项。
 * @param {number} limit - 并发上限。
 * @param {(item: any, index: number) => Promise<any>} worker
 * @returns {Promise<Array>} results, 与 items 同序。
 */
export async function runPool(items, limit, worker) {
  const width = Math.max(1, Math.floor(Number(limit) || 1))
  const results = new Array(items.length)
  let cursor = 0
  async function drain() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        results[index] = { ok: false, error: String(error?.message ?? error), ms: 0 }
      }
    }
  }
  const runners = []
  for (let i = 0; i < Math.min(width, items.length); i += 1) runners.push(drain())
  await Promise.all(runners)
  return results
}

/**
 * 建一个探活调度器。
 *
 * 所有外部能力都从参数进来，模块本身不碰 fs、不碰 ctx、不碰网络——
 * 这样 smoke 测试可以用假时钟和假探测函数跑完整个生命周期。
 *
 * @param {object} options
 * @param {() => object} options.getConfig - 读实时配置（间隔/开关随时可改）。
 * @param {() => Promise<Array<{provider: string, model: string}>>} options.listLanes - 当前目录里的全部车道。
 * @param {{stateOf: Function, markSuccess: Function, markFailure: Function, persist: Function}} options.health
 * @param {(lane: object, signal: AbortSignal) => Promise<{ttftMs?: number, inputTokens?: number, outputTokens?: number}>} options.probeOne
 * @param {() => number} [options.clock]
 * @param {{info?: Function, warn?: Function}} [options.logger]
 * @param {(state: object) => void} [options.onState] - 每轮结束回调（宿主用来落盘/广播）。
 * @param {object} [options.initialState] - 上次运行留下的状态（lastRunAt 等）。
 */
export function createProbe(options) {
  const clock = options.clock ?? (() => Date.now())
  const logger = options.logger ?? {}
  const state = {
    lastRunAt: Number(options.initialState?.lastRunAt ?? 0),
    lastFinishedAt: Number(options.initialState?.lastFinishedAt ?? 0),
    lastDurationMs: Number(options.initialState?.lastDurationMs ?? 0),
    lastResults: Array.isArray(options.initialState?.lastResults) ? options.initialState.lastResults : [],
    running: false,
    nextAt: 0,
    rounds: Number(options.initialState?.rounds ?? 0),
  }

  /** 一条 lane 的探测：包超时，任何异常都收敛成 {ok:false}。 */
  async function probeLane(lane, timeoutMs) {
    const started = clock()
    const controller = new AbortController()
    let timer = null
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ ok: false, error: '探测超时 ' + timeoutMs + 'ms', ms: clock() - started })
      }, timeoutMs)
    })
    const attempt = (async () => {
      try {
        const sample = await options.probeOne(lane, controller.signal)
        const ms = Number(sample?.ttftMs ?? 0) > 0 ? Number(sample.ttftMs) : clock() - started
        return { ok: true, ms, sample: sample ?? {} }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), ms: clock() - started }
      }
    })()
    try {
      return await Promise.race([attempt, timeout])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /**
   * 跑一轮。并发上限取自实时配置；结束时统一落盘。
   *
   * @param {object} [override]
   * @param {boolean} [override.force] - 无视开关与间隔，立即跑（run-now 用）。
   * @returns {Promise<object>} 本轮摘要
   */
  async function runOnce(override = {}) {
    if (state.running && override.force !== true) {
      return { skipped: true, reason: '上一轮仍在进行', startedAt: state.lastRunAt }
    }
    const config = options.getConfig() ?? {}
    if (override.force !== true && config.probeEnabled === false) {
      return { skipped: true, reason: '探活已关闭', startedAt: state.lastRunAt }
    }
    state.running = true
    const startedAt = clock()
    state.lastRunAt = startedAt
    const timeoutMs = Math.max(1_000, Number(config.probeTimeoutMs) || DEFAULT_TIMEOUT_MS)
    const concurrency = Math.max(1, Number(config.probeConcurrency) || DEFAULT_CONCURRENCY)

    let lanes = []
    try {
      lanes = await options.listLanes()
    } catch (error) {
      state.running = false
      logger.warn?.('探活：列举车道失败 ' + String(error?.message ?? error))
      return { skipped: true, reason: '列举车道失败', startedAt }
    }

    const targets = []
    for (const lane of Array.isArray(lanes) ? lanes : []) {
      if (lane === null || lane === undefined) continue
      const provider = String(lane.provider ?? '')
      const model = String(lane.model ?? '')
      if (provider === '' || model === '') continue
      let stateForLane = null
      try {
        stateForLane = options.health.stateOf(provider, model)
      } catch {
        stateForLane = null
      }
      const verdict = shouldSkip({ lane, state: stateForLane, now: startedAt })
      if (verdict.skip) {
        targets.push({ lane, skip: true, reason: verdict.reason })
        continue
      }
      targets.push({ lane, skip: false, reason: '' })
    }

    const runnable = targets.filter(entry => entry.skip === false).map(entry => entry.lane)
    const results = await runPool(runnable, concurrency, async (lane) => {
      const outcome = await probeLane(lane, timeoutMs)
      try {
        if (outcome.ok) {
          options.health.markSuccess(lane.provider, lane.model, {
            ttftMs: outcome.ms,
            ...outcome.sample,
            purpose: 'probe',
          })
        } else {
          options.health.markFailure(lane.provider, lane.model, {
            code: 'PROBE',
            message: outcome.error,
            purpose: 'probe',
          })
        }
      } catch (error) {
        logger.warn?.('探活：写账本失败 ' + String(error?.message ?? error))
      }
      return {
        provider: lane.provider,
        model: lane.model,
        ok: outcome.ok === true,
        ms: Number(outcome.ms ?? 0),
        error: outcome.ok === true ? '' : String(outcome.error ?? ''),
      }
    })

    const skipped = targets.filter(entry => entry.skip).map(entry => ({
      provider: entry.lane.provider,
      model: entry.lane.model,
      ok: null,
      ms: 0,
      error: entry.reason,
    }))
    const all = [...skipped, ...results]
    const finishedAt = clock()
    state.lastFinishedAt = finishedAt
    state.lastDurationMs = finishedAt - startedAt
    state.lastResults = all
    state.rounds += 1
    state.running = false
    try {
      options.health.persist()
    } catch {
      /* 落盘失败不影响本轮结论，账本仍在内存里 */
    }
    const summary = {
      startedAt,
      finishedAt,
      durationMs: state.lastDurationMs,
      total: all.length,
      probed: results.length,
      ok: results.filter(row => row.ok).length,
      failed: results.filter(row => row.ok === false).length,
      skipped: skipped.length,
      results: all,
    }
    try {
      options.onState?.(state)
    } catch {
      /* 回调是宿主的事，它挂了不该让探活算失败 */
    }
    logger.info?.('探活完成：' + summary.ok + '/' + summary.probed + ' 通过，' + summary.skipped + ' 条跳过')
    return summary
  }

  /** 当前状态（给 tool / 面板看）。 */
  function status() {
    const config = options.getConfig() ?? {}
    const intervalMs = resolveIntervalMs(config)
    return {
      enabled: config.probeEnabled !== false,
      intervalMs,
      intervalDays: Math.round((intervalMs / DAY_MS) * 100) / 100,
      timeoutMs: Math.max(1_000, Number(config.probeTimeoutMs) || DEFAULT_TIMEOUT_MS),
      concurrency: Math.max(1, Number(config.probeConcurrency) || DEFAULT_CONCURRENCY),
      running: state.running,
      rounds: state.rounds,
      lastRunAt: state.lastRunAt,
      lastFinishedAt: state.lastFinishedAt,
      lastDurationMs: state.lastDurationMs,
      nextAt: state.nextAt,
      lastResults: state.lastResults,
    }
  }

  /**
   * 排下一轮。调用方拿返回值去挂 ctx.effect 的 dispose。
   *
   * @param {(run: () => Promise<any>) => void} schedule - 由宿主注入的定时能力（可测）。
   * @returns {() => void} 停止函数
   */
  function start(schedule) {
    const config = options.getConfig() ?? {}
    if (config.probeEnabled === false) return () => {}
    const intervalMs = resolveIntervalMs(config)
    const firstDelayMs = Math.max(0, Number(config.probeFirstDelayMs) || DEFAULT_FIRST_DELAY_MS)
    // 上次跑过就按「上次 + 间隔」算，没跑过就等首轮延迟：重启不会把间隔清零。
    const baseline = state.lastRunAt > 0 ? state.lastRunAt + intervalMs : clock() + firstDelayMs
    const delay = Math.max(0, baseline - clock())
    state.nextAt = clock() + delay
    let stopped = false
    let timer = null
    const tick = async () => {
      if (stopped) return
      state.nextAt = 0
      try {
        await runOnce({ force: false })
      } catch (error) {
        logger.warn?.('探活轮次异常 ' + String(error?.message ?? error))
      }
      if (stopped) return
      schedule(tick)
    }
    timer = setTimeout(tick, delay)
    return () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      state.nextAt = 0
    }
  }

  return { runOnce, status, start, resolveIntervalMs, shouldSkip }
}

export default createProbe
