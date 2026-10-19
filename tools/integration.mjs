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
checkThat('the model catalog was fetched', routes.size === 3, [...routes.keys()].join(','))
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

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks)
if (failures > 0) process.exitCode = 1
