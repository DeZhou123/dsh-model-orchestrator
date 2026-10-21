/**
 * Client-half smoke test: load `client.js` against a stub ModuleLoader and render
 * all three slot entries (composer strip, New Session chip, official model-seat
 * label) plus every panel tab.
 *
 * The browser half is a hand-authored module with no build step, so a typo in a
 * hook order or a prop name only shows up as a blank composer at runtime. This
 * harness evaluates the component tree with a minimal React stand-in: hooks are
 * seeded per render, so a component that would throw (or silently render
 * nothing) fails here instead of in the UI.
 *
 * Run: node tools/client-smoke.mjs
 *
 * @module tools/client-smoke
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(path.resolve(HERE, '..', 'client.js'), 'utf8')

let checks = 0
let failures = 0
function check(label, actual, expected) {
  checks += 1
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log('  ok    ' + label + ' = ' + JSON.stringify(actual))
  else {
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

// ── minimal React ───────────────────────────────────────────────────────────
const hookState = { queue: [], index: 0, calls: [] }
const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    const position = hookState.index
    hookState.index += 1
    const value = position < hookState.queue.length ? hookState.queue[position] : initial
    hookState.calls.push(value)
    return [value, () => {}]
  },
  useCallback(fn) {
    return fn
  },
  useEffect(fn) {
    // Effects run: the model-list row is installed from them, and that install is
    // the part of this bundle a render-only check cannot see.
    hookState.calls.push('effect')
    const cleanup = fn()
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  useMemo(fn) {
    return fn()
  },
  useRef(value) {
    return { current: value }
  },
  // The seat label reads the switch through uSES; the stub reads straight through, so
  // a render here sees exactly what the injected row last published.
  useSyncExternalStore(subscribe, getSnapshot) {
    hookState.calls.push('sync')
    return getSnapshot()
  },
}

// ── module loader + browser stubs ───────────────────────────────────────────
const slots = []
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
}
// ── minimal DOM, enough for the one node this bundle owns ───────────────────
function nodeMatches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1)
  if (selector === 'button') return node.tagName === 'BUTTON'
  if (selector === '[data-mo-name]' || selector === '[data-mo-hint]' || selector === '[data-mo-check]') {
    return node.attrs[selector.slice(1, -1)] !== undefined
  }
  if (selector === 'div[role="menu"][id$="-models"]') {
    return node.tagName === 'DIV' && node.attrs.role === 'menu' && String(node.id).endsWith('-models')
  }
  if (selector === 'button[aria-haspopup="menu"][aria-controls$="-menu"]') {
    return node.tagName === 'BUTTON' && node.attrs['aria-haspopup'] === 'menu'
      && String(node.attrs['aria-controls'] ?? '').endsWith('-menu')
  }
  return false
}
function nodeWalk(node, selector) {
  for (const child of node.children) {
    if (nodeMatches(child, selector)) return child
    const deeper = nodeWalk(child, selector)
    if (deeper !== null) return deeper
  }
  return null
}
function makeNode(tagName) {
  return {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    id: '',
    className: '',
    type: '',
    textContent: '',
    dataset: {},
    attrs: {},
    children: [],
    listeners: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value)
    },
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null
    },
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    insertBefore(child, reference) {
      const at = reference === null || reference === undefined ? -1 : this.children.indexOf(reference)
      this.children.splice(at < 0 ? this.children.length : at, 0, child)
      child.parentNode = this
      return child
    },
    querySelector(selector) {
      return nodeWalk(this, selector)
    },
    matches(selector) {
      return nodeMatches(this, selector)
    },
    addEventListener(type, listener) {
      this.listeners[type] = this.listeners[type] ?? []
      this.listeners[type].push(listener)
    },
    click() {
      for (const listener of this.listeners.click ?? []) listener({
        preventDefault() {},
        stopPropagation() {},
      })
    },
    remove() {},
  }
}
// The poller uses a real interval; left running it would keep this process alive.
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
const observers = []
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    observers.push(this)
  }
  observe() {
    this.observing = true
  }
  disconnect() {
    this.observing = false
  }
}
globalThis.MutationObserver = FakeMutationObserver
globalThis.document = {
  visibilityState: 'visible',
  body: makeNode('body'),
  querySelector(selector) {
    return nodeWalk(globalThis.document.body, selector)
  },
  querySelectorAll: () => [],
  createElement: (tag) => makeNode(tag),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
const requests = []
globalThis.fetch = async (url, options = {}) => {
  requests.push({
    url: String(url),
    method: options.method ?? 'GET',
    body: options.body === undefined ? null : JSON.parse(String(options.body)),
  })
  return { ok: true, json: async () => ({ ok: true, groups: [], total: 0 }) }
}

// Evaluate the bundle: it only calls `window.__ModuleLoader__.load`.
new Function(SOURCE)()
check('the bundle declared itself', definition !== null && definition.id, 'dsh-model-orchestrator')

const localeEntries = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(name, callback) {
      return callback()
    },
    register(options, component) {
      slots.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionaries) {
      localeEntries.push({ namespace, dictionaries })
      return () => {}
    },
  },
}
const client = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
client.apply(ctx)

// ── render harness ──────────────────────────────────────────────────────────
function render(component, props, seeds) {
  hookState.queue = seeds ?? []
  hookState.index = 0
  hookState.calls = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node !== 'object') return node
    const { type, props: elementProps } = node
    if (typeof type === 'function') return walk(type(elementProps))
    return { type, props: { ...elementProps, children: walk(elementProps.children) } }
  }
  return walk(React.createElement(component, props))
}

const t = (key) => '[' + key + ']'
const groups = [
  { key: 'glm-5-3', family: 'glm-5.3', lanes: 2, total: 2, bestProvider: 'buddy', bestModel: 'glm-5.3', intel: 45, utility: 0.71, tags: ['balanced'] },
  { key: 'kimi-k3', family: 'kimi-k3', lanes: 1, total: 3, bestProvider: 'trae', bestModel: 'kimi-k3', intel: 44, utility: 0.68, tags: [] },
]
const emptyData = {
  ok: true,
  config: { mode: 'auto', strategy: 'balanced', preferModel: '', preferFallback: 'auto', turnTokenBudget: 0, reasoningEffort: 'auto', routeFirstTurn: true },
  effectiveMode: 'auto',
  current: null,
  next: { mode: 'auto', key: 'glm-5-3', family: 'glm-5.3', provider: 'buddy', model: 'glm-5.3', lanes: 2, total: 2, utility: 0.71 },
  preference: { configured: { model: '', provider: '', fallback: 'auto' }, active: false, suspended: false, group: null, exhausted: null, effectiveMode: 'auto' },
  groups,
  lanes: [],
  decisions: [],
  catalog: { total: 40, groups: 12, providers: [{ id: 'buddy' }], failures: [] },
  dataset: { families: 74, shipped: { reportVersion: 'v-test' }, imported: null },
  channelData: { available: true },
}
const busyData = {
  ...emptyData,
  config: { ...emptyData.config, mode: 'prefer', preferModel: 'glm-5.3', preferFallback: 'auto', turnTokenBudget: 32000 },
  effectiveMode: 'auto',
  current: {
    provider: 'buddy',
    model: 'glm-5.3',
    modelName: 'GLM-5.3',
    family: 'glm-5.3',
    effort: 'high',
    health: { status: 'rate', available: false, reason: '限流', cooldownMs: 45_000 },
    tokensToday: 12_400,
    requests: 7,
    switches: 2,
  },
  preference: {
    configured: { model: 'glm-5.3', provider: '', fallback: 'auto' },
    active: false,
    suspended: true,
    group: { key: 'glm-5-3', family: 'glm-5.3', available: 0, total: 2, lanes: [] },
    exhausted: { reason: '全部 2 条渠道不可用' },
    effectiveMode: 'auto',
  },
  lanes: [
    { provider: 'buddy', model: 'glm-5.3', available: false, cooling: true, reason: '限流', cooldownMs: 45_000, utility: null, ttftMs: 1200, todayTokens: 4000 },
    { provider: 'trae', model: 'glm-5.3', available: true, cooling: false, reason: '', cooldownMs: 0, utility: 0.61, ttftMs: 2400, todayTokens: 900 },
  ],
  decisions: [{ at: 1792314000000, from: 'buddy/glm-5.3', to: 'trae/glm-5.3', reason: '额度耗尽' }],
}

console.log('\n[1] slot registration')
check('three slot entries are registered', slots.length, 3)
check('the composer strip keeps its slot', slots[0].options.name, 'conversation.composer.dock')
check('the New Session chip registers into the hero row', slots[1].options.name, 'conversation.hero.options')
check('the composer seat label is taken over', slots[2].options.name, 'conversation.input.model.label')
checkThat('the seat label shadows the shipped 1017 entry', slots[2].options.priority === -1, String(slots[2].options.priority))
checkThat('all three entries carry a stable id', slots.every(entry => typeof entry.options.id === 'string' && entry.options.id !== ''))
checkThat('all three entries declare the locale namespace', slots.every(entry => entry.options.locale === 'model-orchestrator'))
checkThat('the dictionaries were registered for zh and en',
  localeEntries.length === 1 && localeEntries[0].dictionaries.zh !== undefined && localeEntries[0].dictionaries.en !== undefined)

const strip = slots[0].component
const hero = slots[1].component

console.log('\n[2] the strip renders both states')
const stripLoading = JSON.stringify(render(strip, { t, sessionId: 's1' }, [false, null, '', false]))
checkThat('a loading strip still renders its chip', stripLoading.includes('mo-chip'), stripLoading.slice(0, 80))
const stripPreview = JSON.stringify(render(strip, { t, sessionId: 's1' }, [true, emptyData, '', false, 'overview']))
checkThat('expanding it opens the tabbed panel', stripPreview.includes('mo-tabs') && stripPreview.includes('mo-tabbody'))
checkThat('the overview previews the next route', stripPreview.includes('nextUp'), stripPreview.slice(0, 120))

console.log('\n[3] every panel tab renders')
for (const tab of ['overview', 'models', 'lanes', 'log', 'settings']) {
  let tree = null
  try {
    tree = JSON.stringify(render(strip, { t, sessionId: 's1' }, [true, busyData, '', false, tab]))
  } catch (error) {
    tree = 'THREW: ' + (error instanceof Error ? error.message : String(error))
  }
  checkThat('tab ' + tab + ' renders', !tree.startsWith('THREW'), tree.slice(0, 60))
}
const settingsTree = JSON.stringify(render(strip, { t, sessionId: 's1' }, [true, busyData, '', false, 'settings']))
checkThat('the settings tab exposes the first-turn switch', settingsTree.includes('routeFirstTurn') || settingsTree.includes('firstTurn'))
checkThat('the settings tab exposes the effort row', settingsTree.includes('[effort]'))
checkThat('the settings tab exposes the strategy segments', settingsTree.includes('[strategy]') && settingsTree.includes('[quality]'))
checkThat('a suspended preference shows its banner', settingsTree.includes('preferSuspended'))

console.log('\n[4] the New Session chip')
const heroTree = JSON.stringify(render(hero, { t, sessionId: 's2' }, [false, emptyData, '', false]))
checkThat('the closed chip shows the routed model', heroTree.includes('mo-chipbtn') && heroTree.includes('glm-5.3'), heroTree.slice(0, 100))
const heroOpen = JSON.stringify(render(hero, { t, sessionId: 's2' }, [true, emptyData, '', false, 'overview']))
checkThat('the open chip renders the panel inside a popover', heroOpen.includes('mo-pop') && heroOpen.includes('mo-tabs'))
checkThat('the popover offers a way to close itself', heroOpen.includes('closePop'))
const heroAuto = JSON.stringify(render(hero, { t, sessionId: 's2' }, [false, { ...emptyData, config: { ...emptyData.config, autoSelect: true } }, '', false]))
checkThat('with auto-select on the chip names the switch', heroAuto.includes('[autoSelect]'), heroAuto.slice(0, 120))

console.log('\n[5] the row injected into the official model list')
globalThis.document.body.children.length = 0
const container = makeNode('div')
container.id = 'seat-7-models'
container.setAttribute('role', 'menu')
const trigger = makeNode('button')
trigger.setAttribute('aria-haspopup', 'menu')
trigger.setAttribute('aria-controls', 'seat-7-menu')
let triggerClicks = 0
trigger.addEventListener('click', () => {
  triggerClicks += 1
})
globalThis.document.body.appendChild(container)
globalThis.document.body.appendChild(trigger)
requests.length = 0
render(strip, { t, sessionId: 's1' }, [false, emptyData, '', false])
const row = container.children[0]
checkThat('the row is the first child of the model list',
  row !== undefined && row.id === 'dsh-model-orchestrator-auto-row', String(row?.id))
const rowButton = row === undefined ? null : row.children[0]
checkThat('the row is a radio item that starts unchecked',
  rowButton !== null && rowButton.getAttribute('role') === 'menuitemradio' && rowButton.getAttribute('aria-checked') === 'false')
checkThat('the row carries the localized label',
  rowButton.children[0].children[0].textContent === '[autoSelect]', rowButton.children[0].children[0].textContent)
checkThat('the row explains itself', rowButton.children[0].children[1].textContent === '[autoSelectHint]')
rowButton.click()
checkThat('clicking it writes the switch',
  requests.some(entry => entry.url.endsWith('/config') && entry.body?.autoSelect === true), JSON.stringify(requests))
checkThat('the row repaints as checked',
  row.getAttribute('data-on') === '1' && rowButton.getAttribute('aria-checked') === 'true')
checkThat('clicking it closes the official menu', triggerClicks === 1, String(triggerClicks))

// React owns that subtree: if it drops our row the observer has to put it back.
container.children.length = 0
const observer = observers[observers.length - 1]
observer.callback([{ addedNodes: [], removedNodes: [row] }])
await Promise.resolve()
await Promise.resolve()
checkThat('a dropped row is re-inserted at the top',
  container.children.length === 1 && container.children[0].id === row.id,
  String(container.children.length))

console.log('\n[7] the composer model seat label')
const seat = slots[2].component
const seatProps = (placement) => ({
  t,
  provider: { id: 'buddy' },
  model: { id: 'glm-5.3', name: 'GLM-5.3' },
  placement,
  selected: true,
})
// The switch is on: the row in [5] was just clicked.
const seatOn = render(seat, seatProps('trigger'), [])
check('the trigger names the switch while it owns the choice', seatOn.props.children, '[autoSelect]')
check('the takeover is marked on the label', seatOn.props['data-mo-auto'], '1')
// The two list placements are what the user picks from: they must keep naming models.
check('an option row still names its model', render(seat, seatProps('option'), []).props.children, 'GLM-5.3')
check('the menu cell still names its model', render(seat, seatProps('menu'), []).props.children, 'GLM-5.3')
// Clicking the injected row again turns the switch off through the same writer.
rowButton.click()
check('turning the switch off restores the model name', render(seat, seatProps('trigger'), []).props.children, 'GLM-5.3')
checkThat('the label is unmarked once the switch is off', render(seat, seatProps('trigger'), []).props['data-mo-auto'] === undefined)
checkThat('the switch was written back off', requests.some(entry => entry.url.endsWith('/config') && entry.body?.autoSelect === false), JSON.stringify(requests.slice(-3)))

console.log('\n[8] the preference picker')
const families = {
  loading: false,
  error: '',
  total: 2,
  groups: [
    { key: 'glm-5-3', family: 'glm-5.3', lanes: 2, total: 2, bestProvider: 'buddy', bestModel: 'glm-5.3', intel: 45, utility: 0.71, tags: ['balanced'], vision: true, contextWindow: 1_000_000 },
    { key: 'kimi-k3', family: 'kimi-k3', lanes: 1, total: 3, bestProvider: 'trae', bestModel: 'kimi-k3', intel: 44, utility: 0.66, tags: [], vision: false, contextWindow: 256_000 },
  ],
}
const withPicker = JSON.stringify(render(strip, { t, sessionId: 's1' }, [true, busyData, '', false, 'settings', true, families]))
checkThat('the settings tab opens the dedicated picker', withPicker.includes('mo-modal') && withPicker.includes('mo-dialog'))
checkThat('the picker lists a family with its facts', withPicker.includes('glm-5.3') && withPicker.includes('[intel]'), withPicker.slice(0, 120))
checkThat('the picker offers a way back to auto', withPicker.includes('[pickerNone]'))
const withSearch = JSON.stringify(render(strip, { t, sessionId: 's1' }, [true, busyData, '', false, 'settings', true, families, 'kimi']))
checkThat('the search field is a controlled input', withSearch.includes('mo-search'))

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks)
if (failures > 0) process.exitCode = 1
