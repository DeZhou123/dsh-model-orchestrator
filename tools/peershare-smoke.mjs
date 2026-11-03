/**
 * 渠道互借自检：出借方端点 + 借用方适配器，真起 HTTP 回环跑一遍。
 *
 * 判据（每条都是一个真实可失败的断言，不是打印）：
 *   1. 无 token / 错 token → 401；协议不符 → 400；
 *   2. 带 hop 头的请求 → 508（互借不能指向自己）；
 *   3. 不在出借清单里的车道 → 404；
 *   4. 正常流：出借方把 llm.stream 的 chunk 逐块推过去，借用方原样还原；
 *   5. 上游抛错 → 借用方拿到带 code 的失败，而不是「静默成功」；
 *   6. 借用方 listModels 拿到对侧清单，model id 带 / 也能精确还原。
 *   7. （2026-11-03 卡 peer-borrow-200-vs-error-classify）首块即失败不再以 HTTP 200 开局：
 *      抛错 / in-band error finish / aborted finish / 0 输出就结束，四种都要回真状态码，
 *      并且借用方的健康账本要记成 errors+1、status 不为 ok —— aborted 例外：用户按停止
 *      是「我们的请求的事」，账本必须记成 lane innocent（errors 不涨、车道仍判 ok）。
 *      出过货之后的失败仍走 200 NDJSON，而且只报一次（不双计）。
 *   8. （2026-11-03 卡 peer-borrow-zero-output-borrower-guard）上一条要**对端先升级**才算数；
 *      对端仍是旧形状（200 + 一帧 end、零 chunk）时，借用方自己必须把这一发判成失败：
 *      账本 errors+1、status 不为 ok；同一夹具下正常出货仍判 ok，aborted 仍走 lane innocent。
 *      这一条夹具就地仿出旧形状，不启动、也不重启任何实例。
 *
 * 用法：node tools/peershare-smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { PEERSHARE_PROTOCOL, lendableRows, startPeerShareServer, tokenMatches } from '../src/peershare.js'
import { createPeerAdapter } from '../src/peershare-adapter.js'

let passed = 0
function ok(label, detail) {
  passed += 1
  console.log('  ok    ' + label + (detail === undefined ? '' : ' = ' + JSON.stringify(detail)))
}

const TOKEN = 'test-token-0123456789'

const ROWS = [
  { provider: 'raccoon', model: 'sn-glm-5-3', modelName: 'GLM-5.3', family: 'glm-5.3', contextWindow: 131072, vision: true, denied: false, tags: [], quality: 0.8, multiplier: 1, freeLane: true },
  { provider: 'opencode', model: 'opencode/deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash', family: 'deepseek-v4.1-flash', contextWindow: 262144, vision: false, denied: false, tags: [], quality: 0.7, multiplier: 1, freeLane: true },
  { provider: 'codearts', model: 'sn-deepseek-v4-1-flash-1017', modelName: 'x', family: 'deepseek-v4.1-flash', denied: true, deniedReason: '用户屏蔽', tags: [] },
]

const chunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '你好' },
  { type: 'text-delta', index: 0, text: '，世界' },
  { type: 'usage', usage: { inputTokens: 11, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

let mode = 'ok'
let abortSeen = false
/** 出借侧真正收到的请求体里那几个字段，用来证明 min-token 确实过了界，而不是只在探针这一侧写着好看。 */
let seenRequest = null
/** 上游首块失败的三种真实形状 + 出过货之后才失败的两种，都由这里造。 */
const UPSTREAM_ERROR_FINISH = {
  type: 'finish',
  reason: { kind: 'error', failure: { message: 'workbuddy: transport error: fetch failed', code: 'TRANSPORT' } },
}
async function* fakeStream(request) {
  if (request.purpose !== 'peershare') throw new Error('出借方必须把 purpose 标成 peershare，否则会污染会话预算')
  if (request.sessionId !== undefined) throw new Error('出借方不得带 sessionId')
  seenRequest = {
    provider: request.provider,
    model: request.model,
    maxTokens: request.maxTokens,
    purpose: request.purpose,
    hasSessionId: request.sessionId !== undefined,
  }
  if (mode === 'fail') {
    const error = new Error('上游 429')
    error.code = 'RATE_LIMIT'
    error.status = 429
    throw error
  }
  if (mode === 'errorFinish') {
    // 线上实测形状：上游失败时 harness 不抛，而是把失败当成一个 finish 块送出来。
    yield UPSTREAM_ERROR_FINISH
    return
  }
  if (mode === 'abortFinish') {
    // 上游把「这一发被取消」当成普通 finish 块送出来，而且不带 failure 对象 ——
    // 中继合成的 code 只能取 kind，账本必须把它算成「我们的请求的事」而不是车道的错。
    yield { type: 'finish', reason: { kind: 'aborted' } }
    return
  }
  if (mode === 'empty') return // 一帧都没有就结束（旧协议下 = 200 + end，借用方记成成功）
  if (mode === 'hang') {
    // 上游一直不吐首块：中继不该为了「有个连接」就先把 200 发出去。
    await new Promise((resolve) => {
      if (request.signal?.aborted === true) {
        abortSeen = true
        resolve()
        return
      }
      request.signal?.addEventListener?.('abort', () => {
        abortSeen = true
        resolve()
      }, { once: true })
    })
    return
  }
  if (mode === 'lateError') {
    yield chunks[0]
    yield chunks[1]
    throw new Error('半路断')
  }
  if (mode === 'lateBandError') {
    // 出过货之后才失败：200 已经发出去了，撤不回来。
    yield chunks[0]
    yield chunks[1]
    yield UPSTREAM_ERROR_FINISH
    return
  }
  for (const chunk of chunks) yield chunk
}

