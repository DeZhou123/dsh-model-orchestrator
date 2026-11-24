# CHANGELOG — dsh-model-orchestrator

## 2.17.0 — 2026-11-24

### 新增：上游余额门禁（credits gate）

调度器过去只会**事后**学：一条车道失败过一次，账本才记一笔。而「积分已经 0」
「订阅没开」这两件事在**第一次调用之前**就是已知的 —— 渠道包自己带着余额查询
（credits.balances / cline.quota），只是没接到调度器上。代价可以量化：

- **空转**：cline 39 天 386 次请求、0 交付（`402 Insufficient credits` /
  `403 not subscribed`），每次都只吃一次瞬时冷却，下一轮再撞同一堵墙。
- **误杀**：lobsterai 2026-11-24 实测上游还有 **1259.26 积分**、`accountAccess.state=ACTIVE`、
  一次 `deepseek-v4.1-flash` completion 直接 200，而账本上它已经 30 天零交付。

落点：

- `src/channels.js`：`refresh()` 读 `~/.dsh/model-orchestrator/credits.json`，
  `signal()` 返回新增的 `credit` 字段，并在 `exhausted` / `allBlocked` 时把
  `available` 判成 `false`；新增 `creditOf(provider)`。
- `src/catalog.js`：余额归零的车道在**排序阶段**就被否决，理由写成人话
  （「上游余额已归零（credits.json 实测 total=0，无需重试）」），而不是等它失败。
- 口径纪律：**查不到 ≠ 余额是 0**。`exhausted` 只有在「至少一个账号查得到余额，
  且所有查得到的账号都是 0」时才成立，所以「凭据读不出来」永远不会被当成「没钱」。

取数侧（本机脚本，不属于插件）：`_supervisor/credits-snapshot.mjs`，
覆盖 lobsterai / buddy / workbuddy / cline / free-pi，输出
`{provider: {total, known, unknown, exhausted, allBlocked, nextExpiry}}`。

### 修复：渠道签名门禁被当成瞬时故障（buddy / workbuddy）

`Illegal API invocation from an unapproved channel`（403）和
`账号存在异常行为，已被限制使用`，此前文案不命中任何规则，掉进 transient 默认，
**每 30 秒重试一次**。实测后果：buddy 10-21 首次 10 次 → 11-03 单日 35 次 →
一路重试到 11-24 共 475 次；workbuddy 399 次。签名门禁不会因为 30 秒而解除，
反复重试只会把风控喂得更大。

现在 `classifyFailure` 在 **SAFETY 之前**先认这一类（`CHANNEL_SIGNATURE_TEXT`），
归入 `KIND.PLAN`、**车道级**、停车 **6 小时**。为什么是 6 小时不是 24：实测这类
门禁会自己解除（2026-11-24 复测 buddy 两个账号在完全相同的请求头下均返回 200），
24 小时会让一条已经恢复的车道白停一天。

### 已知边界

- `credits.json` 由外部脚本产出，插件不自己发上游请求（保持「插件不探测」的既有约定，
  `probeEnabled=false` 仍是用户裁定）。快照过期时门禁自然失效，退回原行为。
- free-pi 的 `ads_required` 不是余额问题：它的 `credits.json` 里 total>0 但请求仍被
  广告门禁拦，所以门禁不覆盖这一条（由 dsh-free-pi 侧刷新广告解决）。
