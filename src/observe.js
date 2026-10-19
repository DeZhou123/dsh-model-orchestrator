/**
 * Traffic observation: first-token latency, token spend, and stream failures.
 *
 * `llm/stream` is the one waterfall every model call passes through, so it is
 * where the ledger learns what the report could only measure once. Wrapping the
 * iterable is passive — the chunks are forwarded untouched — which keeps the
 * orchestrator off the critical path if anything here throws.
 *
 * Failure accounting is split on purpose:
 *
 *   - a **thrown** stream error never reaches `agent/request-error`, so this
 *     observer records it;
 *   - an **in-band** `finish.error` is exactly what `agent/request-error` sees,
 *     so recording it here too would count one failure twice — except for calls
 *     outside the agent loop (title, compaction, a probe), which have no
 *     `agent/request-error` at all.
 *
 * @module src/observe
 */

/** Map a thrown value onto the `LlmFailure` shape the ledger classifies. */
function failureOf(error) {
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : ''
    const status = Number.isFinite(Number(error.status)) ? Number(error.status) : undefined
    const message = typeof error.message === 'string' ? error.message : String(error)
    if (code !== '' || status !== undefined) return { code, status, message }
    return { code: '', status: undefined, message }
  }
  return { code: '', status: undefined, message: String(error) }
}

/** Whether a chunk means the model has started producing something. */
function isFirstFrame(chunk) {
  return chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' || chunk?.type === 'tool-call-delta'
}

/**
 * Create the observer.
 *
 * @param {{health: object, onFailure?: Function, onSample?: Function, clock?: () => number}} options
 */
export function createObserver(options) {
  const { health } = options
  const clock = options.clock ?? (() => Date.now())

  /**
   * Wrap one call's chunk stream.
   *
   * @param {{provider: string, model: string, sessionId?: string, purpose?: string}} callOptions
   * @param {AsyncIterable<object>} stream
   */
  async function* observe(callOptions, stream) {
    const provider = String(callOptions?.provider ?? '')
    const model = String(callOptions?.model ?? '')
    // Agent-loop calls carry a sessionId and no purpose; title/compaction calls
    // carry a purpose. A hand-built probe may carry neither.
    const agentLoopCall = callOptions?.sessionId !== undefined && callOptions?.purpose === undefined
    const started = clock()
    let firstFrameAt = null
    let firstVisibleAt = null
    let usage = null
    let finish = null
    let sawReasoning = false

    try {
      for await (const chunk of stream) {
        const now = clock()
        if (firstFrameAt === null && isFirstFrame(chunk)) firstFrameAt = now
        if (firstVisibleAt === null && (chunk?.type === 'text-delta' || chunk?.type === 'tool-call-delta')) firstVisibleAt = now
        if (chunk?.type === 'reasoning-delta') sawReasoning = true
        if (chunk?.type === 'usage') usage = chunk.usage ?? null
        if (chunk?.type === 'finish') finish = chunk.reason ?? null
        yield chunk
      }
    } catch (error) {
      const failure = failureOf(error)
      try {
        health.markFailure(provider, model, failure)
        options.onFailure?.({ provider, model, failure, sessionId: callOptions?.sessionId, purpose: callOptions?.purpose, thrown: true })
      } catch {
        /* observation must never break the call */
      }
      throw error
    }

    const endedAt = clock()
    try {
      if (finish !== null && (finish.kind === 'error' || finish.kind === 'aborted')) {
        const reported = finish.failure ?? { code: '', message: finish.kind }
        // The agent loop will hand the same failure to agent/request-error.
        if (!agentLoopCall) health.markFailure(provider, model, reported)
        options.onFailure?.({
          provider,
          model,
          failure: reported,
          sessionId: callOptions?.sessionId,
          purpose: callOptions?.purpose,
          thrown: false,
        })
        return
      }
      const outputTokens = Number(usage?.outputTokens ?? 0)
      const ttftMs = firstFrameAt === null ? null : firstFrameAt - started
      const visibleMs = firstVisibleAt === null ? null : firstVisibleAt - started
      // Throughput only counts the window that actually covers the tokens in its
      // numerator — the same rule the report uses, because reasoning tokens that
      // never streamed would otherwise inflate the rate by orders of magnitude.
      const decodeMs = firstFrameAt === null ? 0 : endedAt - firstFrameAt
      const tps = !sawReasoning && decodeMs >= 250 && outputTokens >= 8
        ? Math.round((outputTokens / (decodeMs / 1000)) * 10) / 10
        : null
      health.markSuccess(provider, model, {
        ttftMs: ttftMs ?? undefined,
        tps,
        inputTokens: Number(usage?.inputTokens ?? 0),
        outputTokens,
      })
      options.onSample?.({
        provider,
        model,
        sessionId: callOptions?.sessionId,
        purpose: callOptions?.purpose ?? '',
        ttftMs,
        visibleMs,
        totalMs: endedAt - started,
        tps,
        inputTokens: Number(usage?.inputTokens ?? 0),
        outputTokens,
        reasoningTokens: Number(usage?.reasoningTokens ?? 0),
        cacheReadTokens: Number(usage?.cacheReadTokens ?? 0),
        at: endedAt,
      })
    } catch {
      /* observation must never break the call */
    }
  }

  return { observe }
}

export default createObserver