console.log('[1] 出借清单');
const lendable = lendableRows(ROWS, { denyProviders: ['buddy'] })
assert.equal(lendable.length, 2, '被 denied 的行不能出借')
ok('被屏蔽的车道不进清单', lendable.length);
assert.equal(lendable[1].id, 'opencode/opencode/deepseek-v4.1-flash');
ok('model id 里的 / 原样保留', lendable[1].id);
assert.equal(lendableRows(ROWS, { allowProviders: ['raccoon'] }).length, 1);
ok('allowProviders 收窄清单');
assert.equal(tokenMatches('a', 'ab'), false);
assert.equal(tokenMatches(TOKEN, TOKEN), true);
ok('token 比较：长度不同即 false');

console.log('[2] 出借方端点');
const server = await startPeerShareServer({
  config: () => ({ enabled: true, host: '127.0.0.1', port: 0, token: TOKEN, label: 'A', version: 'test', allowProviders: [], denyProviders: ['buddy'] }),
  models: () => lendableRows(ROWS, { denyProviders: ['buddy'] }),
  stream: fakeStream,
  selfProvider: 'peer',
})
ok('已监听', server.host + ':' + server.port);
const baseUrl = 'http://127.0.0.1:' + server.port

function request(method, path, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const client = http.request(baseUrl + path, {
      method,
      headers: {
        ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...(token === undefined ? {} : { authorization: 'Bearer ' + token }),
        ...(headers ?? {}),
      },
    }, (response) => {
      const parts = []
      response.on('data', chunk => parts.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(parts).toString('utf8') }))
    })
    client.on('error', reject)
    if (payload !== null) client.write(payload)
    client.end()
  })
}

assert.equal((await request('GET', '/peershare/v1/models')).status, 401);
ok('无 token → 401');
assert.equal((await request('GET', '/peershare/v1/models', { token: 'wrong' })).status, 401);
ok('错 token → 401');
assert.equal((await request('GET', '/peershare/v1/models', { token: TOKEN, headers: { 'x-peershare-hop': '1' } })).status, 508);
ok('带 hop 头 → 508 回环守卫');
const hello = await request('GET', '/peershare/v1/hello', { token: TOKEN })
assert.equal(JSON.parse(hello.text).protocol, PEERSHARE_PROTOCOL);
ok('hello 报协议与可借数量', JSON.parse(hello.text).models);
const list = JSON.parse((await request('GET', '/peershare/v1/models', { token: TOKEN })).text)
assert.equal(list.count, 2);
ok('models 返回 2 条可借车道');
assert.equal((await request('POST', '/peershare/v1/stream', { token: TOKEN, body: { protocol: 'nope', provider: 'raccoon', model: 'sn-glm-5-3' } })).status, 400);
ok('协议不符 → 400');
assert.equal((await request('POST', '/peershare/v1/stream', { token: TOKEN, body: { protocol: PEERSHARE_PROTOCOL, provider: 'buddy', model: 'x' } })).status, 404);
ok('不在清单里的车道 → 404');
assert.equal((await request('POST', '/peershare/v1/stream', { token: TOKEN, body: { protocol: PEERSHARE_PROTOCOL, provider: 'peer', model: 'x' } })).status, 508);
ok('借用车道自身 → 508');

