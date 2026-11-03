# dsh-model-orchestrator：定时渠道巡检（probe）—— 实现规格

> 2026-11-03 立项。来源问题：免费车道静默死亡（cline 402 / our-free-model 免费层耗尽），
> 只有被选中、失败一次之后 health 账本才知道它坏了。本次要求：定期主动探活所有渠道。

## 目标

给 `dsh-model-orchestrator` 加一个**周期性全渠道探活**：
按可配置间隔（**默认 3 天**）遍历当前目录里的每一条 provider/model，
发一个最小请求，把结果写回现有 health 账本，让面板上的"可用/冷却"反映真实状态，
而不是"上次被选中时的运气"。

## 判据（做完要能验证）

1. 启动后不立即探活（默认延迟 10 分钟的首次探测），不干扰正在进行的会话。
2. 到达间隔后自动跑一轮，遍历所有未 deny 的 lane；单条超时不拖垮整轮。
3. 每条 lane 的结果写入 `~/.dsh/model-orchestrator/health.json`：
   - 成功 → `markSuccess`（更新 lastOkAt / ttft）
   - 失败 → `markFailure`（按 classifyFailure 归类，配额类进冷却）
4. 探活产生的 token **不**计入会话 turnTokenBudget（purpose 字段必须区分）。
5. 间隔可配：`probeIntervalMs`（毫秒）与便捷项 `probeEveryDays`（默认 3）。
6. 关掉：`probeEnabled: false`。
7. `model_orchestrator` 工具面新增 action `probe`：`status` 看上次结果/下次时间，`run-now` 立即跑一轮。
8. 插件卸载/禁用时定时器必须清掉（`ctx.effect` 返回 dispose）。

## 已查明的代码事实（接手直接可用）

| 项 | 位置 |
|---|---|
| 插件根 | `E:\06AI\00DeeSeekHarness\dsh-model-orchestrator` |
| 入口 | `index.js` → `export function apply(ctx, rawConfig = {})` @ line 100 |
| 配置解析 | `src/config.js` → `resolveConfig(rawConfig, readOverrides())` @ line 147 起的字段表 |
| 默认值 | `src/policy-defaults.js` → `DEFAULT_CONFIG` / `STRATEGIES` / `COOLDOWN` |
| 健康账本 | `src/health.js` → `createHealth({userDir, persistMs, requestPolicy, clock})` |
| 账本返回 | `{KIND, classifyFailure, stateOf, markFailure, markSuccess, logDecision, observed, snapshot, windowSpend, laneSpend, persist, load, prune, dirty, hasFile, file, persistMs}` |
| 账本落盘 | `~/.dsh/model-orchestrator/health.json`（`models[]` + `lanes[]` + `buckets`） |
| 目录（lane 来源） | `src/catalog.js` → `createCatalog({ctx, dataset, channelData, getConfig, clock})` |
| 路由/资格 | `src/router.js` → `inspectLane(row, {needs, config, health, now, visionFallback})` |
| 现有 ctx.effect | `index.js` line 521、1742（照这两个写法挂定时器 + dispose） |
| 工具面 | `src/tools.js`（新增 action 加在这里） |
| 包校验 | `npm run check`（`node --check index.js && node --check client.js && tools/smoke.mjs && tools/integration.mjs && tools/client-smoke.mjs`） |

## 实现要点（踩坑预防）

- **不要用 `setInterval` 裸跑**：用 `ctx.effect(() => { const t = setTimeout(tick, delay); return () => clearTimeout(t) })`，
  每轮自己排下一轮，避免长轮次重叠；且插件 dispose 时必须能清。
- **探活请求必须带 purpose 标记**：`observer.onSample` 已有 `if (sample.purpose !== '') return` 的早退，
  探活请求走同一条 `llm.stream` 时给它一个非空 purpose（如 `'probe'`），token 才不会被算进会话预算。
- **单条 lane 独立超时**（建议 20s）+ 全轮并发上限（建议 2），避免一轮打满所有额度。
- **跳过仍在冷却且未到期的 lane** —— 它们本来就不会被选中，探了只是白烧额度；
  只探 `stateOf(lane).available === true` 或冷却**已到期**的。
- **探活失败不要记成 agent 请求失败**：`markFailure` 的 `requestPolicy` 里有"连续拒绝"计数，
  探活失败不应触发 `requestRepeatBlockMs` 的 30 分钟封禁；要么传独立 context，要么在写账本后清掉该计数。
- **落盘节流**：一轮结束后调用一次 `health.persist()`，不要每条都写。

## 交付物路径

- 新文件：`src/probe.js`（探活调度器，纯函数 + 依赖注入，便于单测）
- 修改：`src/config.js`（加 `probeEnabled / probeEveryDays / probeIntervalMs / probeTimeoutMs / probeConcurrency / probeFirstDelayMs`）
- 修改：`src/policy-defaults.js`（默认值：3 天、20s 超时、并发 2、首轮延迟 10 分钟）
- 修改：`index.js`（在 apply 里创建 probe 并用 ctx.effect 挂载）
- 修改：`src/tools.js`（action `probe`：status / run-now）
- 新增测试：`tools/probe-smoke.mjs`（用假 llm + 假 catalog，断言：间隔生效、超时不卡、冷却跳过、purpose 不污染预算）
- 更新：`README.md`（配置表 + 一段"为什么要定期探活"）

## 验证命令

```bash
cd E:/06AI/00DeeSeekHarness/dsh-model-orchestrator
node --check index.js && node --check src/probe.js
node tools/probe-smoke.mjs        # 新增
npm run check                      # 全量回归，必须 fail=0
```

## 待办（按顺序，每步可独立交付）

- [ ] 1. `src/probe.js`：调度器骨架 + 单测夹具，先不接真 llm
- [ ] 2. `src/config.js` + `policy-defaults.js`：配置项与默认值
- [ ] 3. `index.js`：挂载 + dispose
- [ ] 4. `src/tools.js`：`probe` action（status / run-now）
- [ ] 5. `tools/probe-smoke.mjs` 并跑通
- [ ] 6. README 更新 + `npm run check` 全绿
- [ ] 7. 装到 profile 验证（`~/.dsh/profiles/web/node_modules/dsh-model-orchestrator` 实际读的是这里，注意是 pnpm link 还是拷贝——**动手前先确认 link 方式**）

## 回滚

插件版本 2.6.0。改动前先 `git status` 确认工作区干净，全部改动在独立 commit 上，
出问题 `git checkout -- .` 即可；配置项默认关闭也可当作软回滚开关（`probeEnabled: false`）。
