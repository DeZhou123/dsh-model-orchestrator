# 定时渠道巡检（probe）—— 完成记录

2026-11-03 完成。对应需求：`dsh-model-orchestrator` 定期检测所有渠道，间隔可调，默认三天。

## 验证证据（全部实测）

| 套件 | 命令 | 结果 |
|---|---|---|
| 探活单测 | `node tools/probe-smoke.mjs` | **pass=34 fail=0** |
| 互借回归 | `node tools/peershare-smoke.mjs` | **PASS 41/41** |
| 调度回归 | `node tools/smoke.mjs` | **PASS 174/174** |
| 集成回归 | `node tools/integration.mjs` | **PASS 56/56**（exit 0） |
| 客户端回归 | `node tools/client-smoke.mjs` | **PASS 44/44** |
| 语法 | `node --check index.js` / `client.js` / `src/probe.js` / `src/tools.js` / `src/config.js` | 全部 exit 0 |
| 模块加载 | `import('./index.js')` | name=model-orchestrator, inject=["llm"], apply=function, v2.6.0 |
| 默认间隔 | `resolveIntervalMs({})` | 259200000 ms = **3 days** |
| 集成复跑（后台） | `node tools/integration.mjs > %TEMP%\integ.log` | **done exit=0**，日志末行 `PASS — 56/56` |

> 集成测试跑了两遍（前台 + 后台落盘日志），两次都是 56/56、exit 0 —— 排除偶发。

## 改动清单

```
 M README.md               +19   配置表 + 「定时渠道巡检」章节
 M index.js               +107   探活挂载（ctx.effect + dispose）、api.probe 入口、llmReady 闸门
 M src/config.js           +10   MUTABLE_KEYS + resolveConfig 六个字段
 M src/policy-defaults.js  +22   DEFAULT_CONFIG 六个默认值
 M src/tools.js            +11   action=probe（probeMode: status | run-now）
?? src/probe.js                  新增：调度器（createProbe / resolveIntervalMs / shouldSkip / runPool）
?? tools/probe-smoke.mjs         新增：34 条断言
?? _probe-plan.md                实现规格（立项时写）
```

## 关键设计决策（都写进了代码注释）

1. **默认 3 天**：探活要花额度。太勤等于替用户烧钱，太疏账本又失真。
2. **首轮延迟 10 分钟**：避免启动瞬间和用户正在进行的会话抢额度。
3. **冷却未到期直接跳过**：它本来就不会被选中，探了只是白烧额度。到期了**必须**探——那正是"它恢复了没有"的答案。
4. **`purpose='probe'`**：observer 的 onSample 对非空 purpose 早退，所以探活 token 绝不进 `turnTokenBudget`。
5. **单条独立超时（20s）+ 并发上限（2）**：一条挂死不拖垮整轮（smoke 用永不返回的 Promise 验证过）。
6. **每轮只落盘一次**：不是每条一次。
7. **每轮自己排下一轮**：间隔按实时配置重算，面板改了值下一轮就生效，不用重启。
8. **`ctx.effect` 托管**：插件卸载时 `stop()` 会清掉定时器。

## 修过的一个 bug

首版把 `let llmReady = false` 放在 `ctx.inject` 之后，触发 TDZ：
`ReferenceError: Cannot access 'llmReady' before initialization`（integration 直接崩）。
已移到 `llmStream` 声明旁边，复跑 integration 恢复 PASS 56/56。

## 使用方法

```bash
# 看上次结果与下次时间（只读，不花额度）
model_orchestrator action=probe probeMode=status

# 立即跑一轮（真实消耗额度）
model_orchestrator action=probe probeMode=run-now

# 改间隔
model_orchestrator action=set probeEveryDays=7
# 或
model_orchestrator action=set probeIntervalMs=86400000

# 关掉
model_orchestrator action=set probeEnabled=false
```

## 尚未做的（下一步）

- **未装到运行中的 profile 验证**：插件目录是 symlink（`~/.dsh/profiles/web/node_modules/dsh-model-orchestrator` → `E:\06AI\00DeeSeekHarness\dsh-model-orchestrator`），
  代码层热重载在本机被 `--expose-internals` 卡住（见 MEMORY.md），所以**需要重启 DSH 才能生效**。
- **未提交 git**：改动都在工作区，`git status` 干净可回滚。