console.log('[3] 借用方适配器');
const borrower = createPeerAdapter({
  provider: 'peer',
  config: () => ({ peerUrl: baseUrl, peerToken: TOKEN, label: 'A', timeoutMs: 5000 }),
})
const listed = await borrower.adapter.listModels('peer')
assert.equal(listed.length, 2);
assert.deepEqual(listed.map(row => row.id), lendable.map(row => row.id));
ok('listModels 与对侧清单一致', listed.map(row => row.id));
const info = await borrower.adapter.resolveModel('peer', 'opencode/opencode/deepseek-v4.1-flash')
assert.equal(info.context.contextWindow, 262144);
assert.deepEqual(info.inputModalities, ['text']);
ok('resolveModel 还原上下文窗口，且不声明 image');

const collected = []
for await (const chunk of borrower.adapter.stream({ model: 'raccoon/sn-glm-5-3', messages: [] })) collected.push(chunk)
assert.deepEqual(collected, chunks);
ok('流式 chunk 逐块无损还原', collected.length);

mode = 'fail'
let caught = null
try {
  for await (const chunk of borrower.adapter.stream({ model: 'raccoon/sn-glm-5-3', messages: [] })) void chunk
} catch (error) {
  caught = error
}
assert.notEqual(caught, null, '上游失败必须抛出来');
assert.equal(caught.code, 'RATE_LIMIT');
assert.equal(caught.status, 429);
ok('上游失败带 code/status 抛出', { code: caught.code, status: caught.status });
mode = 'ok'

let imageCaught = null
try {
  for await (const chunk of borrower.adapter.stream({ model: 'raccoon/sn-glm-5-3', messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] })) void chunk
} catch (error) {
  imageCaught = error
}
assert.equal(imageCaught?.code, 'UNSUPPORTED_CONTENT');
ok('图片块被明确拒绝，而不是静默降级');

console.log('[4] 出借方关闭时的行为');
await server.close();
const dead = await borrower.adapter.listModels('peer')
assert.equal(dead.length, 2, '连不上对侧时保留上一次清单，便于面板显示而不是清空');
assert.notEqual(borrower.modelsError, '');
ok('对侧不可达 → 保留上次清单并记错误', borrower.modelsError.slice(0, 40));

console.log('[5] 借来的车道不再借出去');
// 2026-10-29 实测事故：两端都开 both 时，B 把自己从 A 借来的 1201 条车道又挂进了自己的
// 出借清单 —— A 再从 B 借，就是「A→B→A」的环路。判据是清单里不得出现借用车道名。
const withBorrowed = [
  ...ROWS,
  { provider: 'peer', model: 'raccoon/sn-deepseek-v4-1-flash-1017', modelName: '借来的', tags: [] },
  { provider: 'peer', model: 'buddy/hy3', modelName: '借来的2', tags: [] },
]
const noSelf = lendableRows(withBorrowed, { denyProviders: ['buddy'], selfProvider: 'peer' })
assert.equal(noSelf.filter(row => row.provider === 'peer').length, 0, '借用车道不得出现在自己的出借清单里');
ok('selfProvider 把借来的车道挡在清单外', noSelf.length);
const flagged = lendableRows(
  [{ provider: 'other', model: 'm', modelName: 'm', borrowed: true, tags: [] }, ...ROWS],
  { denyProviders: ['buddy'] },
)
assert.equal(flagged.filter(row => row.borrowed === true).length, 0, '目录层打了 borrowed 标记的行同样要挡掉');
ok('borrowed 标记的行不进清单', flagged.length);
// 证伪：不传 selfProvider 时，那条借来的车道**确实**会进清单（否则上面两条断言是空的）
const leaky = lendableRows(withBorrowed, { denyProviders: ['buddy'] })
assert.equal(leaky.filter(row => row.provider === 'peer').length, 2, '不设守卫时借来的车道会漏进出借清单');
ok('对照：不设 selfProvider 时确实会漏（2 条）', leaky.length);

