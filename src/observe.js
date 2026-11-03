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
 * A third shape needed a verdict of its own, and it is the only one that does
 * not need the peer to cooperate (see {@link carriesOutput}): a call that runs
 * to completion and streams **nothing at all** — zero output frames, no error
 * finish, just a clean end. An old lend-side that still answers `200` at t=0
 * (before it knows whether the upstream can produce anything) reports exactly
 * that shape, and it used to be booked as `calls+1 / errors=0 / status=ok`:
 * a dead lane that looks perfectly healthy in the ledger.
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
 * Whether a chunk delivered any model output at all.
 *
 * Deliberately broader than {@link isFirstFrame}, which is a latency clock and
 * therefore fires on the *first* delta frame whatever it carries. This predicate
 * decides a ledger verdict, so it must never call a call empty that actually
 * delivered something:
 *
 *   - `text-delta` / `reasoning-delta` count only with a non-empty string, the
 *     same rule the harness's own `isTokenDelta` uses;
 *   - `tool-call-delta` counts when it names the call or carries argument bytes
 *     (a name-only frame is how a tool call starts on the DeepSeek adapter);
 *   - a `block-end` counts when it closes a block that has content, because an
 *     adapter is allowed to buffer and emit whole blocks instead of deltas.
 *
 * `block-start`, `usage` and `finish` are control frames: a stream made only of
 * those produced nothing a caller could act on.
 */
function carriesOutput(chunk) {
  switch (chunk?.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text !== ''
    case 'tool-call-delta':
      return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') || typeof chunk.name === 'string'
    case 'block-end': {
      const block = chunk.block
      if (block === null || typeof block !== 'object') return false
      if (block.type === 'text' || block.type === 'reasoning') return typeof block.text === 'string' && block.text !== ''
      return block.type === 'tool-call'
    }
    default:
      return false
  }
}

/**
 * The failure booked for a call that finished without a single output frame.
 *
 * `EMPTY_RESPONSE` is the harness's own provider-neutral code for "completed
 * normally but carried no content", and `health.js` files it as a model-scoped
 * transient — a bounded backoff that reroutes the next step instead of parking
 * the whole lane until midnight. A zero-output call is exactly that: the tokens
 * were spent (or the far side died) and the caller received nothing.
 */
const ZERO_OUTPUT_FAILURE = Object.freeze({
  code: 'EMPTY_RESPONSE',
  message: '这一发跑完但一帧输出都没有：没有文本、没有推理、也没有工具调用',
})

/**
 * Create the observer.
 *
 * @param {{health: object, inflight?: object, onFailure?: Function, onSample?: Function, clock?: () => number}} options
 */
export function createObserver(options) {
  const { health } = options
  /**
   * Optional open-call accounting (see `src/inflight.js`).
   *
   * `llm/stream` is the one point every model call passes through, so it is also
   * the only honest place to know a call is *currently* open. The lease is taken
   * before the first chunk and released in `finally` — a stream that throws, ends
   * or is cancelled must all free the slot, or a crashed turn would make its lane
   * look permanently busy to every other session.
   */
  const inflight = options.inflight ?? null
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
    const lease = inflight === null || typeof inflight.begin !== 'function'
      ? null
      : inflight.begin(provider, model)
    let firstFrameAt = null
    let firstVisibleAt = null
    let usage = null
    let finish = null
    let sawReasoning = false
    /**
     * Whether this call delivered anything at all (see {@link carriesOutput}).
     *
     * Tracked separately from `firstFrameAt` on purpose: that one is the
     * time-to-first-token clock, this one decides the ledger verdict. They
     * disagree exactly where the borrower-side guard matters — a stream of
     * control frames, or a stream of nothing, has no `firstFrameAt` and no
     * output, while a call that emitted only `block-start` + `finish` still
     * has no output even though it "ran".
     */
    let sawOutput = false

    try {
      for await (const chunk of stream) {
        const now = clock()
        if (firstFrameAt === null && isFirstFrame(chunk)) firstFrameAt = now
        if (firstVisibleAt === null && (chunk?.type === 'text-delta' || chunk?.type === 'tool-call-delta')) firstVisibleAt = now
        if (chunk?.type === 'reasoning-delta') sawReasoning = true
        if (!sawOutput && carriesOutput(chunk)) sawOutput = true
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
    } finally {
      // Every exit path frees the slot: a completed stream, a thrown error, a
      // consumer that broke out of the loop, or an aborted signal.
      lease?.release()
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
      /**
       * ── zero-output guard: 跑完了却一帧输出都没有 ──────────────────────────
       *
       * This is the borrower-side backstop for the shape an **old** lend-side
       * still produces (peer-borrow-zero-output-borrower-guard, 2026-11-03).
       * A relay that answers `200` before it knows whether the upstream can
       * produce anything reports "clean end, zero chunks" for a dead lane; a
       * relay that has been fixed reports a real HTTP status instead, and the
       * adapter throws, which is handled above. Waiting for the far side to be
       * upgraded leaves this box blind for however long the upgrade takes, so
       * the verdict is made here, from the stream alone.
       *
       * The rule: a call with **no output at all** is not a success. It is
       * booked as `EMPTY_RESPONSE` — the harness's own code for "completed
       * normally but carried no content" — which `health.js` files as a
       * model-scoped transient: errors+1, a bounded cooldown, and the next step
       * reroutes around the dead lane. Recording it as `status=ok` instead is
       * how a dead lane stayed invisible in the ledger.
       *
       * Deliberately *after* the error/aborted branch: a cancelled call is the
       * user's own doing (`health.js` has `ABORTED` in `REQUEST_CODES` and must
       * leave the lane innocent), and an error finish already carries a better
       * code than this one. Counting either again here would double-book it.
       *
       * Unlike the in-band failure branch there is no `agentLoopCall` exemption
       * here, and none is needed: a stream that ends with `stop` and no output
       * never reaches `agent/request-error` at all, so this is the only place
       * the ledger can learn about it.
       */
      if (!sawOutput) {
        const failure = {
          code: ZERO_OUTPUT_FAILURE.code,
          message: ZERO_OUTPUT_FAILURE.message + '：' + (provider === '' ? '?' : provider) + '/' + (model === '' ? '?' : model),
        }
        health.markFailure(provider, model, failure)
        options.onFailure?.({
          provider,
          model,
          failure,
          sessionId: callOptions?.sessionId,
          purpose: callOptions?.purpose,
          thrown: false,
          empty: true,
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
