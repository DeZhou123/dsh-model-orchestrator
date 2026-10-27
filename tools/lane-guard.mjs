/**
 * Lane guard + duo pairing: offline assertions.
 *
 * Everything runs against temp files, so this suite never reads the real
 * `_supervisor/policy.json` and never touches a real health.json. That matters:
 * a test that depended on this machine's current lanes would go green or red for
 * reasons that have nothing to do with the code under test.
 *
 *   node tools/lane-guard.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLanePolicy, laneVerdict, auditLanes, peerRuntime, readPatchDefaultModel, pairFor, laneKey } from '../src/lanes.js'

let passed = 0
const failures = []
function ok(condition, label, extra) {
  if (condition) { passed += 1; return }
  failures.push(label + (extra === undefined ? '' : ' — ' + extra))
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected))
}

const dir = mkdtempSync(join(tmpdir(), 'lane-guard-'))
const policyPath = join(dir, 'policy.json')
const writePolicy = (main, worker) => writeFileSync(policyPath, JSON.stringify({ main: { models: main }, worker: { models: worker } }))

// ── 1. a clean split ───────────────────────────────────────────────────────
writePolicy(
  [{ provider: 'freellmapi', model: 'qwen3.6-27b' }, { provider: 'codearts', model: 'ds-4.1' }],
  [{ provider: 'raccoon', model: 'sn-flash' }, { provider: 'loomy', model: 'qwen3.8-flash' }],
)
const clean = loadLanePolicy({ policyPath, laneId: 'b' })
ok(clean.ok === true, 'clean policy loads', clean.error)
eq(clean.laneId, 'b', 'laneId is b')
eq([clean.own.length, clean.foreign.length], [2, 2], 'own and foreign chains both read')

const rows = [
  { provider: 'freellmapi', model: 'qwen3.6-27b', family: 'qwen3.6' },
  { provider: 'codearts', model: 'ds-4.1', family: 'deepseek4' },
  { provider: 'raccoon', model: 'sn-flash', family: 'deepseek4' },
  { provider: 'loomy', model: 'qwen3.8-flash', family: 'qwen3.8' },
]

// ── 2. the guard blocks the other lane and allows its own ──────────────────
eq(laneVerdict({ provider: 'freellmapi', model: 'qwen3.6-27b' }, clean).foreign, true, 'foreign lane blocked')
eq(laneVerdict({ provider: 'RACCOON', model: 'SN-FLASH' }, clean).foreign, false, 'own lane allowed (case folded)')
eq(laneVerdict({ provider: 'nobody', model: 'nothing' }, clean).foreign, false, 'unclaimed model allowed')
eq(laneVerdict({ provider: 'freellmapi', model: 'qwen3.6-27b' }, clean).lane, 'a', 'blocked row reports which lane claims it')

// ── 3. audit passes on a clean, provider-diverse split ─────────────────────
const auditClean = auditLanes({ rows, policy: clean })
eq(auditClean.ok, true, 'audit passes on a clean split')
eq(auditClean.checks.map(check => check.id), ['overlap', 'diversity'], 'two checks reported')
eq(auditClean.ownProviders, ['loomy', 'raccoon'], 'B lane spans two providers')
ok(auditClean.checks.every(check => check.evidence !== undefined), 'every check carries evidence')

// ── 4. an intersection fails the audit ─────────────────────────────────────
writePolicy(
  [{ provider: 'freellmapi', model: 'qwen3.6-27b' }],
  [{ provider: 'freellmapi', model: 'qwen3.6-27b' }, { provider: 'raccoon', model: 'sn-flash' }],
)
const overlap = loadLanePolicy({ policyPath, laneId: 'b' })
const auditOverlap = auditLanes({ rows, policy: overlap })
eq(auditOverlap.checks.find(check => check.id === 'overlap').pass, false, 'intersection fails the overlap check')
eq(auditOverlap.overlap.length, 1, 'the shared model is named')

// ── 5. one provider is a diversity failure (the 429 lesson) ────────────────
writePolicy(
  [{ provider: 'freellmapi', model: 'gpt-oss-120b' }],
  [{ provider: 'freellmapi', model: 'qwen3.6-27b' }, { provider: 'freellmapi', model: 'mistral-small' }],
)
const mono = auditLanes({ rows, policy: loadLanePolicy({ policyPath, laneId: 'b' }) })
eq(mono.checks.find(check => check.id === 'diversity').pass, false, 'single-provider chain fails diversity')
ok(/停摆/.test(mono.checks.find(check => check.id === 'diversity').detail), 'the detail explains the risk, not just the number')

// ── 6. missing inputs degrade to "no opinion", never throw ─────────────────
const missing = loadLanePolicy({ policyPath: join(dir, 'nope.json'), laneId: 'b' })
ok(missing.ok === false && missing.error !== '', 'missing policy reports an error')
eq(laneVerdict({ provider: 'x', model: 'y' }, missing).foreign, false, 'missing policy blocks nothing')
eq(auditLanes({ rows, policy: missing }).ok, false, 'missing policy does not claim a pass')
eq(loadLanePolicy({}).ok, false, 'no path means no policy')
eq(loadLanePolicy({ policyPath, laneId: 'z' }).ok, false, 'unknown lane id is rejected')
writeFileSync(join(dir, 'broken.json'), '{ not json')
eq(loadLanePolicy({ policyPath: join(dir, 'broken.json'), laneId: 'b' }).ok, false, 'invalid JSON is reported, not thrown')

// ── 7. peer runtime: health.json beats the patch ───────────────────────────
const healthPath = join(dir, 'health-b.json')
const patchPath = join(dir, 'patch-a.yml')
writeFileSync(healthPath, JSON.stringify({ current: { provider: 'Raccoon', model: 'sn-deepseek-v4-1-flash-1017' } }))
writeFileSync(patchPath, [
  'config:',
  '  - id: agent-default-model',
  '    config:',
  "      provider: 'freellmapi'",
  "      model: 'qwen3.6-27b'",
  '  - id: something-else',
  '    config:',
  "      provider: 'ignored'",
  "      model: 'ignored'",
].join('\n'))
eq(readPatchDefaultModel(patchPath), { provider: 'freellmapi', model: 'qwen3.6-27b' }, 'patch parser reads the right row only')
eq(readPatchDefaultModel(join(dir, 'nope.yml')), null, 'missing patch yields null')
const fromPatch = peerRuntime({ healthPaths: [join(dir, 'nope.json')], defaultModelPaths: [patchPath] })
eq(fromPatch.source, 'patch', 'falls back to the patch when there is no health file')
const fromHealth = peerRuntime({ healthPaths: [healthPath], defaultModelPaths: [patchPath] })
eq(fromHealth.source, 'health.json', 'health.json wins over the patch')
eq([fromHealth.provider, fromHealth.model], ['raccoon', 'sn-deepseek-v4-1-flash-1017'], 'health read is case folded')
eq(peerRuntime({}).ok, false, 'no evidence means not ok')
eq(peerRuntime({}).source, 'none', 'no evidence is labelled none')

// ── 8. pairing refuses the same mind, and refuses a foreign-lane model ─────
writePolicy([{ provider: 'freellmapi', model: 'qwen3.6-27b' }], [{ provider: 'raccoon', model: 'sn-flash' }])
const fresh = loadLanePolicy({ policyPath, laneId: 'b' })
const candidates = [
  { provider: 'raccoon', model: 'sn-flash', family: 'deepseek4', utility: 0.9 },
  { provider: 'freellmapi', model: 'qwen3.6-27b', family: 'qwen3.6', utility: 0.8 },
  { provider: 'loomy', model: 'qwen3.8-flash', family: 'qwen3.8', utility: 0.7 },
]
const pair = pairFor({ candidates, peer: fromHealth, policy: fresh })
eq([pair.self.provider, pair.self.model], ['loomy', 'qwen3.8-flash'], 'pairing skips the same family, the same provider and the foreign lane')
ok(pair.checks.every(check => check.pass), 'all pairing checks pass')
eq(pair.checks.map(check => check.id), ['peer', 'family', 'provider', 'lane'], 'the lane check is reported when a policy is supplied')

const noPeer = pairFor({ candidates, peer: peerRuntime({}) })
eq(noPeer.self, null, 'no peer evidence means no proposal')
eq(noPeer.checks[0].pass, false, 'the peer check fails rather than assuming')

// ── 9. keys fold case, and only the far lane is "foreign" ──────────────────
eq(laneKey('A', 'M'), laneKey('a', 'm'), 'lane keys fold case')

rmSync(dir, { recursive: true, force: true })

console.log('lane-guard: ' + passed + ' passed, ' + failures.length + ' failed')
for (const failure of failures) console.log('  FAIL ' + failure)
if (failures.length > 0) process.exitCode = 1
