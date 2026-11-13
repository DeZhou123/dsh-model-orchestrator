
import { classifyFailure } from '../src/health.js'

const risky = [
  ['含 region 的超时文案', { code: 'TIMEOUT', message: 'upstream region timeout after 60s' }],
  ['含 region 的 5xx', { code: 'SERVER', status: 502, message: 'bad gateway in region ap-others' }],
  ['含 country 的额度', { code: 'QUOTA_EXCEEDED', status: 429, message: 'quota exhausted for country CN' }],
  ['含 地区 的限流', { code: 'RATE_LIMIT', status: 429, message: '该地区请求过多，请稍后再试' }],
  ['含 region 的传输错误', { code: 'TRANSPORT', message: 'fetch failed: region endpoint unreachable' }],
  ['含 credit 的 5xx', { code: 'SERVER', status: 500, message: 'internal server error (credit ledger)' }],
  ['含 登录 的 429', { code: 'RATE_LIMIT', status: 429, message: 'too many login attempts' }],
  ['含 凭据 的超时', { code: 'TIMEOUT', message: '凭据校验超时' }],
  ['含 balance 的 5xx', { code: 'SERVER', status: 503, message: 'balance service unavailable' }],
  ['纯 5xx 数字在 requestId', { code: 'SERVER', status: 500, message: 'requestId 5a3b2c1d failed' }],
  ['含 502 的额度', { code: 'QUOTA_EXCEEDED', status: 429, message: 'quota hit after 502 retries' }],
  ['含 额度 的 400 参数错', { code: 'INVALID_REQUEST', status: 400, message: '额度参数非法' }],
]
for (const [k, f] of risky) {
  const v = classifyFailure(f, { strikes: 0 })
  console.log(k.padEnd(28) + ' ' + v.kind.padEnd(11) + ' scope=' + v.scope.padEnd(6) + ' ' + String(Math.round(v.cooldownMs/60000)).padStart(5) + 'min')
}
