/**
 * Integration smoke test: load the real Host half against a mock Cordis context.
 *
 * This is the layer the unit tests cannot reach — the wiring between the kernel
 * hooks (`system-prompt/assemble`, `agent/request`, `agent/request-error`,
 * `session/event`), the session controller's selection object, and the settings
 * surface. Everything here is deterministic: the clock is fixed and the model
 * registry is a fake.
 *
 * Run: node tools/integration.mjs
 *
 * @module tools/integration
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NOW = 1792314000000
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-integration-'))
process.env.DSH_HOME = tmp

const { apply } = await import('../index.js')

let checks = 0
let failures = 0
function check(label, actual, expected) {
  checks += 1
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log('  ok    ' + label + ' = ' + JSON.stringify(actual))
  } else {
    failures += 1
    console.log('  FAIL  ' + label + '\n        expected ' + JSON.stringify(expected) + '\n        actual   ' + JSON.stringify(actual))
  }
}
function checkThat(label, condition, detail = '') {
  checks += 1
  if (condition) console.log('  ok    ' + label + (detail === '' ? '' : ' (' + detail + ')'))
  else {
    failures += 1
    console.log('  FAIL  ' + label + (detail === '' ? '' : ' (' + detail + ')'))
  }
}

// ── fake model registry ─────────────────────────────────────────────────────
const MODELS = {
  buddy: [
    { id: 'glm-5.3', name: 'GLM-5.3 · x0.06' },
    { id: 'step-5-preview', name: 'Step 5 · x0.1' },
  ],
  trae: [
    { id: 'glm-5.3', name: 'GLM-5.3 · x0.79' },
    { id: 'mimo-v2.6-pro', name: 'Mimo Pro · x0.15' },
  ],
}
const INFO = {
  'buddy/glm-5.3': { contextWindow: 1_000_000, modalities: ['text'], efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'trae/glm-5.3': { contextWindow: 1_000_000, modalities: ['text'], efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'buddy/step-5-preview': { contextWindow: 1_000_000, modalities: ['text'], efforts: ['low', 'high'], defaultEffort: 'high' },
  'trae/mimo-v2.6-pro': { contextWindow: 1_000_000, modalities: ['text'], efforts: [], defaultEffort: undefined },
}
const llm = {
  listProviders: () => [{ id: 'buddy', name: 'CodeBuddy' }, { id: 'trae', name: 'TRAE' }],
  listModels: async provider => MODELS[provider] ?? [],
  resolveModelInfo: async (provider, model) => {
    const info = INFO[provider + '/' + model] ?? { contextWindow: 200_000, modalities: ['text'], efforts: [], defaultEffort: undefined }
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: info.contextWindow },
      inputModalities: info.modalities,
      ...(info.efforts.length === 0 ? {} : { reasoning: { efforts: info.efforts.map(id => ({ id, name: id })), defaultEffort: info.defaultEffort } }),
    }
  },
}

// ── fake Cordis context ─────────────────────────────────────────────────────
const listeners = new Map()
const notifications = []
const tools = new Map()
const commands = new Map()
const routes = new Map()
const sessions = new Map()

const selection = {
  _picked: undefined,
  get current() {
    return this._picked ?? { provider: 'buddy', model: 'glm-5.3' }
  },
  set current(next) {
    this._picked = next
  },
  assembled: undefined,
}
const sessionController = {
  agents: {
    selectionFor(agent) {
      return sessions.get(agent.id)?.ref ?? selection
    },
  },
  selectForNextRequest(agent, next) {
    const state = sessions.get(agent.id)
    if (state !== undefined) {
      state.ref._picked = next
      state.session.append('model/selection', next)
    }
  },
}

const services = {
  llm,
  sessionController,
  desktopRuntime: { notifyAttention: value => notifications.push(value) },
  timer: {
    effect: fn => {
      fn()
      return () => {}
    },
    interval: () => ({ [Symbol.dispose]() {} }),
  },
  agents: { list: () => [] },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  commands: {
    register(definition) {
      commands.set(definition.name, definition)
      return () => commands.delete(definition.name)
    },
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  connection: { requestRejection: () => undefined },
}

function fire(name, ...args) {
  const list = listeners.get(name) ?? []
  for (const callback of [...list]) {
    const result = callback(...args)
    if (result !== undefined) return result
  }
  return undefined
}

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  llm,
  on(name, callback, options = {}) {
    const list = listeners.get(name) ?? []
    if (options.prepend) list.unshift(callback)
    else list.push(callback)
    listeners.set(name, list)
    return () => {}
  },
  inject(names, callback) {
    if (!names.every(name => services[name] !== undefined)) return () => {}
    // Cordis' scoped context: context methods (`effect`) plus the injected
    // services; the timer plugin also mixes `interval` onto every context.
    const scope = {
      effect: ctx.effect,
      interval: () => ({ [Symbol.dispose]() {} }),
    }
    for (const name of names) scope[name] = services[name]
    callback(scope)
    return () => {}
  },
  effect(fn) {
    fn()
    return () => {}
  },
}

/** A minimal live session: an append log and the request header fold. */
function createSession(id, origin) {
  let seq = 0
  let header
  const events = []
  const session = {
    id,
    header: { id, origin },
    surface: { replaceGeneration: 0 },
    get seq() {
      return seq
    },
    append(type, data) {
      const event = { type, data, seq: seq++ }
      events.push(event)
      fire('session/event', session, event)
      return { seq: event.seq }
    },
    snapshotEvents(from, to) {
      return events.filter(event => event.seq >= from && event.seq < to)
    },
    requestHeader() {
      return header
    },
    setHeader(config) {
      header = { config }
    },
  }
  return session
}

