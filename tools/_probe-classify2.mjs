
import { classifyFailure, KIND } from '../src/health.js'

// 真实上游文案库（来自 live probe / channel pack 源码）
const real = {
  workbuddy_sg: 'workbuddy: 账号额度已用尽（上游 code 14018），模型 deepseek-v4.1-flash-sg 在 WorkBuddy (国际版) 下已无可用额度。换用其它账号、其它模型或其它通道；等待不会恢复：上游没有给出重置时刻。上游原话：{"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: https://www.codebuddy.ai/profile/usage "}}}',
  buddy_cn: 'buddy: 账号额度已用尽（上游 code 14018），模型 deepseek-v4.1-flash 在 CodeBuddy (腾讯) 下已无可用额度。换用其它账号、其它模型或其它通道；等待不会恢复：上游没有给出重置时刻。上游原话：{"error":{"data":{"code":14018,"msg":"额度已用尽，请访问以下链接，购买加量包以获取更多额度：https://www.codeb',
  cline_all: 'cline: 模型 deepseek/deepseek-v4.1-flash-1017 的所有账号均不可用 —— 额度已用尽（HTTP 402 Insufficient credits）—— 等待不会恢复，请到 app.cline.bot 充值，或改用其它 provider',
  lobsterai_exhausted: 'lobsterai: 模型 glm-5.3 所有账号均不可用',
  lobsterai_points: 'lobsterai: 积分不足',
  loomy_points: 'loomy: 积分余额不足，请获取积分后再试',
  trae_4008: 'trae: Your requests have exceeded the quota. (code=4008)',
  opencode_free: 'our-free-model: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go',
  raccoon_none: 'raccoon: sn-deepseek-v4-1-flash 额度已用尽',
  buddy_rate: 'buddy: 模型 glm-5.3 所有账号均受限，请稍后再试',
  buddy_safety: 'buddy: 请求被拦截，请重新发送 request illegal',
  zcode_perm: 'zcode: 账号在模型 "GLM-5.3" 上的额度已用尽，请改用其它模型。',
  codearts_img: 'codearts: 该模型不支持图片输入',
}

console.log('=== 真实文案分类 ===')
for (const [k, message] of Object.entries(real)) {
  const v = classifyFailure({ code: 'QUOTA_EXCEEDED', status: 429, message }, { strikes: 0 })
  const mins = Math.round(v.cooldownMs / 60000)
  console.log(k.padEnd(20) + ' ' + v.kind.padEnd(10) + ' scope=' + v.scope.padEnd(6) + ' ' + String(mins).padStart(5) + 'min')
}

console.log('\n=== 边界：不含 code 的纯文案 ===')
const bare = [
  ['workbuddy 原文 (无 code)', '{"error":{"data":{"code":14018,"msg":"Credits exhausted."}}}'],
  ['raccoon 无 code', '额度已用尽，请购买加量包'],
  ['402 无 body', ''],
]
for (const [k, message] of bare) {
  const v = classifyFailure({ code: '', status: 429, message }, { strikes: 0 })
  console.log(k.padEnd(24) + ' ' + v.kind.padEnd(10) + ' scope=' + v.scope)
}

console.log('\n=== 边界：400 状态 + 额度文案（上游常见组合）===')
const s400 = [
  ['400 + 额度已用尽', { code: '', status: 400, message: '额度已用尽，请购买加量包' }],
  ['400 + Credits exhausted', { code: '', status: 400, message: 'Credits exhausted. Please purchase add-on packs.' }],
  ['400 + request illegal', { code: '', status: 400, message: '请求被拦截，请重新发送 request illegal' }],
  ['400 + first message is not system prompt', { code: '', status: 400, message: '{"code":11128,"msg":"first message is not system prompt"}' }],
]
for (const [k, f] of s400) {
  const v = classifyFailure(f, { strikes: 0 })
  console.log(k.padEnd(42) + ' ' + v.kind.padEnd(10) + ' scope=' + v.scope + ' ' + Math.round(v.cooldownMs/60000) + 'min')
}
