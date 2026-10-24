/**
 * Offline smoke test for the orchestrator's pure logic.
 *
 * Run: node tools/smoke.mjs [report.md]
 *
 * The routing decisions are the part that must be right before the plugin is
 * ever installed, and they are pure functions over the catalog rows, the health
 * ledger, the channel data, and the priority dataset — so they can be checked
 * without a running Harness.
 *
 * @module tools/smoke
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDataset, familyFor, familyResolutionFor, familyInfo, reportLaneTtft, deniedReason } from '../src/dataset.js'
import { createHealth, KIND } from '../src/health.js'
import { createCatalog, laneMultiplier, laneIsFree } from '../src/catalog.js'
import { createChannelData, packDayKey } from '../src/channels.js'
import { chooseEffort, evaluate, latencyFor, rankGroups, readNeeds, resolvePreferenceGroup, selectRoute } from '../src/router.js'
import { resolveConfig, sanitizePatch } from '../src/config.js'
import { datasetFromReport } from '../src/report-import.js'
import { DEFAULT_CONFIG } from '../src/policy-defaults.js'
import { foldCandidates, foldKey, NON_INTERACTIVE_SUFFIX } from '../src/families.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPORT = process.argv[2] ?? path.resolve(HERE, '..', '..', 'REPORT-模型测速与优先级.md')

let failures = 0
let checks = 0

function check(label, actual, expected) {
  checks += 1
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log('  FAIL  ' + label + '\n        expected ' + JSON.stringify(expected) + '\n        actual   ' + JSON.stringify(actual))
  } else {
    console.log('  ok    ' + label + ' = ' + JSON.stringify(actual))
  }
}

function checkThat(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log('  ok    ' + label + (detail === '' ? '' : ' (' + detail + ')'))
  } else {
    failures += 1
    console.log('  FAIL  ' + label + (detail === '' ? '' : ' (' + detail + ')'))
  }
}

const NOW = 1792314000000
const clock = () => NOW
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-orchestrator-smoke-'))
const dataset = createDataset({ userDir: tmp })

console.log('\n[1] config resolution')
check('default mode', resolveConfig({}, {}).mode, 'auto')
check('strategy default', DEFAULT_CONFIG.strategy, 'balanced')
check('auto-select defaults off', resolveConfig({}, {}).autoSelect, false)
check('auto-select can be turned on', resolveConfig({ autoSelect: true }, {}).autoSelect, true)
check('the first-turn takeover defaults on', resolveConfig({}, {}).routeFirstTurn, true)
check('prefer with a model stays prefer', resolveConfig({}, { mode: 'prefer', preferModel: 'glm-5.3' }).mode, 'prefer')
check('prefer without a model degrades to auto', resolveConfig({ mode: 'prefer', preferModel: '' }, {}).mode, 'auto')
check('invalid mode keeps the default', resolveConfig({ mode: 'turbo' }, {}).mode, 'auto')
const legacyPin = resolveConfig({ pinProvider: 'buddy', pinModel: 'glm-5.3' }, {})
check('legacy pin becomes a preference', [legacyPin.mode, legacyPin.preferModel, legacyPin.preferProvider], ['prefer', 'glm-5.3', 'buddy'])
check('maxSwitchesPerStep is clamped', resolveConfig({ maxSwitchesPerStep: 99 }, {}).maxSwitchesPerStep, 10)
check('unknown patch keys are dropped', sanitizePatch({ mode: 'off', nope: 1 }), { mode: 'off' })

console.log('\n[2] model identity and the priority prior')
check('sn-glm-5-3 -> glm-5.3', familyFor(dataset, 'sn-glm-5-3'), 'glm-5.3')
check('gmodel -> glm-5.3', familyFor(dataset, 'gmodel'), 'glm-5.3')
check('z-ai/glm-5.3 -> glm-5.3', familyFor(dataset, 'z-ai/glm-5.3'), 'glm-5.3')
check('glm_5_3 folds onto glm-5.3', familyFor(dataset, 'glm_5_3'), 'glm-5.3')
check('deepseek-flash is corrected to v4.1-flash', familyFor(dataset, 'deepseek-flash'), 'deepseek-v4.1-flash')
check('dfmodel -> deepseek-v4-flash', familyFor(dataset, 'dfmodel'), 'deepseek-v4-flash')
check('kmodel_latest -> kimi-k3', familyFor(dataset, 'kmodel_latest'), 'kimi-k3')
check('stepfun/step-5-preview-free -> step-5-preview', familyFor(dataset, 'stepfun/step-5-preview-free'), 'step-5-preview')
check('unknown id is its own family', familyFor(dataset, 'brand-new-model-2099'), 'brand-new-model-2099')
checkThat('exact aliases are fully confident', familyResolutionFor(dataset, 'gmodel').confidence === 1)
checkThat('a loose pattern is only 0.7 confident', familyResolutionFor(dataset, 'mimo-v2.6-flash-ultra').confidence === 0.7,
  String(familyResolutionFor(dataset, 'mimo-v2.6-flash-ultra').confidence))
checkThat('an unknown id has no prior confidence', familyResolutionFor(dataset, 'brand-new-model-2099').confidence === 0)
checkThat('glm-5.3 carries the corrected measured intelligence', familyInfo(dataset, 'glm-5.3').intel === 45)
checkThat('deepseek-v4.1-flash carries the corrected 39', familyInfo(dataset, 'deepseek-v4.1-flash').intel === 39,
  String(familyInfo(dataset, 'deepseek-v4.1-flash').intel))
checkThat('a measured family reports confidence 0.9', familyInfo(dataset, 'glm-5.3').intelConfidence === 0.9)
checkThat('the report keeps lane latency, not a family maximum',
  reportLaneTtft(dataset, 'TRAE 字节', 'glm-5.3') === 6244 && reportLaneTtft(dataset, 'Qoder 中国版 阿里', 'gmodel') === 1042,
  String(reportLaneTtft(dataset, 'TRAE 字节', 'glm-5.3')))
checkThat('a lane the report never timed has no report latency', reportLaneTtft(dataset, 'TRAE 字节', 'brand-new-model-2099') === null)
checkThat('a guardrail classifier is denied', deniedReason(dataset, 'nvidia/nemotron-3.5-content-safety:free') !== null)
checkThat('a region-blocked model is denied', deniedReason(dataset, 'muse-spark-1.3-contributor-free') !== null)
checkThat('a merely slow model is NOT hard-denied', deniedReason(dataset, 'gpt-oss-20b') === null)
checkThat('a batch endpoint keeps its own identity', NON_INTERACTIVE_SUFFIX.test('deepseek-v4.1-flash:batch'))

// LOCAL PATCH 2026-10-24: lanes rename the same weights. Every id below is one
// this machine really received (channel-pack/token-ledger.json, 2026-10-24), and
// each used to become a family of its own — a separate picker row with no
// intelligence, a wrong channel count, and a preference that could only see one
// spelling of one model.
console.log('\n[2b] renamed builds and unknown channel namespaces')
check('sn-...-flash-1017 is the same V4.1 Flash', familyFor(dataset, 'sn-deepseek-v4-1-flash-1017'), 'deepseek-v4.1-flash')
check('opencode/deepseek-v4.1-flash is the same family', familyFor(dataset, 'opencode/deepseek-v4.1-flash'), 'deepseek-v4.1-flash')
check('deepseek/deepseek-v4.1-flash-1017 is the same family', familyFor(dataset, 'deepseek/deepseek-v4.1-flash-1017'), 'deepseek-v4.1-flash')
check('cline-pass/deepseek-v4.1-flash-1017 is the same family', familyFor(dataset, 'cline-pass/deepseek-v4.1-flash-1017'), 'deepseek-v4.1-flash')
check('a regional marker is not a model', familyFor(dataset, 'deepseek-v4.1-flash-sg'), 'deepseek-v4.1-flash')
check('a legacy -latest marker still lands on the family', familyFor(dataset, '~deepseek/deepseek-flash-latest'), 'deepseek-v4.1-flash')
checkThat('a build stamp is a confident identification, not a pattern guess',
  familyResolutionFor(dataset, 'sn-deepseek-v4-1-flash-1017').confidence === 0.95
  && familyResolutionFor(dataset, 'sn-deepseek-v4-1-flash-1017').source === 'folded',
  familyResolutionFor(dataset, 'sn-deepseek-v4-1-flash-1017').confidence + '/' + familyResolutionFor(dataset, 'sn-deepseek-v4-1-flash-1017').source)
checkThat('the fold says which markers it removed',
  JSON.stringify(familyResolutionFor(dataset, 'sn-deepseek-v4-1-flash-1017').foldedFrom) === '["build-tag"]',
  JSON.stringify(familyResolutionFor(dataset, 'sn-deepseek-v4-1-flash-1017').foldedFrom))
checkThat('a build stamp alone never invents a family',
  familyFor(dataset, 'brand-new-model-2099') === 'brand-new-model-2099'
  && familyResolutionFor(dataset, 'brand-new-model-2099').confidence === 0)
checkThat('a non-interactive endpoint stays out of the interactive family',
  familyFor(dataset, 'deepseek/deepseek-v4.1-flash:batch') === 'deepseek/deepseek-v4.1-flash:batch')
checkThat('the fewest fold operations win the candidate order',
  foldCandidates('sn-deepseek-v4-1-flash-1017')[0].key === 'sn-deepseek-v4-1-flash'
  && foldCandidates('sn-deepseek-v4-1-flash-1017')[0].ops.length === 1,
  JSON.stringify(foldCandidates('sn-deepseek-v4-1-flash-1017')[0]))
checkThat('two spellings of one model produce one grouping key',
  foldKey(familyFor(dataset, 'sn-deepseek-v4-1-flash-1017')) === foldKey(familyFor(dataset, 'deepseek-v4.1-flash'))
  && foldKey(familyFor(dataset, 'opencode/deepseek-v4.1-flash')) === foldKey(familyFor(dataset, 'deepseek-v4.1-flash')))
checkThat('a version spelled with dashes resolves to the dotted family',
  familyFor(dataset, 'qwen-3-7-plus') === 'qwen3.7-plus')
checkThat('a model whose own name ends in digits is left alone',
  familyFor(dataset, 'gpt-oss-20b') === 'gpt-oss-20b' && familyFor(dataset, 'nemotron-3-super-120b-a12b') === 'nemotron-3-super-120b-a12b')

console.log('\n[3] failure classification')
const classify = (failure) => createHealth({ userDir: null, clock }).classifyFailure(failure, { strikes: 0, now: NOW })
check('RATE_LIMIT      -> rate', classify({ code: 'RATE_LIMIT', status: 429 }).kind, KIND.RATE)
check('QUOTA           -> quota', classify({ code: 'QUOTA', status: 402 }).kind, KIND.QUOTA)
check('ACCOUNT_QUOTA   -> quota', classify({ code: 'ACCOUNT_QUOTA' }).kind, KIND.QUOTA)
check('REGION_BLOCKED  -> region', classify({ code: 'REGION_BLOCKED' }).kind, KIND.REGION)
check('INVALID_CREDENTIAL -> auth', classify({ code: 'INVALID_CREDENTIAL', status: 401 }).kind, KIND.AUTH)
check('NO_ADAPTER      -> unavailable', classify({ code: 'NO_ADAPTER' }).kind, KIND.UNAVAILABLE)
check('MODEL_NOT_FOUND -> unavailable', classify({ code: 'MODEL_NOT_FOUND', status: 404 }).kind, KIND.UNAVAILABLE)
check('ABORTED is our own request', classify({ code: 'ABORTED' }).kind, KIND.REQUEST)
check('UNSUPPORTED_REASONING_EFFORT is our own request', classify({ code: 'UNSUPPORTED_REASONING_EFFORT' }).kind, KIND.REQUEST)
check('CONTEXT_WINDOW_EXCEEDED -> context', classify({ code: 'CONTEXT_WINDOW_EXCEEDED' }).kind, KIND.CONTEXT)
check('SERVER          -> transient', classify({ code: 'SERVER', status: 502 }).kind, KIND.TRANSIENT)
// LOCAL PATCH 2026-10-18: WorkBuddy/CodeBuddy answers a blocked call with a bare
// 400 + "请求被拦截…request illegal", which used to be filed as our own mistake.
const safetyBlock = classify({ code: 'INVALID_REQUEST', status: 400, message: 'workbuddy: 请求被拦截，请重新发送 request illegal' })
check('a channel safety block is a lane verdict', safetyBlock.kind, KIND.SAFETY)
checkThat('a channel safety block is model-scoped, not lane-wide',
  safetyBlock.scope === 'model' && safetyBlock.cooldownMs > 60_000)
checkThat('a plain 400 stays our own request',
  classify({ code: 'INVALID_REQUEST', status: 400, message: 'unknown field "foo"' }).kind === KIND.REQUEST)
checkThat('quota cools the whole lane until local midnight',
  classify({ code: 'QUOTA' }).cooldownMs > 60_000 && classify({ code: 'QUOTA' }).scope === 'lane')
checkThat('a reported Retry-After is clamped to 5 minutes',
  classify({ code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 3_600_000 }).cooldownMs === 300_000)
const buddyRate = classify({ code: 'QUOTA_EXCEEDED', message: 'buddy: 模型 glm-5.3 所有账号均受限，请稍后再试' })
checkThat('quota-coded rate limit is a model-scoped retry',
  buddyRate.kind === KIND.RATE && buddyRate.scope === 'model' && buddyRate.retryable === true)
const zcodePerModel = classify({ code: 'QUOTA_EXCEEDED', message: 'zcode: 账号在模型 "GLM-5.3" 上的额度已用尽，请改用其它模型。' })
checkThat('per-model quota stays model-scoped', zcodePerModel.kind === KIND.QUOTA && zcodePerModel.scope === 'model')
// LOCAL PATCH 2026-10-24: the advice is often worded as a list. WorkBuddy answers 14018 with
// 「换用其它账号、其它模型或其它通道」, which used to miss every alternative and cool the lane.
const buddyPerModel = classify({
  code: 'QUOTA_EXCEEDED',
  message: 'workbuddy: 账号额度已用尽（上游 code 14018），模型 deepseek-v4.1-flash-sg 在 WorkBuddy (国际版) 下已无可用额度。'
    + '换用其它账号、其它模型或其它通道；等待不会恢复：上游没有给出重置时刻。',
})
checkThat('an enumerated 「其它账号、其它模型」 advice stays model-scoped',
  buddyPerModel.kind === KIND.QUOTA && buddyPerModel.scope === 'model')

// LOCAL PATCH 2026-10-24 (explicit code outranks prose): a structured code must not be
// overruled by words that merely appear nearby — a 502 body mentioning a regional
// endpoint used to become a 24h lane-wide region block.
const regionByProse = classify({ code: 'SERVER', status: 502, message: 'bad gateway (region ap-others)' })
checkThat('a 502 mentioning a region stays transient', regionByProse.kind === KIND.TRANSIENT && regionByProse.scope === 'model')
const creditByProse = classify({ code: 'SERVER', status: 500, message: 'internal server error (credit ledger)' })
checkThat('a 500 mentioning a credit ledger stays transient', creditByProse.kind === KIND.TRANSIENT)
const regionTimeout = classify({ code: 'TIMEOUT', message: 'connect timeout to region endpoint' })
checkThat('a timeout mentioning a region is not a day-long block',
  regionTimeout.kind === KIND.TRANSIENT && regionTimeout.cooldownMs < 60_000)
const authTimeout = classify({ code: 'TIMEOUT', message: '凭据校验超时' })
checkThat('a timeout mentioning credentials is not an auth failure', authTimeout.kind === KIND.TRANSIENT)

// The narrowed region rule still catches a real block.
const realRegion = classify({ code: 'REGION_BLOCKED', status: 403, message: 'not available in your country' })
checkThat('a real region block still cools the lane', realRegion.kind === KIND.REGION && realRegion.scope === 'lane')
const regionProseOnly = classify({ status: 403, message: 'not available in your region' })
checkThat('region prose alone still cools the lane', regionProseOnly.kind === KIND.REGION)

// OpenCode's spent-for-the-day 429 carries no business code and no "quota" word.
const openCodeDaily = classify({ code: 'UPSTREAM_ERROR', status: 429, message: 'our-free-model: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go' })
checkThat('a spent free pool is a quota, not a 30s transient',
  openCodeDaily.kind === KIND.QUOTA && openCodeDaily.cooldownMs > 60_000)

// WorkBuddy's 11128 is our message order, not the lane's health.
const notSystemFirst = classify({ code: 'INVALID_REQUEST', status: 400, message: '{"code":11128,"msg":"first message is not system prompt"}' })
checkThat('a message-order refusal is our own request', notSystemFirst.kind === KIND.REQUEST && notSystemFirst.cooldownMs === 0)
const realQuota = classify({ code: 'QUOTA_EXCEEDED', message: 'cline: 额度已用尽（HTTP 402 Insufficient credits）' })
checkThat('a genuine account-wide quota cools the lane', realQuota.kind === KIND.QUOTA && realQuota.scope === 'lane')

console.log('\n[3c] repeated request rejections park the lane')
{
  const policy = { requestRepeatThreshold: 2, requestRepeatWindowMs: 600_000, requestRepeatBlockMs: 1_800_000 }
  const rejection = { code: 'INVALID_REQUEST', status: 400, message: 'unknown field "foo"' }
  const blockedByPolicy = createHealth({ userDir: null, clock: () => NOW })
  blockedByPolicy.markFailure('workbuddy', 'deepseek-v4.1-flash', {
    code: 'INVALID_REQUEST',
    status: 400,
    message: 'workbuddy: 请求被拦截，请重新发送 request illegal',
  })
  checkThat('a safety block cools only the refused model',
    blockedByPolicy.stateOf('workbuddy', 'deepseek-v4.1-flash').available === false
    && blockedByPolicy.stateOf('workbuddy', 'deepseek-v4.1-flash-sg').available === true)

  let t = NOW
  const health = createHealth({ userDir: null, clock: () => t, requestPolicy: () => policy })
  const first = health.markFailure('buddy', 'glm-5.3', rejection)
  checkThat('one rejected request is still not the lane\u2019s fault',
    first.blocked !== true && health.stateOf('buddy', 'glm-5.3').available === true)
  const second = health.markFailure('buddy', 'glm-5.3', rejection)
  checkThat('the second rejection parks the model',
    second.blocked === true && health.stateOf('buddy', 'glm-5.3').available === false,
    String(second.repeats))
  checkThat('the sibling model on the lane stays usable',
    health.stateOf('buddy', 'step-5-preview').available === true)
  t = NOW + 1_800_001
  checkThat('the park expires on its own', health.stateOf('buddy', 'glm-5.3').available === true)

  let late = NOW
  const spread = createHealth({ userDir: null, clock: () => late, requestPolicy: () => policy })
  spread.markFailure('buddy', 'glm-5.3', rejection)
  late = NOW + 600_001
  const stale = spread.markFailure('buddy', 'glm-5.3', rejection)
  checkThat('a rejection outside the window restarts the count', stale.blocked !== true && stale.repeats === 1)

  const served = createHealth({ userDir: null, clock: () => NOW, requestPolicy: () => policy })
  served.markFailure('buddy', 'glm-5.3', rejection)
  served.markSuccess('buddy', 'glm-5.3', { ttftMs: 800, inputTokens: 5, outputTokens: 5 })
  const afterOk = served.markFailure('buddy', 'glm-5.3', rejection)
  checkThat('a served request clears the streak', afterOk.blocked !== true && afterOk.repeats === 1)

  const shipped = createHealth({ userDir: null, clock: () => NOW })
  shipped.markFailure('buddy', 'glm-5.3', rejection)
  checkThat('the shipped threshold parks on the second rejection',
    shipped.markFailure('buddy', 'glm-5.3', rejection).blocked === true)
}

console.log('\n[3b] health ledger')
{
  const health = createHealth({ userDir: null, clock })
  health.markFailure('buddy', 'glm-5.3', { code: 'CONTEXT_WINDOW_EXCEEDED' })
  checkThat('a context failure does not blame the lane', health.stateOf('buddy', 'glm-5.3').strikes === 0)
  health.markFailure('zcode', 'GLM-5.3', { code: 'QUOTA_EXCEEDED', message: '模型 "GLM-5.3" 额度已用尽，请改用其它模型' })
  checkThat('a per-model quota cools only that model',
    health.stateOf('zcode', 'GLM-5.3').available === false && health.stateOf('zcode', 'GLM-5.3-Flash').available === true)
  health.markFailure('buddy', 'glm-5.3', { code: 'QUOTA' })
  checkThat('a lane-wide quota cools every model on the lane',
    health.stateOf('buddy', 'glm-5.3').available === false && health.stateOf('buddy', 'step-5-preview').available === false)
  health.markSuccess('buddy', 'glm-5.3', { ttftMs: 900, inputTokens: 10, outputTokens: 5 })
  checkThat('a success clears the cooldown', health.stateOf('buddy', 'glm-5.3').available === true)
  health.markSuccess('buddy', 'glm-5.3', { ttftMs: 700, inputTokens: 10, outputTokens: 5 })
  checkThat('observed latency becomes evidence after 2 samples',
    health.observed('buddy', 'glm-5.3').samples === 2,
    String(health.observed('buddy', 'glm-5.3').samples))
}

console.log('\n[4] channel data (channel pack + free lane)')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-channel-'))
  const packDir = path.join(home, 'channel-pack')
  const freeDir = path.join(home, 'our-free-model')
  fs.mkdirSync(packDir, { recursive: true })
  fs.mkdirSync(freeDir, { recursive: true })
  fs.writeFileSync(path.join(packDir, 'state.json'), JSON.stringify({
    accounts: [
      { provider: 'buddy', enabled: true, modelRateLimits: { 'glm-5.3': NOW + 3_600_000 } },
      { provider: 'buddy', enabled: true },
      { provider: 'zcode', enabled: true, modelRateLimits: { 'GLM-5.3': NOW + 3_600_000 } },
      { provider: 'raccoon', enabled: false },
    ],
    disabledModels: { trae: { 'blocked-model': true } },
  }))
  const day = packDayKey(NOW)
  fs.writeFileSync(path.join(packDir, 'token-ledger.json'), JSON.stringify({
    schema: 'test',
    days: {
      [day]: {
        'direct|buddy|acct|glm-5.3': {
          requests: 10, errors: 2, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0,
          ttftSumMs: 20000, ttftCount: 10, tpsSum: 0, tpsCount: 0,
        },
      },
    },
  }))
  fs.writeFileSync(path.join(freeDir, 'availability.json'), JSON.stringify({
    results: {
      'step-5-preview-free': { state: 'unavailable', detail: 'quota', latencyMs: 300, at: NOW },
      'glm-5.3-free': { state: 'available', latencyMs: 120, at: NOW },
    },
  }))
  fs.writeFileSync(path.join(freeDir, 'stats.json'), JSON.stringify({
    days: {
      [day]: {
        models: {
          'step-5-preview-free': { calls: 5, failed: 2, input: 100, output: 50, cacheRead: 0, ttftMs: 1000, ttftSamples: 2 },
        },
      },
    },
  }))
  const channels = createChannelData({ home, channelPackDir: packDir, freeModelDir: freeDir, clock })
  channels.refresh()
  const buddy = channels.signal('buddy', 'glm-5.3')
  checkThat('one of two accounts limited is still routable', buddy.available !== false, String(buddy.available))
  checkThat('the ledger gives today\'s exact lane latency', buddy.today !== null && buddy.today.ttftMs === 2000,
    String(buddy.today && buddy.today.ttftMs))
  checkThat('the ledger gives today\'s token spend', buddy.today !== null && buddy.today.inputTokens === 1000 && buddy.today.outputTokens === 500)
  const zcode = channels.signal('zcode', 'GLM-5.3')
  checkThat('all accounts limited means unavailable', zcode.available === false)
  const trae = channels.signal('trae', 'blocked-model')
  checkThat('a model disabled in the pack is unavailable', trae.disabled === true && trae.available === false)
  const freeDown = channels.signal('our-free-model', 'step-5-preview-free')
  checkThat('the free lane\'s probe can bench a model', freeDown.available === false)
  const freeUp = channels.signal('our-free-model', 'glm-5.3-free')
  checkThat('the free lane\'s probe can vouch for a model', freeUp.available === true)
  checkThat('free-lane stats are read per model', freeDown.freeToday !== null && freeDown.freeToday.calls === 5)
  checkThat('channel data is marked present', channels.hasData() === true)
}

console.log('\n[5] catalog decoration')
{
  const models = {
    buddy: [
      { provider: 'buddy', id: 'glm-5.3', name: 'GLM-5.3 · x0.06' },
      { provider: 'buddy', id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash · x0.2' },
      { provider: 'buddy', id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash · x0.2' },
      { provider: 'buddy', id: 'mimo-v2.6-flash', name: 'Mimo Flash · x0.06' },
      // LOCAL PATCH 2026-10-24: the same weights under a 10/17 build stamp and a
      // friendlier display name — exactly what Raccoon serves after a rename.
      { provider: 'buddy', id: 'sn-deepseek-v4-1-flash-1017', name: 'DeepSeek-V4.1-Flash · x0.05' },
    ],
    trae: [
      { provider: 'trae', id: 'glm-5.3', name: 'GLM-5.3 · x0.79' },
      { provider: 'trae', id: 'deepseek-v4.1-flash:batch', name: 'DeepSeek V4.1 · x0.1' },
      { provider: 'trae', id: 'some-new-model', name: 'Some New Model · x0.3' },
      // The same weights advertised under an unknown channel namespace.
      { provider: 'trae', id: 'opencode/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash · x0.1' },
    ],
  }
  const infos = {
    'buddy/glm-5.3': { contextWindow: 1_000_000, modalities: ['text'], efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    // TRAE exposes only low/high for the same weights, so its achievable quality
    // must be slightly below buddy's max-capable lane.
    'trae/glm-5.3': { contextWindow: 1_000_000, modalities: ['text'], efforts: ['low', 'high'], defaultEffort: 'high' },
    'buddy/DeepSeek-V4-Flash': { contextWindow: 1_000_000, modalities: ['text', 'image'], efforts: [], defaultEffort: undefined },
    'buddy/mimo-v2.6-flash': { contextWindow: 200_000, modalities: ['text'], efforts: [], defaultEffort: undefined },
  }
  const llm = {
    listProviders: () => [{ id: 'buddy', name: 'CodeBuddy' }, { id: 'trae', name: 'TRAE' }],
    listModels: async (provider) => models[provider] ?? [],
    resolveModelInfo: async (provider, model) => {
      const info = infos[provider + '/' + model] ?? { contextWindow: 200_000, modalities: ['text'], efforts: [], defaultEffort: undefined }
      return {
        provider,
        id: model,
        name: model,
        ...(info.contextWindow === undefined ? {} : { context: { contextWindow: info.contextWindow } }),
        ...(info.modalities === undefined ? {} : { inputModalities: info.modalities }),
        ...(info.efforts === undefined || info.efforts.length === 0 ? {} : {
          reasoning: {
            efforts: info.efforts.map(id => ({ id, name: id })),
            ...(info.defaultEffort === undefined ? {} : { defaultEffort: info.defaultEffort }),
          },
        }),
      }
    },
  }
  const config = resolveConfig({ deny: ['some-new-model'] }, {})
  const catalog = createCatalog({ ctx: { llm }, dataset, channelData: null, getConfig: () => config })
  await catalog.refresh('test')
  const current = catalog.current
  checkThat('the catalog lists both providers', current.providers.length === 2, String(current.providers.length))
  const glmBuddy = catalog.row('buddy', 'glm-5.3')
  checkThat('family and intelligence attach to the row', glmBuddy !== undefined && glmBuddy.family === 'glm-5.3' && glmBuddy.intel === 45)
  checkThat('the lane multiplier comes from the display name', glmBuddy !== undefined && glmBuddy.multiplier === 0.06)
  checkThat('the exact lane report latency is used', glmBuddy !== undefined && glmBuddy.reportTtftMs === 2937,
    String(glmBuddy && glmBuddy.reportTtftMs))
  const glmTrae = catalog.row('trae', 'glm-5.3')
  checkThat('another lane keeps its own report latency', glmTrae !== undefined && glmTrae.reportTtftMs === 6244,
    String(glmTrae && glmTrae.reportTtftMs))
  checkThat('a max-capable lane outranks the same weights capped at high',
    glmBuddy.quality > glmTrae.quality,
    glmBuddy.quality.toFixed(3) + ' vs ' + glmTrae.quality.toFixed(3))
  checkThat('vision comes from the adapter modalities', catalog.row('buddy', 'DeepSeek-V4-Flash')?.vision === true)
  const twins = [catalog.row('buddy', 'DeepSeek-V4-Flash'), catalog.row('buddy', 'DeepSeek-V4-Flash-Official')]
  checkThat('a duplicate route id is denied', twins.some(row => row.denied && /重复/.test(row.deniedReason || '')),
    twins.map(row => row.denied ? row.deniedReason : 'ok').join(' | '))
  checkThat('a batch endpoint is denied', catalog.row('trae', 'deepseek-v4.1-flash:batch')?.denied === true)
  checkThat('a user-denied model is denied', catalog.row('trae', 'some-new-model')?.denied === true)
  checkThat('agent-weak is tagged', (catalog.row('buddy', 'mimo-v2.6-flash')?.tags ?? []).includes('agent-weak'))
  checkThat('a pattern match shrinks the intelligence prior',
    (catalog.row('buddy', 'mimo-v2.6-flash')?.quality ?? 1) < (familyInfo(dataset, 'mimo-v2.6-flash').intel === null ? 1 : 0.99))

  // LOCAL PATCH 2026-10-24: a renamed build is the same model on a lane, not a
  // model of its own — it must land on the family (and its intelligence) and be
  // listed as one id of that family, so the picker shows one row with both ids.
  const renamed = catalog.row('buddy', 'sn-deepseek-v4-1-flash-1017')
  checkThat('a renamed build resolves to the measured family',
    renamed?.family === 'deepseek-v4.1-flash' && renamed?.familySource === 'folded' && renamed?.intel === 39,
    [renamed?.family, renamed?.familySource, renamed?.intel].join('/'))
  checkThat('the build stamp no longer shadows the family score',
    (renamed?.quality ?? 0) > 0.6,
    String(renamed?.quality))
  const ranked = rankGroups({ rows: current.rows, health: createHealth({ userDir: null, clock }), config, anchor: null })
  const dsGroup = ranked.find(group => group.family === 'deepseek-v4.1-flash')
  // Blocking a model has to block every spelling of it, or the renamed build is
  // a way around the user's own deny list.
  const denyCatalog = createCatalog({
    ctx: { llm },
    dataset,
    channelData: null,
    getConfig: () => resolveConfig({ deny: ['deepseek-v4.1-flash'] }, {}),
  })
  await denyCatalog.refresh('test')
  checkThat('denying the family name blocks every spelling of it',
    denyCatalog.current.rows
      .filter(row => row.family === 'deepseek-v4.1-flash')
      .every(row => row.denied === true),
    denyCatalog.current.rows.filter(row => row.family === 'deepseek-v4.1-flash').map(row => row.model + '=' + row.denied).join(' '))
  const denyByIdCatalog = createCatalog({
    ctx: { llm },
    dataset,
    channelData: null,
    getConfig: () => resolveConfig({ deny: ['sn-deepseek-v4-1-flash-1017'] }, {}),
  })
  await denyByIdCatalog.refresh('test')
  checkThat('denying one build id blocks the family it belongs to',
    denyByIdCatalog.row('trae', 'opencode/deepseek-v4.1-flash')?.denied === true,
    String(denyByIdCatalog.row('trae', 'opencode/deepseek-v4.1-flash')?.deniedReason))
  const denyLaneCatalog = createCatalog({
    ctx: { llm },
    dataset,
    channelData: null,
    getConfig: () => resolveConfig({ deny: ['buddy/sn-deepseek-v4-1-flash-1017'] }, {}),
  })
  await denyLaneCatalog.refresh('test')
  checkThat('a provider-qualified deny entry blocks one lane only',
    denyLaneCatalog.row('buddy', 'sn-deepseek-v4-1-flash-1017')?.denied === true
    && denyLaneCatalog.row('trae', 'opencode/deepseek-v4.1-flash')?.denied !== true)
  checkThat('both spellings live in one group on two lanes, with both ids listed',
    dsGroup !== undefined
    && dsGroup.models.length === 2
    && dsGroup.models.includes('sn-deepseek-v4-1-flash-1017')
    && dsGroup.models.includes('opencode/deepseek-v4.1-flash')
    && dsGroup.total === 2,
    JSON.stringify([dsGroup?.models, dsGroup?.total]))
}

console.log('\n[6] two-level routing')
function makeRow(overrides = {}) {
  const model = overrides.model ?? 'glm-5.3'
  return {
    provider: 'buddy',
    providerName: 'CodeBuddy',
    model,
    modelName: model,
    key: overrides.key ?? foldKey(overrides.family ?? model),
    family: overrides.family ?? model,
    familyConfidence: 1,
    familySource: 'alias',
    intel: overrides.intel ?? 45,
    intelConfidence: 0.9,
    estimatedIntel: null,
    quality: overrides.quality ?? 0.9,
    reportTtftMs: overrides.reportTtftMs ?? null,
    lanePenaltyMs: 0,
    contextWindow: overrides.contextWindow ?? 1_000_000,
    modalities: overrides.modalities ?? ['text'],
    reasoning: overrides.reasoning ?? null,
    tags: overrides.tags ?? [],
    denied: false,
    deniedReason: null,
    vision: overrides.vision ?? false,
    multiplier: overrides.multiplier ?? 1,
    freeLane: overrides.freeLane ?? false,
    burn: overrides.burn ?? 0.4,
    channel: overrides.channel ?? null,
    ...overrides,
  }
}
function lane(provider, model, extra = {}) {
  return makeRow({ provider, model, modelName: model, ...extra })
}

{
  const rows = [
    lane('buddy', 'glm-5.3'),
    lane('trae', 'step-5-preview', { family: 'step-5-preview', intel: 44, quality: 0.6, burn: 0.05, reportTtftMs: 800 }),
  ]
  const health = createHealth({ userDir: null, clock })
  const config = resolveConfig({}, {})
  const needs = readNeeds({}, config)
  const decision = selectRoute({ rows, health, config, anchor: null, needs, mode: 'auto' })
  check('the best model group wins', decision?.family, 'glm-5.3')
  health.markFailure('buddy', 'glm-5.3', { code: 'QUOTA' })
  const afterQuota = selectRoute({ rows, health, config, anchor: null, needs, mode: 'auto' })
  check('a cooling lane is routed around', afterQuota?.family, 'step-5-preview')

  const siblings = [
    lane('buddy', 'glm-5.3'),
    lane('raccoon', 'glm-5.3', { quality: 0.9 }),
    lane('trae', 'step-5-preview', { family: 'step-5-preview', intel: 44, quality: 0.6, burn: 0.05 }),
  ]
  const recovered = createHealth({ userDir: null, clock })
  const sameModel = selectRoute({
    rows: siblings,
    health: recovered,
    config,
    anchor: { provider: 'buddy', model: 'glm-5.3' },
    needs,
    mode: 'auto',
    forceGroupKey: 'glm-5-3',
    exclude: new Set(['buddy\u0000glm-5.3']),
  })
  check('a failure first retries the same model on another channel', [sameModel?.family, sameModel?.provider], ['glm-5.3', 'raccoon'])
  checkThat('the decision says it stayed on the same model', sameModel?.sameModel === true)
}

console.log('\n[7] capability filters')
{
  const health = createHealth({ userDir: null, clock })
  const config = resolveConfig({}, {})
  const rows = [
    lane('buddy', 'glm-5.3', { vision: false, contextWindow: 32_000 }),
    lane('trae', 'kimi-k3', { family: 'kimi-k3', intel: 44, quality: 0.86, vision: true, contextWindow: 1_000_000 }),
  ]
  const vision = selectRoute({ rows, health, config, anchor: null, needs: readNeeds({ hasImage: true }, config), mode: 'auto' })
  check('an image request picks a vision lane', vision?.family, 'kimi-k3')

  const long = selectRoute({
    rows,
    health,
    config,
    anchor: null,
    needs: readNeeds({ hasImage: false, estimatedTokens: 200_000 }, config),
    mode: 'auto',
  })
  check('a long request picks the big context', long?.family, 'kimi-k3')

  const minCtx = selectRoute({
    rows,
    health,
    config,
    anchor: null,
    needs: readNeeds({ hasImage: false, estimatedTokens: 50_000 }, config),
    mode: 'auto',
    minContextWindow: 100_000,
  })
  check('a context floor after a failure is honoured', minCtx?.family, 'kimi-k3')

  const rateLimited = createChannelData({ home: tmp, channelPackDir: path.join(tmp, 'missing'), freeModelDir: path.join(tmp, 'missing'), clock })
  rateLimited.refresh()
  const limitedRow = lane('buddy', 'glm-5.3', {
    channel: {
      available: false, disabled: false, rateLimitedUntil: NOW + 600_000, limitedAccounts: 1, accounts: 1,
      today: null, free: null, freeToday: null,
    },
  })
  const limited = selectRoute({
    rows: [limitedRow, rows[1]],
    health,
    config,
    anchor: null,
    needs: readNeeds({}, config),
    mode: 'auto',
  })
  check('a channel rate limit is routed around', limited?.family, 'kimi-k3')
}

console.log('\n[8] latency evidence order')
{
  const health = createHealth({ userDir: null, clock })
  health.markSuccess('buddy', 'glm-5.3', { ttftMs: 800, inputTokens: 5, outputTokens: 5 })
  health.markSuccess('buddy', 'glm-5.3', { ttftMs: 900, inputTokens: 5, outputTokens: 5 })
  const liveRow = makeRow({ provider: 'buddy', model: 'glm-5.3', channel: { today: { ttftMs: 2000, ttftCount: 5 }, available: null } })
  const live = latencyFor(liveRow, health, NOW)
  checkThat('live evidence outranks the channel ledger', live.source === 'live' && live.samples >= 2, live.source + ':' + live.samples)
  const noLive = createHealth({ userDir: null, clock })
  const channel = latencyFor(liveRow, noLive, NOW)
  checkThat('the channel ledger is the second source', channel.source === 'channel' && channel.ms === 2000, channel.source + ':' + channel.ms)
  const reportRow = makeRow({ provider: 'buddy', model: 'glm-5.3', reportTtftMs: 1234 })
  const report = latencyFor(reportRow, noLive, NOW)
  checkThat('the exact lane report is the third source', report.source === 'report' && report.ms === 1234, report.source + ':' + report.ms)
  const noneRow = makeRow({ provider: 'buddy', model: 'glm-5.3' })
  checkThat('no evidence is honest about it', latencyFor(noneRow, noLive, NOW).source === 'none')
  const freeRow = makeRow({
    provider: 'our-free-model',
    model: 'step-5-preview-free',
    channel: {
      available: true,
      disabled: false,
      rateLimitedUntil: 0,
      limitedAccounts: 0,
      accounts: 0,
      today: null,
      free: null,
      freeToday: { calls: 5, failed: 0, inputTokens: 100, outputTokens: 50, ttftMs: 1500, ttftSamples: 3 },
    },
  })
  const freeLatency = latencyFor(freeRow, noLive, NOW)
  checkThat('the free lane\'s own stats are the second latency source',
    freeLatency.source === 'channel' && freeLatency.ms === 1500, freeLatency.source + ':' + freeLatency.ms)
}

console.log('\n[9] preference mode')
{
  const health = createHealth({ userDir: null, clock })
  const config = resolveConfig({}, { mode: 'prefer', preferModel: 'glm-5.3' })
  const needs = readNeeds({}, config)
  const rows = [
    lane('buddy', 'glm-5.3', { quality: 0.7 }),
    lane('trae', 'glm-5.3', { quality: 0.7, multiplier: 0.1, burn: 0.1 }),
    lane('trae', 'step-5-preview', { family: 'step-5-preview', intel: 44, quality: 0.98, burn: 0.05 }),
  ]
  const preferred = selectRoute({
    rows, health, config, anchor: null, needs, mode: 'prefer',
    preference: { model: 'glm-5.3', provider: '', fallback: 'auto' },
  })
  check('preference mode keeps the model even when another scores higher', preferred?.family, 'glm-5.3')
  checkThat('the preference is reported as used', preferred?.preference?.used === true)
  checkThat('the lane is chosen inside the preferred model', ['buddy', 'trae'].includes(preferred?.provider))

  const restricted = selectRoute({
    rows, health, config, anchor: null, needs, mode: 'prefer',
    preference: { model: 'glm-5.3', provider: 'buddy', fallback: 'auto' },
  })
  check('a channel-restricted preference stays on that channel', restricted?.provider, 'buddy')

  const allCooling = createHealth({ userDir: null, clock })
  // Model-scoped quota, so the sibling step-5-preview lane on `trae` stays up
  // and the fallback target is genuinely available.
  const perModelQuota = { code: 'QUOTA_EXCEEDED', message: '模型 "glm-5.3" 额度已用尽，请改用其它模型' }
  allCooling.markFailure('buddy', 'glm-5.3', perModelQuota)
  allCooling.markFailure('trae', 'glm-5.3', perModelQuota)
  const exhausted = selectRoute({
    rows, health: allCooling, config, anchor: null, needs, mode: 'prefer',
    preference: { model: 'glm-5.3', provider: '', fallback: 'auto' },
  })
  checkThat('all preferred lanes out produces an exhausted notice', exhausted?.exhausted !== undefined)
  check('the fallback mode still serves the step', exhausted?.family, 'step-5-preview')
  check('the fallback reports the auto mode', exhausted?.mode, 'auto')

  const off = selectRoute({
    rows, health: allCooling, config: { ...config, preferFallback: 'off' }, anchor: null, needs, mode: 'prefer',
    modeFallback: 'off',
    preference: { model: 'glm-5.3', provider: '', fallback: 'off' },
  })
  checkThat('fallback off blocks routing instead of silently using another model', off?.blocked === true)

  const visionRows = [
    lane('buddy', 'glm-5.3', { vision: false }),
    lane('trae', 'kimi-k3', { family: 'kimi-k3', intel: 44, quality: 0.86, vision: true }),
  ]
  const stepFallback = selectRoute({
    rows: visionRows, health, config, anchor: null,
    needs: readNeeds({ hasImage: true }, config),
    mode: 'prefer',
    preference: { model: 'glm-5.3', provider: '', fallback: 'auto' },
  })
  check('a request-specific constraint falls back for this step', stepFallback?.family, 'kimi-k3')
  checkThat('the preference is NOT suspended by a request-specific constraint',
    stepFallback?.exhausted === undefined && stepFallback?.stepFallback !== undefined)

  const missing = selectRoute({
    rows, health, config, anchor: null, needs, mode: 'prefer',
    preference: { model: 'not-a-real-model', provider: '', fallback: 'auto' },
  })
  checkThat('a preference no channel serves is exhausted', missing?.exhausted !== undefined)
}

console.log('\n[10] stickiness and escalation')
{
  const health = createHealth({ userDir: null, clock })
  const config = resolveConfig({}, {})
  const needs = readNeeds({ lastUserText: 'hello' }, config)
  const rows = [
    lane('buddy', 'glm-5.3', { quality: 0.83 }),
    lane('trae', 'step-5-preview', { family: 'step-5-preview', intel: 44, quality: 0.93, burn: 0.4 }),
  ]
  const normal = selectRoute({ rows, health, config, anchor: { provider: 'buddy', model: 'glm-5.3' }, needs, mode: 'auto' })
  const pickerChoice = selectRoute({
    rows, health, config,
    anchor: { provider: 'buddy', model: 'glm-5.3', userChoice: true },
    needs,
    mode: 'auto',
  })
  check('a marginally better model makes the router switch', normal?.family, 'step-5-preview')
  check('a fresh picker choice is respected on a marginal gain', pickerChoice?.family, 'glm-5.3')

  const escalateRows = [
    lane('buddy', 'glm-5.3', { intel: 45 }),
    lane('trae', 'weak-model', { family: 'weak-model', intel: 20, quality: 0.4 }),
    lane('raccoon', 'equal-model', { family: 'equal-model', intel: 45, quality: 0.85 }),
  ]
  const escalated = selectRoute({
    rows: escalateRows,
    health,
    config,
    anchor: { provider: 'buddy', model: 'glm-5.3' },
    needs: readNeeds({ priorFailures: 1 }, config),
    mode: 'auto',
    exclude: new Set(['buddy\u0000glm-5.3']),
  })
  checkThat('escalation prefers a model at least as intelligent as the failed one',
    escalated?.family !== 'weak-model', String(escalated?.family))
}

console.log('\n[11] reasoning effort')
{
  const row = makeRow({
    reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' },
  })
  check('quality asks for max', chooseEffort(row, undefined, { reasoningEffort: 'auto' }, 'quality'), 'max')
  check('balanced takes the provider default', chooseEffort(row, undefined, { reasoningEffort: 'auto' }, 'balanced'), 'high')
  check('economy takes the cheapest tier', chooseEffort(row, undefined, { reasoningEffort: 'auto' }, 'economy'), 'low')
  check('an explicit session effort is preserved where supported', chooseEffort(row, 'medium', { reasoningEffort: 'auto' }, 'quality'), 'medium')
  check('preserve drops an unsupported inherited effort', chooseEffort(row, 'turbo', { reasoningEffort: 'preserve' }, 'quality'), undefined)
  check('a concrete configured effort wins', chooseEffort(row, undefined, { reasoningEffort: 'medium' }, 'quality'), 'medium')
  check('a non-reasoning model has no effort', chooseEffort(makeRow(), undefined, { reasoningEffort: 'auto' }, 'quality'), undefined)
}

console.log('\n[12] report import')
{
  const markdown = fs.readFileSync(REPORT, 'utf8')
  const { dataset: imported, stats } = datasetFromReport(markdown, { baseCanonical: {} })
  // 2026-10-24: 报告增补第 13 条车道（FreeLLMAPI OVH 匿名），断言跟着报告走
  check('the report has 13 lanes', stats.lanes, 13)
  checkThat('the report resolves more than 70 families', stats.distinctFamilies > 70, String(stats.distinctFamilies))
  checkThat('the corrected deepseek score is imported', imported.families['deepseek-v4.1-flash'].intel === 39,
    String(imported.families['deepseek-v4.1-flash'].intel))
  const merged = createDataset({ userDir: tmp })
  merged.importDataset(imported, { reportPath: REPORT, ...stats })
  checkThat('an import overrides the shipped score', familyInfo(merged, 'deepseek-v4.1-flash').intel === 39)
  merged.clearImport()
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks)
if (failures > 0) process.exitCode = 1