// ── boot ────────────────────────────────────────────────────────────────────
console.log('\n[1] plugin boot')
apply(ctx, {})
await new Promise(resolve => setTimeout(resolve, 20))
checkThat('the panel routes were installed', routes.size === 4, [...routes.keys()].join(','))
checkThat('the tool was registered', tools.has('model_orchestrator'))
checkThat('the command was registered', commands.has('route'))
const status0 = await tools.get('model_orchestrator').execute({ action: 'status' })
checkThat('status reports the live catalog', status0.ok === true && status0.catalog.total === 4, JSON.stringify(status0.catalog))

console.log('\n[2] one routed step')
const session = createSession('s1', undefined)
const agent = { id: 's1', session }
const ref = selection
sessions.set('s1', { ref, session })
fire('agent/created', { agent })
session.setHeader({ provider: 'buddy', model: 'glm-5.3' })
const assembly = { variables: {} }
await fire('system-prompt/assemble', assembly, { agent }, () => Promise.resolve(assembly))
checkThat('the route was installed on the selection', ref.assembled !== undefined,
  JSON.stringify(ref._picked ?? null))
checkThat('a model/selection event was appended', session.snapshotEvents(0, session.seq).some(event => event.type === 'model/selection'))
const request = await fire('agent/request', { agent }, () => Promise.resolve({ provider: 'buddy', model: 'glm-5.3' }))
checkThat('the request override uses the routed route', request.provider + '/' + request.model,
  (ref._picked ?? ref.current).provider + '/' + (ref._picked ?? ref.current).model)

console.log('\n[3] failure keeps the model, switches the channel')
session.setHeader({ provider: ref._picked.provider, model: ref._picked.model })
const failedProvider = ref._picked.provider
const retry = await fire('agent/request-error', {
  agent,
  provider: failedProvider,
  failure: { code: 'QUOTA_EXCEEDED', message: '模型 "glm-5.3" 额度已用尽，请改用其它模型' },
  signal: new AbortController().signal,
}, () => Promise.resolve(undefined))
check('the failure asks the loop to retry', retry, { kind: 'retry' })
checkThat('the retry stayed on the same model', ref._picked.model === 'glm-5.3', ref._picked.provider + '/' + ref._picked.model)
checkThat('the retry moved to another channel', ref._picked.provider !== failedProvider, ref._picked.provider)