console.log('[6] 端点默认监听地址');
// 2026-10-29 改：默认只绑回环。判据不是「配置里写了 127.0.0.1」，而是「不显式配 host 时
// 端点真的没出现在局域网上」——绑 0.0.0.0 时 bind 出来的地址是 0.0.0.0，这是可失败的。
const { DEFAULT_CONFIG } = await import('../src/policy-defaults.js')
assert.equal(DEFAULT_CONFIG.peerShare.host, '127.0.0.1', '默认出借端点必须只绑回环');
ok('默认配置 host 是回环', DEFAULT_CONFIG.peerShare.host);
const bare = await startPeerShareServer({
  config: () => ({ enabled: true, port: 0, token: TOKEN }),
  models: () => lendableRows(ROWS, { denyProviders: ['buddy'] }),
  stream: fakeStream,
  selfProvider: 'peer',
})
assert.equal(bare.host, '127.0.0.1', '配置里不给 host 时也必须落到回环，不能回退成 0.0.0.0');
ok('host 缺省时端点仍绑回环', bare.host);
await bare.close();

console.log('[7] 首块即失败不再以 200 开局，账本记 error');
// 卡 peer-borrow-200-vs-error-classify（2026-11-03）：旧写法在还不知道上游能不能出货时就
// writeHead(200)，于是「上游一上来就失败」和「正常出货」在线上是同一个状态码。实测基线
// （_supervisor/_tmp/probe-peer-200-vs-error.mjs）里最糟的一条是「0 帧输出就结束」—— 借用方
// 账本记成 calls+1 / errors=0 / status=ok，一条死车道在健康账本里看着完全健康。
const { createHealth } = await import('../src/health.js')
const { createObserver } = await import('../src/observe.js')
const relay = await startPeerShareServer({
  config: () => ({ enabled: true, host: '127.0.0.1', port: 0, token: TOKEN, label: 'A', version: 'test' }),
  models: () => lendableRows(ROWS, { denyProviders: ['buddy'] }),
  stream: fakeStream,
  selfProvider: 'peer',
})
const relayBase = 'http://127.0.0.1:' + relay.port
const RELAY_MODEL = 'raccoon/sn-glm-5-3'

/** 只看线上传输：原始 HTTP 状态 + 原始 NDJSON 帧（不借 adapter 的眼睛）。 */
function rawStream(remoteProvider, remoteModel, base = relayBase) {
  const payload = JSON.stringify({
    protocol: PEERSHARE_PROTOCOL,
    provider: remoteProvider,
    model: remoteModel,
    options: { messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], maxTokens: 1 },
  })
  return new Promise((resolve, reject) => {
    const client = http.request(base + '/peershare/v1/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        authorization: 'Bearer ' + TOKEN,
      },
    }, (response) => {
      const parts = []
      response.on('data', chunk => parts.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8').trim()
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        resolve({
          status: response.statusCode ?? 0,
          frames: (response.statusCode === 200 ? text.split('\n').filter(Boolean) : [])
            .map(line => { try { return JSON.parse(line) } catch { return null } })
            .filter(Boolean),
          json,
        })
      })
    })
    client.on('error', reject)
    client.end(payload)
  })
}

