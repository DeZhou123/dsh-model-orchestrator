
import { classifyFailure } from '../src/health.js'

const wb6004 = '{"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-10-25 12:49:06 UTC+8, alternatively, you can switch to the other models to continue using it.","requestId":"9274300d"}'

const cases = [
  ['6004 上游原文 + QUOTA_EXCEEDED', { code: 'QUOTA_EXCEEDED', status: 429, message: wb6004 }],
  ['6004 上游原文，无 code', { code: '', status: 429, message: wb6004 }],
  ['6004 原文无状态码无 code', { code: '', message: wb6004 }],
  ['pack 兜底文案（中文均受限）', { code: 'QUOTA_EXCEEDED', status: 429, message: 'workbuddy: 模型 deepseek-v4.1-flash 所有账号均受限，请稍后再试' }],
  ['14018 sg（保持 quota/model）', { code: 'QUOTA_EXCEEDED', status: 429, message: 'workbuddy: 账号额度已用尽（上游 code 14018），模型 deepseek-v4.1-flash-sg 在 WorkBuddy (国际版) 下已无可用额度。换用其它账号、其它模型或其它通道；等待不会恢复。' }],
  ['真·整号 402（必须仍是 lane）', { code: 'QUOTA_EXCEEDED', status: 402, message: 'cline: 额度已用尽（HTTP 402 Insufficient credits）' }],
  ['真·地区封锁', { code: 'REGION_BLOCKED', status: 403, message: 'not available in your country' }],
]

for (const [k, f] of cases) {
  const v = classifyFailure(f, { strikes: 0 })
  console.log(k.padEnd(34) + ' ' + v.kind.padEnd(10) + ' scope=' + v.scope.padEnd(6) + ' ' + String(Math.round(v.cooldownMs/60000)).padStart(5) + 'min retry=' + v.retryable)
}
