
import { classifyFailure } from '../src/health.js'

const cases = [
  ['opencode 日额度(真实 code)', { code: 'UPSTREAM_ERROR', message: 'our-free-model: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go' }],
  ['opencode 日额度(原话)', { code: 'UPSTREAM_ERROR', message: 'OpenCode 免费层的**当日额度**用完了（上游原文：Free usage limit reached）' }],
  ['5xx 正文含 region', { code: 'SERVER', status: 502, message: 'bad gateway (region ap-others)' }],
  ['5xx 正文含 credit', { code: 'SERVER', status: 500, message: 'internal server error (credit ledger)' }],
  ['超时正文含 region', { code: 'TIMEOUT', message: 'connect timeout to region endpoint' }],
  ['传输错含 region', { code: 'TRANSPORT', message: 'fetch failed: region unreachable' }],
  ['buddy 模型饱和 14003', { code: 'RATE_LIMIT', status: 429, message: '{"code":14003,"msg":"too many requests","displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"}}' }],
  ['workbuddy 11128', { code: 'INVALID_REQUEST', status: 400, message: '{"code":11128,"msg":"first message is not system prompt"}' }],
]
for (const [k, f] of cases) {
  const v = classifyFailure(f, { strikes: 0 })
  console.log(k.padEnd(26) + ' ' + v.kind.padEnd(11) + ' scope=' + v.scope.padEnd(6) + ' ' + String(Math.round(v.cooldownMs/60000)).padStart(5) + 'min retry=' + v.retryable)
}