/** 借用方视角：adapter + observer + 一本一次性的账本，返回 peer/* 条目。 */
async function borrowOnce(name, base = relayBase) {
  mode = name
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-peer-ledger-'))
  const health = createHealth({ userDir: dir })
  const observer = createObserver({ health })
  const peer = createPeerAdapter({ provider: 'peer', config: () => ({ peerUrl: base, peerToken: TOKEN, timeoutMs: 5000 }) })
  await peer.refreshModels()
  let caught = null
  const seen = []
  try {
    const iterable = observer.observe(
      { provider: 'peer', model: RELAY_MODEL, sessionId: 'smoke-session' },
      peer.adapter.stream({ model: RELAY_MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], maxTokens: 1 }),
    )
    for await (const chunk of iterable) seen.push(chunk)
  } catch (error) {
    caught = error
  }
  health.persist()
  const file = path.join(dir, 'health.json')
  const ledger = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { models: [], lanes: [] }
  fs.rmSync(dir, { recursive: true, force: true })
  const entry = ledger.models.find(row => row.provider === 'peer' && row.model === RELAY_MODEL) ?? null
  return { caught, seen, entry }
}

mode = 'fail'
const wireThrow = await rawStream('raccoon', 'sn-glm-5-3')
assert.notEqual(wireThrow.status, 200, '上游首块抛错不能以 200 开局');
assert.equal(wireThrow.status, 429, '上游的 429 要原样抬成 HTTP 状态');
ok('首块抛错 → HTTP 429（不再 200）', wireThrow.json?.error?.code);

mode = 'errorFinish'
const wireBand = await rawStream('raccoon', 'sn-glm-5-3')
assert.notEqual(wireBand.status, 200, '上游首块 in-band error finish 不能以 200 开局');
assert.equal(wireBand.json?.error?.code, 'TRANSPORT', '上游的失败码不能被中继吞成 PEERSHARE_*');
ok('首块 in-band error → HTTP ' + wireBand.status + ' + 原码', wireBand.json?.error?.code);

mode = 'abortFinish'
const wireAbort = await rawStream('raccoon', 'sn-glm-5-3')
assert.notEqual(wireAbort.status, 200, '上游首块是 aborted 也不能以 200 开局（它同样没吐任何输出）');
assert.equal(wireAbort.json?.error?.code, 'aborted', '上游没给 failure 对象时中继要拿 kind 当 code，不能自造 PEERSHARE_*');
ok('首块 aborted → HTTP ' + wireAbort.status + ' + code=aborted', wireAbort.json?.error?.code);

mode = 'empty'
const wireEmpty = await rawStream('raccoon', 'sn-glm-5-3')
assert.notEqual(wireEmpty.status, 200, '0 输出就结束不能以 200 开局');
assert.equal(wireEmpty.json?.error?.code, 'UPSTREAM_EMPTY');
ok('0 输出就结束 → HTTP 502 UPSTREAM_EMPTY', wireEmpty.status);

// 出过货之后的失败：200 收不回来，仍走 NDJSON，但 end 帧要自带 outcome，且失败只报一次。
mode = 'lateError'
const wireLate = await rawStream('raccoon', 'sn-glm-5-3')
assert.equal(wireLate.status, 200, '已经出货，200 不能撤销');
assert.equal(wireLate.frames.filter(frame => frame.type === 'error').length, 1);
assert.equal(wireLate.frames.at(-1).outcome, 'error', 'end 帧要自带可判定的失败标记');
ok('出过货后抛错 → 200 + 一帧 error + end.outcome=error');

mode = 'lateBandError'
const wireLateBand = await rawStream('raccoon', 'sn-glm-5-3')
assert.equal(wireLateBand.status, 200);
assert.equal(wireLateBand.frames.filter(frame => frame.type === 'error').length, 0, 'in-band 失败已经转过了，再补一帧 error 会被借用方双计');
assert.equal(wireLateBand.frames.at(-1).outcome, 'error');
assert.equal(wireLateBand.frames.at(-1).error.code, 'TRANSPORT');
ok('出过货后 in-band error → 只标 end.outcome，不重复上报');

