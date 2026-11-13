import { evaluate, chooseEffort } from './src/router.js'

const mk = (provider, model, key, extra = {}) => ({
  provider, model, key, family: key, modelName: model, quality: 0.8, intel: 40,
  tags: [], vision: true, contextWindow: 200000, burn: 0.2, denied: false,
  reportTtftMs: null, lanePenaltyMs: 0, freeLane: false, multiplier: 1,
  channel: { available: true, today: null, freeToday: null }, ...extra,
})
const health = { stateOf: () => ({ status: 'ok', available: true, until: 0, reason: '', strikes: 0 }), observed: () => ({ ttftMs: null, samples: 0, lastOkAt: 0 }) }
const config = { strategy: 'balanced', latencyGateMs: 10000, anchorBonus: 0.04 }
const needs = { vision: false, tools: true, longContext: false, estimatedTokens: 8000, turnTokens: 0, complexity: 0.5, escalate: false, economy: false }

const rows = [
  mk('slow-lane', 'm', 'g', { reportTtftMs: 200000, burn: 0.9 }),
  mk('fast-lane', 'm2', 'g', { reportTtftMs: 100, burn: 0.1 }),
]
const ev = evaluate({ rows, health, config, needs, anchor: null, mode: 'auto', now: Date.now() })
const g = ev.allGroups.get('g')
console.log('[1] group.all 行序     :', g.all.map(e => e.row.provider).join(' -> '))
console.log('[1] 评分后 lanes 序    :', g.lanes.map(e => e.row.provider + '(' + e.utility.toFixed(3) + ')').join(' -> '))
console.log('[1] 面板 preview 会选  :', g.all.find(e => e.inspection.eligible)?.row.provider)
console.log('[1] 路由器会选         :', g.lanes[0]?.row.provider)

const row = { reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'medium' } }
console.log('[2] balanced+requested=max    :', chooseEffort(row, 'max', { reasoningEffort: 'auto' }, 'balanced'))
console.log('[2] balanced+requested=undef  :', chooseEffort(row, undefined, { reasoningEffort: 'auto' }, 'balanced'))
console.log('[2] economy+requested=max     :', chooseEffort(row, 'max', { reasoningEffort: 'auto' }, 'economy'))

const many = []
for (let i = 0; i < 709; i++) {
  many.push(mk('p' + (i % 20), 'model-' + i + '-' + (i % 7), 'fam-' + (i % 482), {
    reportTtftMs: 1000 + (i % 90) * 1000,
    channel: { available: true, today: { requests: i % 50, errors: i % 5, inputTokens: (i % 13) * 1000000, outputTokens: 100000, ttftMs: 2000 + (i % 30) * 500, ttftCount: 5 }, freeToday: null },
  }))
}
const t0 = Date.now()
const N = 30
for (let k = 0; k < N; k++) evaluate({ rows: many, health, config, needs, anchor: null, mode: 'auto', now: Date.now() })
const per = (Date.now() - t0) / N
console.log('[3] 709 行单次 evaluate :', per.toFixed(1), 'ms; 面板每次轮询 3 次约', (per * 3).toFixed(1), 'ms')
