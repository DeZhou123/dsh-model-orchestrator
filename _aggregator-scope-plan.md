# 修复：互借车道被「一损俱损」判死 + 综合 A 侧新改动（2026-11-03）

## 现象（实测证据）
B 侧 2026-11-03 23:21 / 23:23 四次「偏好模型不可用 — 全部 19 条渠道不可用」，
其中 10 条 peer 渠道的死因全是同一句 `cline: 模型 xiaomi/mimo-v2.6-pro 额度已用尽（402）`。
mimo 不是偏好模型（deepseek-v4.1-flash）。穿透 18326 中继实测
`buddy/deepseek-v4.1-flash` 当时**能正常回话**，账本却把它标死到 00:05。

## 根因
`classifyFailure` 把 cline 的 402 判成 `scope: 'lane'`（QUOTA_PER_MODEL_TEXT 只认
「改用其它**模型**」，不认「改用其它 **provider**」）。在借用方这里 lane = provider
= `peer` = **对侧全部 600 个模型**的聚合体。于是一个模型的额度问题停掉整条借入车道。

A 侧同样成立：A 也 borrow（role=both），A 借 B 时同样会被一次 402 停掉整条 peer 车道。

## 修复口径
1. **聚合车道降级**（`src/health.js`）：`isAggregator(provider)` 为真时，任何
   `scope: 'lane'` 的判决在记账前降为 `scope: 'model'`，reason 加前缀
   `〔聚合车道：仅本模型〕`。
2. **加载自愈**（`src/health.js` load）：磁盘上历史遗留的聚合车道级停车在下次启动
   被清掉；模型记录保留自己的冷却但补上标记。
3. **判据来源**（`index.js` `isBorrowerProvider`）：只认 `peerShare.peerProvider`，
   不猜 provider 名字；互借关掉后旧记录不再被当聚合体。
4. **探活不再烧对侧额度**（`index.js` probe.listLanes）：A 2026-11-03 新增的定时探活
   会把 `catalog` 里**借来的 600 条**一起探——那是拿对侧账号烧钱，且每条失败都会写
   账本。默认跳过借入行（`probeBorrowed` 默认 false，可显式打开）。

## 判据（怎么算做完）
- `node tools/smoke.mjs` PASS，新增 [15] 段：聚合车道 402 → peer 兄弟模型仍 eligible；
  真实渠道 402 → 仍是车道级（不回归）。
- `node tools/peershare-smoke.mjs` PASS（44 条，A 的 200-vs-error 修复不被破坏）。
- `node tools/probe-smoke.mjs` PASS。
- B 侧装新版本后：`health.json` 里 peer lane 记录不再带 QUOTA；`model_orchestrator`
  的 status 里 preference.suspended 不再因为 mimo 402 而反复触发。

## 交付物
- 仓库 `E:\06AI\00DeeSeekHarness\dsh-model-orchestrator`（A 侧 link 挂载 + B 侧 github 装）
- 新版本号 2.6.1

## 进度
- [x] health.js: isAggregator / demoteOnAggregator / AGGREGATOR_MARK / healAggregator
- [x] index.js: isBorrowerProvider + createHealth 接线
- [ ] probe 跳过借入行
- [ ] 版本号 + smoke 用例
- [ ] 三套测试跑绿
- [ ] commit/push + A/B 两侧更新