mode = 'ok'
const wireOk = await rawStream('raccoon', 'sn-glm-5-3')
assert.equal(wireOk.status, 200);
assert.deepEqual(wireOk.frames.filter(frame => frame.type === 'chunk').map(frame => frame.chunk), chunks, '攒头不能改变 chunk 的顺序与内容');
assert.equal(wireOk.frames.at(-1).outcome, 'ok');
ok('正常回包仍是 200 NDJSON 且 chunk 逐块无损', wireOk.frames.length);
assert.equal(seenRequest?.maxTokens, 1, '调用方的 max_tokens=1 必须原样过界到出借侧 llm.stream，否则这条判据是空炮');
assert.equal(seenRequest?.hasSessionId, false);
assert.equal(seenRequest?.purpose, 'peershare');
ok('max_tokens=1 确实带着过界（出借侧收到的 request）', seenRequest);

// 上游一直不吐首块：200 一个字节都不该发出去；对侧断开算「取消」，不算「故障」。
const abortLogs = []
const relayHang = await startPeerShareServer({
  config: () => ({ enabled: true, host: '127.0.0.1', port: 0, token: TOKEN, label: 'A', version: 'test' }),
  models: () => lendableRows(ROWS, { denyProviders: ['buddy'] }),
  stream: fakeStream,
  selfProvider: 'peer',
  log: (message) => abortLogs.push(message),
})
mode = 'hang'
abortSeen = false
const hangOutcome = await new Promise((resolve) => {
  const payload = JSON.stringify({
    protocol: PEERSHARE_PROTOCOL, provider: 'raccoon', model: 'sn-glm-5-3',
    options: { messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], maxTokens: 1 },
  })
  const client = http.request('http://127.0.0.1:' + relayHang.port + '/peershare/v1/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer ' + TOKEN },
  }, (response) => {
    response.resume()
    resolve('headers:' + response.statusCode)
  })
  client.on('error', () => resolve('destroyed'))
  client.on('close', () => resolve('closed'))
  client.end(payload)
  setTimeout(() => client.destroy(), 200)
})
assert.notEqual(String(hangOutcome).slice(0, 8), 'headers:', '上游没吐首块时不能先把响应头发出去：' + hangOutcome);
await new Promise(resolve => setTimeout(resolve, 300))
assert.equal(abortSeen, true, '对侧断开要把 abort 传给出借侧的 llm.stream，别让它空转');
assert.equal(abortLogs.filter(line => line.includes('首块失败')).length, 0, '对侧取消不该被记成「上游首块失败」');
ok('上游没出货 → 头都不发；断开时 abort 送达出借侧且不写故障日志', hangOutcome);
await relayHang.close();
mode = 'ok'

// 上游首块就挂死（既不吐帧也不断开）：头不再在 t=0 发出，借用方 adapter 的 120s 空闲看门狗
// （收到响应头才开始计时）就管不到首帧之前了。中继必须自己把「首帧之前的等待」封顶，否则
// 这条从「120s 记一次失败」退化成「挂到调用方自己的超时」。用 200ms 窗口把这条时间线钉住。
const silentRelay = await startPeerShareServer({
  config: () => ({ enabled: true, host: '127.0.0.1', port: 0, token: TOKEN, label: 'A', version: 'test' }),
  models: () => lendableRows(ROWS, { denyProviders: ['buddy'] }),
  stream: fakeStream,
  selfProvider: 'peer',
  headTimeoutMs: 200,
})
const silentBase = 'http://127.0.0.1:' + silentRelay.port
mode = 'hang'
const silentStarted = Date.now()
const silentWire = await rawStream('raccoon', 'sn-glm-5-3', silentBase)
const silentMs = Date.now() - silentStarted
assert.equal(silentWire.status, 504, '上游首帧就一直不出现时不能永远不发头、也不能回 200');
assert.equal(silentWire.json?.error?.code, 'UPSTREAM_SILENT');
assert.ok(silentMs < 5000, '必须在攒头上限附近返回，而不是等调用方超时：' + silentMs + 'ms');
ok('首帧挂死 → ' + silentMs + 'ms 后 HTTP 504 UPSTREAM_SILENT', silentWire.json?.error?.code);
const silentRun = await borrowOnce('hang', silentBase)
assert.notEqual(silentRun.caught, null, '挂死的上游必须让调用方拿到显式失败');
assert.equal(silentRun.caught.code, 'UPSTREAM_SILENT');
assert.ok(silentRun.entry !== null);
assert.equal(silentRun.entry.counters.errors, 1, '挂死要记成 error，不能是「成功但 0 输出」');
assert.notEqual(silentRun.entry.status, 'ok');
ok('账本 首帧挂死 → errors+1 / status=' + silentRun.entry.status, silentRun.caught.code);
await silentRelay.close()
mode = 'ok'