console.log('\n[4] preference mode')
const prefer = await tools.get('model_orchestrator').execute({ action: 'prefer', preferModel: 'mimo-v2.6-pro' })
checkThat('prefer mode was stored', prefer.ok === true && prefer.config.mode === 'prefer' && prefer.config.preferModel === 'mimo-v2.6-pro')
session.setHeader({ provider: ref._picked.provider, model: ref._picked.model })
await fire('system-prompt/assemble', assembly, { agent }, () => Promise.resolve(assembly))
check('the preferred model is selected', ref._picked.model, 'mimo-v2.6-pro')
const laneCount = notifications.length
await fire('agent/request-error', {
  agent,
  provider: 'trae',
  failure: { code: 'QUOTA_EXCEEDED', message: '模型 "mimo-v2.6-pro" 额度已用尽，请改用其它模型' },
  signal: new AbortController().signal,
}, () => Promise.resolve(undefined))
await fire('system-prompt/assemble', assembly, { agent }, () => Promise.resolve(assembly))
checkThat('an exhausted preference falls back to another model', ref._picked.model !== 'mimo-v2.6-pro', ref._picked.model)
checkThat('the user is notified exactly once', notifications.length === laneCount + 1, String(notifications.length))

console.log('\n[4b] a success on the preferred model resumes preference mode')
const beforeResume = notifications.length
const stream = fire('llm/stream', {
  provider: 'trae',
  model: 'mimo-v2.6-pro',
  sessionId: 's1',
  messages: [],
}, () => (async function* () {
  yield { type: 'text-delta', text: 'ok' }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})())
for await (const _chunk of stream) {
  // drain the observed stream
}
await fire('system-prompt/assemble', assembly, { agent }, () => Promise.resolve(assembly))
check('the preferred model is used again after recovery', ref._picked.model, 'mimo-v2.6-pro')
checkThat('recovery is notified once', notifications.length === beforeResume + 1, String(notifications.length))
const status = await tools.get('model_orchestrator').execute({ action: 'status' })
checkThat('status clears the paused flag', status.preference.suspended === false && status.preference.active === true)

