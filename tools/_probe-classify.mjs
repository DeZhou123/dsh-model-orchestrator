
import { classifyFailure } from '../src/health.js'

const cases = [
  ['WorkBuddy 14018 (已修)', { code: 'QUOTA_EXCEEDED', status: 429, message: 'workbuddy: 账号额度已用尽（上游 code 14018），模型 deepseek-v4.1-flash-sg 在 WorkBuddy (国际版) 下已无可用额度。换用其它账号、其它模型或其它通道；等待不会恢复：上游没有给出重置时刻。' }],
  ['opencode 免费额度用尽', { code: 'QUOTA_EXCEEDED', status: 429, message: 'our-free-model: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go' }],
  ['opencode 原文无 code', { code: '', status: 429, message: 'Free usage limit reached. Subscribe to OpenCode Go to keep going' }],
  ['cline 402', { code: 'QUOTA_EXCEEDED', status: 402, message: 'cline: 模型 deepseek/deepseek-v4.1-flash-1017 的所有账号均不可用 —— 额度已用尽（HTTP 402 Insufficient credits）—— 等待不会恢复，请到 app.cline.bot 充值，或改用其它 provider' }],
  ['trae 4008', { code: 'QUOTA_EXCEEDED', status: 429, message: 'trae: Your requests have exceeded the quota. (code=4008)' }],
  ['loomy 积分不足', { code: 'QUOTA_EXCEEDED', status: 429, message: 'loomy: 积分余额不足，请获取积分后再试' }],
  ['zcode per-model (旧断言)', { code: 'QUOTA_EXCEEDED', message: 'zcode: 账号在模型 "GLM-5.3" 上的额度已用尽，请改用其它模型。' }],
  ['buddy 限流', { code: 'QUOTA_EXCEEDED', message: 'buddy: 模型 glm-5.3 所有账号均受限，请稍后再试' }],
  ['buddy 安全拦截 11140', { code: 'INVALID_REQUEST', status: 400, message: 'workbuddy: 请求被拦截，请重新发送 request illegal' }],
  ['workbuddy 11128 首条非 system', { code: 'INVALID_REQUEST', status: 400, message: '{"code":11128,"msg":"first message is not system prompt"}' }],
  ['401 凭据失效', { code: 'AUTH', status: 401, message: 'invalid credential' }],
  ['404 模型不存在', { code: 'MODEL_NOT_FOUND', status: 404, message: 'model not found' }],
  ['超时', { code: 'TIMEOUT', message: 'request timed out' }],
  ['上游 502', { code: 'SERVER', status: 502, message: 'bad gateway' }],
  ['地区封锁原文', { code: 'REGION_BLOCKED', status: 403, message: 'not available in your country' }],
  ['额度文案里提到 region 字样', { code: 'QUOTA_EXCEEDED', status: 429, message: 'raccoon: 账号额度已用尽（region ap-others），请改用其它模型' }],
  ['额度文案里提到 sg 区域', { code: 'QUOTA_EXCEEDED', status: 429, message: 'workbuddy: 模型 deepseek-v4.1-flash-sg（sg region）额度已用尽，请改用其它模型' }],
  ['纯文本 no credits', { status: 429, message: 'You have no credits left' }],
  ['纯文本 daily limit', { status: 429, message: 'Daily limit reached, try again tomorrow' }],
  ['纯文本 usage limit', { status: 429, message: 'usage limit exceeded' }],
  ['错误码里含 5xx 数字', { code: 'QUOTA_EXCEEDED', status: 429, message: 'upstream said 15003 quota' }],
  ['EMPTY 响应', { code: 'EMPTY_RESPONSE', message: 'empty model response body' }],
]

for (const [label, failure] of cases) {
  const v = classifyFailure(failure, { strikes: 0 })
  const mins = Math.round(v.cooldownMs / 60000)
  console.log(label.padEnd(30) + ' kind=' + v.kind.padEnd(11) + ' scope=' + v.scope.padEnd(6) + ' cool=' + String(mins).padStart(4) + 'min retry=' + v.retryable)
}