for (const name of ['fail', 'errorFinish', 'empty']) {
  const { caught, entry } = await borrowOnce(name)
  assert.notEqual(caught, null, name + '：调用方必须拿到显式失败');
  assert.ok(entry !== null, name + '：peer/* 必须在账本里留下条目');
  assert.equal(entry.counters.errors, 1, name + '：errors 要 +1');
  assert.notEqual(entry.status, 'ok', name + '：status 不能还是 ok');
  ok('账本 ' + name + ' → errors+1 / status=' + entry.status, caught.code);
}
// 反面对照：把「首块失败」抬成 HTTP 错误之后，**取消**不能顺带被算成车道的错。
// health.js 的 REQUEST_CODES 里有 ABORTED（用户按停止 = lane innocent），
// 这条断言钉住「修可观测性不把 peer/* 车道自己打死」的边界。
const abortRun = await borrowOnce('abortFinish')
assert.notEqual(abortRun.caught, null, '取消也要让调用方拿到显式失败，而不是「成功但 0 输出」');
assert.equal(String(abortRun.caught.code).toUpperCase(), 'ABORTED', '取消的 code 要能被识别成 aborted');
if (abortRun.entry !== null) {
  assert.equal(abortRun.entry.counters.errors, 0, '用户按停止不是车道的错：账本不能记 errors+1');
  assert.equal(abortRun.entry.status, 'ok', '取消不能把车道判成非 ok');
}
ok('账本 aborted（取消）→ 调用方拿到显式失败但不惩罚车道 / status='
  + (abortRun.entry === null ? '(无条目)' : abortRun.entry.status), abortRun.caught.code);

const okRun = await borrowOnce('ok')
assert.equal(okRun.caught, null, '正常回包不能被记成失败');
assert.deepEqual(okRun.seen, chunks, '借用方拿到的 chunk 与上游一致');
assert.equal(okRun.entry.counters.calls, 1);
assert.equal(okRun.entry.counters.errors, 0);
assert.equal(okRun.entry.status, 'ok');
ok('同一假上游正常回包时该车道仍判 ok', okRun.entry.status);
const emptyRun = await borrowOnce('empty')
assert.ok(!(emptyRun.entry.counters.calls === 1 && emptyRun.entry.counters.errors === 0), '0 输出绝对不能再记成「成功但 0 输出」');
ok('反证：0 输出不再产生 calls+1/errors=0 的成功记录', emptyRun.entry.counters);
await relay.close();
mode = 'ok'

console.log('[8] 对端还是旧形状（200 + 一帧 end、零 chunk）时，借用方自己判失败');
// 卡 peer-borrow-zero-output-borrower-guard（2026-11-03）。
//
// 上一张卡把「首块即失败」抬进了 HTTP 状态，但那条**要出借端先升级**才生效：本机 A（18326）
// 是按旧代码起的进程，对每一次借道调用仍在 t=0 就回 200。所以「上游 0 帧」在线上和「正常回包」
// 长得一模一样 —— 都是 200，只是中间一帧 chunk 都没有。这一段就仿出那个旧形状：一个只回
// 200 + 一帧 end 的假出借方，**就地起一个 HTTP 端点**，不启动、不重启任何实例，也不看对端版本。
//
// 判据是借用方的账本（不是线上状态码）：这一发必须 errors+1、status 不为 ok；同一夹具下正常
// 出货仍判 ok；aborted 仍走 lane innocent —— 反面一起钉住，否则「修好了」可能只是把取消也算成故障。
let oldShapeMode = 'zero'
const oldShape = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/peershare/v1/models') {
    const body = JSON.stringify({
      protocol: PEERSHARE_PROTOCOL,
      count: 1,
      models: [{ provider: 'raccoon', model: 'sn-glm-5-3', id: RELAY_MODEL, name: 'GLM-5.3', modelName: 'GLM-5.3' }],
    })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
    return
  }
  if (req.method === 'POST' && req.url === '/peershare/v1/stream') {
    for await (const _part of req) void _part // 请求体读干净，别让连接半开
    // 旧代码的形状：头在 t=0 就发出去了 —— 上游能不能出货它这时候并不知道。
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    const frame = (value) => res.write(JSON.stringify(value) + '\n')
    if (oldShapeMode === 'ok') {
      for (const chunk of chunks) frame({ type: 'chunk', chunk })
    } else if (oldShapeMode === 'aborted') {
      frame({ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'aborted' } } })
    }
    // 'zero'：一帧 chunk 都不发，直接收尾 —— 这就是「死车道」在旧协议上的原样。
    frame({ type: 'end' }) // 旧形状的 end 帧没有 outcome 字段
    res.end()
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((resolve, reject) => {
  oldShape.once('error', reject)
  oldShape.listen(0, '127.0.0.1', resolve)
})
const oldBase = 'http://127.0.0.1:' + oldShape.address().port

