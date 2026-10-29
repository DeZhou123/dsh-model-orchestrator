# 渠道互借（peerShare）— 落地状态 2026-10-29 · v2.6.0

## 结论：功能已合并进 main 并从 GitHub 装进 B（1ec7849）

全套断言：21 + 174 + 56 + 44 = **295 全绿**（仓库内与 B 的 `node_modules` 副本各跑一遍）。

```powershell
cd E:\06AI\00DeeSeekHarness\dsh-model-orchestrator
node tools/peershare-smoke.mjs   # PASS — 21/21
node tools/smoke.mjs             # PASS — 174/174（需传报告路径，见下）
node tools/integration.mjs       # PASS — 56/56
node tools/client-smoke.mjs      # PASS — 44/44
```

## 已交付

| 文件 | 内容 |
| --- | --- |
| src/peershare.js | 出借方端点：/hello /models /stream，token+回环守卫 |
| src/peershare-adapter.js | 借用方适配器：一条 provider 挂对侧全部车道 |
| tools/peershare-smoke.mjs | 21 条断言，真 HTTP 回环 |
| src/policy-defaults.js | peerShare 默认块（**host 默认 127.0.0.1**） |
| src/config.js | resolvePeerShare + MUTABLE_KEYS 加 peerShare |
| src/catalog.js | 行上打 borrowed 标记 |
| src/router.js | borrowWhen=exhausted 时借用车道不参战 |
| index.js | 起端点 / 注册适配器 / peerView / applyConfig 深合并 |
| src/tools.js | action=peer + /route peer [on\|off\|lend\|borrow\|both] |
| client.js | 设置页互借开关 + 角色 + 借用时机 + 状态行 |
| README.md | 「渠道互借」整章 |

## 踩过并修掉的三个 bug（别再犯）

1. **hop 头用错位置**：借用方是链路**起点**，不该带 `x-peershare-hop`。
   第一版带了 → 出借方回环守卫 508 → listModels 恒返回 0 条。
2. **对象型设置被整体替换**：面板只发 `{peerShare:{enabled:true}}`，
   整体替换会把 port/token 打回默认（「开一下开关端口自己变了」）。
   index.js applyConfig 现在对 peerShare/laneGuard 做深合并。
3. **出借端点默认绑 0.0.0.0**：拿到 token 就能花对侧额度，默认不该出现在局域网上。
   已改为 127.0.0.1，并补了 2 条可证伪断言（显式 0.0.0.0 时 bind 结果确为 0.0.0.0）。

## 未验证的部分（如实记录）

- [ ] 面板互借区**未在浏览器实际渲染验证**（只过 node --check + client-smoke 结构断言）。
- [ ] A/B **双实例实连未做**：A 侧 `overrides.json` 的 peerShare 已 `enabled:true, role:both`
      并监听 18326，但 B 侧尚未配置 `peerUrl/peerToken`（要拿 A 的 peer-token）。
- [x] 出借端点默认只绑回环（本次已改并断言）。
- [ ] 跨机可达性未实测（需要显式填局域网地址才成立）。

## 双实例实连步骤（下一步，未执行）

```powershell
# A 侧已就绪：/route peer 应显示「出借端点 0.0.0.0:18326 · 可借 N 条」
Get-Content C:\Users\11096\.dsh\model-orchestrator\peer-token   # A 的 token

# B 侧：patch 里加（改完重启 B 生效）
#   - id: model-orchestrator
#     config:
#       peerShare:
#         enabled: true
#         role: borrow
#         peerUrl: 'http://127.0.0.1:18326'
#         peerToken: '<上面那把>'
```

> 注意：借的是 **A 的账号额度**。开之前确认 A 那边额度还有余量，且 B 的
> `denyProviders` 不会因此被绕过（互借只借车道不借权限，A 自己的 deny 仍然生效）。

## 回滚

- 只关功能：`/route peer off`（端点立即停听，借用车道注销）。
- 回滚代码：`git revert 1ec7849`（B 侧装的是 commit 包，重装上一个 commit 即可：
  `a7f5425`；本地快照在 `E:\06AI\21DSH-B\_backup\mo-2.5.0-a7f5425\`）。
