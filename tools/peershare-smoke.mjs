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
 *
 * 用法：node tools/peershare-smoke.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'

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
async function* fakeStream(request) {
  if (request.purpose !== 'peershare') throw new Error('出借方必须把 purpose 标成 peershare，否则会污染会话预算')
  if (request.sessionId !== undefined) throw new Error('出借方不得带 sessionId')
  if (mode === 'fail') {
    const error = new Error('上游 429')
    error.code = 'RATE_LIMIT'
    error.status = 429
    throw error
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

console.log('[5] 端点默认监听地址');
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

console.log('');
console.log('PASS — ' + passed + '/' + passed);