oldShapeMode = 'zero'
const oldZero = await borrowOnce('ok', oldBase) // 第二参数换端点；mode 只喂给上一节的假上游
assert.equal(oldZero.seen.length, 0, '夹具必须真的是零 chunk，否则下面两条断言是空炮');
assert.equal(oldZero.caught, null, '旧形状线上是 200 + end：调用方拿不到异常，这正是它危险的地方');
assert.ok(oldZero.entry !== null, '零输出的一发必须在账本里留下 peer/* 条目');
assert.equal(oldZero.entry.counters.errors, 1, '旧形状 + 零输出：errors 要 +1，不能再是 0');
assert.notEqual(oldZero.entry.status, 'ok', '零输出跑完不能记成 status=ok（死车道在账本里必须看得见）');
ok('账本 旧形状零输出 → errors+1 / status=' + oldZero.entry.status, oldZero.entry.counters);

oldShapeMode = 'ok'
const oldOk = await borrowOnce('ok', oldBase)
assert.equal(oldOk.caught, null);
assert.deepEqual(oldOk.seen, chunks, '同一夹具正常出货时 chunk 仍要逐块无损');
assert.equal(oldOk.entry.counters.calls, 1);
assert.equal(oldOk.entry.counters.errors, 0);
assert.equal(oldOk.entry.status, 'ok', '同一夹具正常出货必须仍判 ok —— 否则这条兜底会把健康车道一起打死');
ok('同一夹具正常出货仍判 ok / errors=0', oldOk.entry.counters);

oldShapeMode = 'aborted'
// 旧形状的 aborted 是**转发过来的 finish 块**，不是抛错：线上仍是 200，adapter 原样吐出来。
// 这一发在借用方是 agent 环路的调用（带 sessionId、无 purpose），失败由 agent/request-error 记，
// observe.js 只上报不记账；而零输出兜底必须**排在 error/aborted 分支之后**，不能替它记账。
const oldAbort = await borrowOnce('ok', oldBase)
assert.equal(oldAbort.caught, null, '旧形状的 aborted 走 200 NDJSON：调用方拿到的是 finish 块，不是异常');
assert.deepEqual(oldAbort.seen.at(-1), { type: 'finish', reason: { kind: 'aborted' } }, '取消要以 finish(kind=aborted) 原样到达借用方');
const abortErrors = oldAbort.entry === null ? 0 : oldAbort.entry.counters.errors
assert.equal(abortErrors, 0, '取消是「我们的请求的事」：零输出兜底不能把它也记成车道的错');
assert.ok(oldAbort.entry === null || oldAbort.entry.status === 'ok', '取消不能把车道判成非 ok');
ok('旧形状 aborted → lane innocent（errors=' + abortErrors + ' / status='
  + (oldAbort.entry === null ? '(无条目，只有一次调用被取消)' : oldAbort.entry.status) + '）', oldAbort.seen.at(-1));

await new Promise(resolve => oldShape.close(resolve))
oldShapeMode = 'ok'
mode = 'ok'

console.log('');
console.log('PASS — ' + passed + '/' + passed);