console.log('\n[4b2] a live call is counted while it is open')
{
  // The observer takes an in-flight lease before the first chunk and releases it
  // in `finally`. Both halves matter: without the release, one crashed turn
  // makes its lane look permanently busy to every other session.
  let seenDuring = null
  const probe = fire('llm/stream', {
    provider: 'trae',
    model: 'mimo-v2.6-pro',
    sessionId: 's1',
    messages: [],
  }, () => (async function* () {
    const during = await tools.get('model_orchestrator').execute({ action: 'status' })
    seenDuring = during.concurrency?.total ?? null
    yield { type: 'text-delta', text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  for await (const _chunk of probe) { /* drain */ }
  checkThat('the open call is visible while it streams', seenDuring === 1, String(seenDuring))
  const afterStream = await tools.get('model_orchestrator').execute({ action: 'status' })
  checkThat('the lease is released when the stream ends', (afterStream.concurrency?.total ?? -1) === 0,
    String(afterStream.concurrency?.total))
  checkThat('status exposes the concurrency view', afterStream.concurrency !== undefined
    && Array.isArray(afterStream.concurrency.routes))
}

console.log('\n[4c] turn end restores a displaced picker choice')
// The user picks a different model mid-turn (preference is exhausted and the
// router fell back). The turn boundary is the safe point to honour it.
sessions.get('s1').session.append('model/selection', { provider: 'buddy', model: 'step-5-preview' })
sessions.get('s1').session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
check('the picker choice is honoured at the turn boundary', ref._picked.model, 'step-5-preview')

console.log('\n[5] status and explain surface')
checkThat('status exposes ranked model groups', Array.isArray(status.groups) && status.groups.length > 0)
const explain = await tools.get('model_orchestrator').execute({ action: 'explain' })
checkThat('explain returns the last decision', explain.lastDecision !== null && typeof explain.lastDecision.reason === 'string')
const rendered = await commands.get('route').handler({ rawInput: 'lanes', agent })
checkThat('the /route command renders text', rendered.kind === 'text' && rendered.text.includes('当前模型'), rendered.text.slice(0, 60))
const statusText = await commands.get('route').handler({ rawInput: 'status', agent })
checkThat('/route status shows the model instead of echoing the settings',
  statusText.text.includes('当前模型'), statusText.text.slice(0, 40))
const firstTurnOff = await commands.get('route').handler({ rawInput: 'firstturn off', agent })
checkThat('/route firstturn off flips the setting', firstTurnOff.text.includes('首轮接管=关闭'), firstTurnOff.text.slice(0, 80))
await commands.get('route').handler({ rawInput: 'firstturn on', agent })
const config = await tools.get('model_orchestrator').execute({ action: 'set', mode: 'auto' })
checkThat('set mode auto works', config.ok === true && config.config.mode === 'auto')

console.log('\n[6] repeated request rejections reroute inside the turn')
await tools.get('model_orchestrator').execute({ action: 'prefer', preferModel: 'glm-5.3' })
session.setHeader({ provider: ref._picked.provider, model: ref._picked.model })
await fire('system-prompt/assemble', assembly, { agent }, () => Promise.resolve(assembly))
const parked = { provider: ref._picked.provider, model: ref._picked.model }
const rejected = { code: 'INVALID_REQUEST', status: 400, message: 'unknown field "foo"' }
session.append('turn/start', { turn: 4 })
const firstReject = await fire('agent/request-error', {
  agent,
  provider: parked.provider,
  failure: rejected,
  signal: new AbortController().signal,
}, () => Promise.resolve(undefined))
checkThat('one rejected request does not move the route', firstReject === undefined,
  ref._picked.provider + '/' + ref._picked.model)
session.append('turn/start', { turn: 5 })
const secondReject = await fire('agent/request-error', {
  agent,
  provider: parked.provider,
  failure: rejected,
  signal: new AbortController().signal,
}, () => Promise.resolve(undefined))
check('the repeated rejection asks the loop to retry', secondReject, { kind: 'retry' })
checkThat('the retry left the parked channel',
  ref._picked.provider + '/' + ref._picked.model !== parked.provider + '/' + parked.model,
  ref._picked.provider + '/' + ref._picked.model)
session.setHeader({ provider: ref._picked.provider, model: ref._picked.model })
await fire('system-prompt/assemble', assembly, { agent }, () => Promise.resolve(assembly))
checkThat('the next step does not return to the parked channel',
  !(ref._picked.provider === parked.provider && ref._picked.model === parked.model),
  ref._picked.provider + '/' + ref._picked.model)
const parkedStatus = await tools.get('model_orchestrator').execute({ action: 'status' })
// The preferred group lists every lane of the model, so the parked one is
// visible here whatever the current route ended up being.
const groupLanes = parkedStatus.preference?.group?.lanes ?? []
const parkedLane = groupLanes.find(lane => lane.provider === parked.provider && lane.model === parked.model)
checkThat('the parked lane reports its verdict',
  parkedLane !== undefined && parkedLane.available === false,
  JSON.stringify(parkedLane ?? groupLanes).slice(0, 200))

console.log('\n[7] 首轮接管：第一条消息不用选择器里的模型')
/** A per-session picker stand-in: `current` is what the kernel would dispatch. */
function makeSelection(provider, model) {
  return {
    _picked: { provider, model },
    get current() {
      return this._picked
    },
    set current(next) {
      this._picked = next
    },
    assembled: undefined,
  }
}
/** Create a fresh agent whose picker shows `provider/model`, then assemble once. */
async function firstAnswerOf(id, provider, model) {
  const session = createSession(id, undefined)
  const agent = { id, session }
  const ref = makeSelection(provider, model)
  sessions.set(id, { ref, session })
  fire('agent/created', { agent })
  await fire('system-prompt/assemble', { variables: {} }, { agent }, () => Promise.resolve({ variables: {} }))
  return {
    agent,
    session,
    ref,
    picker: { provider, model },
    route: { provider: ref._picked.provider, model: ref._picked.model },
  }
}
// A clean auto-mode slate: the previous sections left a preference and a parked
// model behind, and both would decide the outcome before the anchor does.
await tools.get('model_orchestrator').execute({ action: 'set', mode: 'auto' })
const pickerA = await firstAnswerOf('sA', 'buddy', 'step-5-preview')
const pickerB = await firstAnswerOf('sB', 'trae', 'mimo-v2.6-pro')
checkThat('the two sessions showed different picker models',
  pickerA.picker.model !== pickerB.picker.model,
  pickerA.picker.model + ' vs ' + pickerB.picker.model)
check('the second session lands on the same first route',
  [pickerB.route.provider, pickerB.route.model],
  [pickerA.route.provider, pickerA.route.model])
checkThat('the picker was rewritten to the routed model',
  pickerA.session.snapshotEvents(0, pickerA.session.seq).some(event => event.type === 'model/selection'))
await fire('system-prompt/assemble', { variables: {} }, { agent: pickerA.agent }, () => Promise.resolve({ variables: {} }))
check('the next step does not bounce back to the picker model',
  [pickerA.ref._picked.provider, pickerA.ref._picked.model],
  [pickerA.route.provider, pickerA.route.model])

// Control: with takeover off the picker regains authority on the first answer.
await tools.get('model_orchestrator').execute({ action: 'set', routeFirstTurn: false })
const controlA = await firstAnswerOf('sC', 'buddy', 'step-5-preview')
const controlB = await firstAnswerOf('sD', 'trae', 'mimo-v2.6-pro')
check('with takeover off the first answer keeps the picker model',
  [controlA.route.provider, controlA.route.model], ['buddy', 'step-5-preview'])
checkThat('with takeover off the two sessions diverge',
  controlA.route.model !== controlB.route.model,
  controlA.route.model + ' vs ' + controlB.route.model)
await tools.get('model_orchestrator').execute({ action: 'set', routeFirstTurn: true })

console.log('\n[8] 新会话面板能预告下一条消息用哪个模型')
{
  const summary = routes.get('/api/model-orchestrator/summary')
  const captured = { code: 0, body: null }
  const req = { method: 'GET', url: '/api/model-orchestrator/summary?sessionId=no-such-session' }
  const res = {
    writeHead(code) {
      captured.code = code
    },
    end(body) {
      captured.body = JSON.parse(body)
    },
  }
  await summary.handler(req, res)
  check('an unknown session still gets a summary', captured.code, 200)
  checkThat('the summary previews the next route',
    captured.body.next !== null && typeof captured.body.next.family === 'string',
    JSON.stringify(captured.body.next))
  checkThat('the preview names a dispatchable lane',
    typeof captured.body.next.provider === 'string' && captured.body.next.provider !== '')
  check('the preview follows the live strategy', captured.body.next.mode, 'auto')
}

console.log('\n[9] 自动选择：接管模型，选具体模型时让位')
{
  await tools.get('model_orchestrator').execute({ action: 'set', mode: 'auto' })
  const autoA = await firstAnswerOf('sE', 'buddy', 'step-5-preview')
  const autoB = await firstAnswerOf('sF', 'trae', 'mimo-v2.6-pro')
  check('both sessions take the same routed first answer',
    [autoB.route.provider, autoB.route.model],
    [autoA.route.provider, autoA.route.model])

  const routed = [autoA.ref._picked.provider, autoA.ref._picked.model]
  // A real dispatch leaves a request header behind; the fixture has to as well,
  // otherwise the session still looks brand-new to the first-turn takeover.
  autoA.session.setHeader({ provider: routed[0], model: routed[1] })
  // A picker model that is NOT the routed one: whichever of the two the router
  // chose, pick the other so the assertion can actually fail.
  const other = routed[1] === 'step-5-preview'
    ? { provider: 'trae', model: 'mimo-v2.6-pro' }
    : { provider: 'buddy', model: 'step-5-preview' }

  await tools.get('model_orchestrator').execute({ action: 'set', mode: 'manual' })
  const manualThenAuto = await tools.get('model_orchestrator').execute({ action: 'set', autoSelect: true })
  check('auto-select clears a conflicting manual mode', manualThenAuto.config.mode, 'auto')
  const status = await tools.get('model_orchestrator').execute({ action: 'status' })
  checkThat('auto-select is reported in the config', status.config.autoSelect === true)
  // Nothing picked: the route stays where the router put it, step after step.
  await fire('system-prompt/assemble', { variables: {} }, { agent: autoA.agent }, () => Promise.resolve({ variables: {} }))
  check('the route holds while nothing is picked',
    [autoA.ref._picked.provider, autoA.ref._picked.model], routed)

  // Picking a concrete model in the official list is an instruction: it wins, and
  // the takeover steps aside (that is what the list's first row exists to undo).
  autoA.session.append('model/selection', other)
  const afterPick = await tools.get('model_orchestrator').execute({ action: 'status' })
  checkThat('picking a model in the official list leaves auto-select',
    afterPick.config.autoSelect === false, String(afterPick.config.autoSelect))
  await fire('system-prompt/assemble', { variables: {} }, { agent: autoA.agent }, () => Promise.resolve({ variables: {} }))
  check('the picked model is honoured',
    [autoA.ref._picked.provider, autoA.ref._picked.model], [other.provider, other.model])

  // The row in the list turns it back on; the picker stops deciding again.
  await tools.get('model_orchestrator').execute({ action: 'set', autoSelect: true })
  const backOn = await tools.get('model_orchestrator').execute({ action: 'status' })
  checkThat('turning it back on keeps the takeover', backOn.config.autoSelect === true)
  await fire('system-prompt/assemble', { variables: {} }, { agent: autoA.agent }, () => Promise.resolve({ variables: {} }))
  checkThat('the router is back in charge',
    [autoA.ref._picked.provider, autoA.ref._picked.model].join('/') !== [other.provider, other.model].join('/'),
    autoA.ref._picked.provider + '/' + autoA.ref._picked.model)
  await tools.get('model_orchestrator').execute({ action: 'set', autoSelect: false })
}

console.log('\n[10] 全部模型清单接口（偏好选择器用）')
{
  const route = routes.get('/api/model-orchestrator/families')
  const read = async (query) => {
    const captured = { code: 0, body: null }
    await route.handler({ method: 'GET', url: '/api/model-orchestrator/families' + query }, {
      writeHead(code) {
        captured.code = code
      },
      end(body) {
        captured.body = JSON.parse(body)
      },
    })
    return captured
  }
  const all = await read('')
  check('the families route answers', all.code, 200)
  checkThat('it lists every model group', all.body.total >= 3 && all.body.count === all.body.total, String(all.body.total))
  checkThat('groups carry the facts a picker shows',
    all.body.groups.every(group => typeof group.vision === 'boolean' && 'contextWindow' in group))
  // LOCAL PATCH 2026-10-24: one family can be advertised under several ids
  // (build stamps, channel namespaces), and the picker's search has to see them.
  checkThat('groups list the advertised ids behind the family',
    all.body.groups.every(group => Array.isArray(group.models) && group.models.length > 0),
    JSON.stringify(all.body.groups.map(group => group.models)))
  const filtered = await read('?q=mimo')
  checkThat('the q filter narrows the list',
    filtered.body.count < all.body.count && filtered.body.groups.every(group => (String(group.family) + ' ' + String(group.key)).toLowerCase().includes('mimo')),
    String(filtered.body.count))
  check('the configured preference is reported', typeof all.body.configured, 'string')
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks)
if (failures > 0) process.exitCode = 1
