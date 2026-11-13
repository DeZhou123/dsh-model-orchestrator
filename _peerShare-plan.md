# 渠道互借（peerShare）— 落地状态 2026-10-29 · v2.6.0

## 结论：功能已完成并跑通，尚未在浏览器/双实例上实连

全套断言：19 + 174 + 56 + 44 = **293 全绿**。

```powershell
cd E:\06AI\00DeeSeekHarness\dsh-model-orchestrator
node tools/peershare-smoke.mjs   # PASS — 19/19
node tools/smoke.mjs             # PASS — 174/174
node tools/integration.mjs       # PASS — 56/56
node tools/client-smoke.mjs      # PASS — 44/44
```

## 改动清单（git status 可查，未提交）

| 文件 | 状态 | 内容 |
| --- | --- | --- |
| src/peershare.js | 新增 | 出借方端点：/hello /models /stream，token+回环守卫 |
| src/peershare-adapter.js | 新增 | 借用方适配器：一条 provider 挂对侧全部车道 |
| tools/peershare-smoke.mjs | 新增 | 19 条断言，真 HTTP 回环 |
| src/policy-defaults.js | 改 | peerShare 默认块（含每个字段的语义注释） |
| src/config.js | 改 | resolvePeerShare + MUTABLE_KEYS 加 peerShare |
| src/catalog.js | 改 | 行上打 borrowed 标记 |
| src/router.js | 改 | borrowWhen=exhausted 时借用车道不参战 |
| index.js | 改 | 起端点 / 注册适配器 / peerView / applyConfig 深合并 |
| src/tools.js | 改 | action=peer + /route peer [on\|off\|lend\|borrow\|both] |
| client.js | 改 | 设置页互借开关 + 角色 + 借用时机 + 状态行 |
| README.md | 改 | 「渠道互借」整章（L192 起） |
| package.json | 改 | 2.6.0，check 脚本含 peershare-smoke |

## 踩过并修掉的两个 bug（别再犯）

1. **hop 头用错位置**：借用方是链路**起点**，不该带 `x-peershare-hop`。
   第一版带了 → 出借方回环守卫 508 → listModels 恒返回 0 条。
   现在只有真正的转发方（出借方转出去的那一跳）才带。
2. **对象型设置被整体替换**：面板只发 `{peerShare:{enabled:true}}`，
   整体替换会把 port/token 打回默认（表现为「开一下开关端口自己变了」）。
   index.js applyConfig 现在对 peerShare/laneGuard 做深合并。

## 三条语义（改代码前必读）

1. `borrowWhen: exhausted` 是默认：本机还有任何合格车道时借用车道不进入打分。
   互借是兜底不是常态，否则用对侧账号替本机烧钱。
2. 图片不跨实例：附件 id 只在本机有效。适配器不声明 image 模态，收到图片块报
   `UNSUPPORTED_CONTENT`，不静默降级。
3. 只借车道不借权限：只能调出借方当前可路由且未 denied 的 provider/model。

## 未验证的部分（如实记录）

- [ ] 面板互借区**未在浏览器实际渲染验证**（只过 node --check + client-smoke 的结构断言）。
- [ ] A/B **双实例实连未做**：B 的 profile 里目前没有这个插件。
- [ ] 出借端点默认绑 0.0.0.0，跨机可达性未实测。

## 下一步：实连（照抄）

```powershell
# 1) B 侧装同一目录：编辑 E:\06AI\21DSH-B\home\profiles\web\package.json
#    dependencies 加 "dsh-model-orchestrator": "link:E:/06AI/00DeeSeekHarness/dsh-model-orchestrator"
#    dsh.profile.bundles 数组加 "dsh-model-orchestrator"

# 2) A 出借（只出借，绑回环先自测）
#    /route peer lend        → 再看 /route peer 应显示「出借端点 0.0.0.0:18326 · 可借 N 条」

# 3) B 借用：拿 A 的 token
Get-Content C:\Users\11096\.dsh\model-orchestrator\peer-token
#    B 里 /route peer borrow，然后 model_orchestrator action=set peerShare:
#      { enabled:true, role:'borrow', peerUrl:'http://<A的IP>:18326', peerToken:'<上面那把>' }

# 4) 验收（B 侧）
#    /route peer   → 借用方 M 条对侧模型（M>0 才算通）
#    model_orchestrator action=peer
```

## 回滚

- 只关功能：`/route peer off`（端点立即停听，借用车道注销）。
- 回滚代码：`git checkout -- README.md client.js index.js package.json src/ tools/` 并删掉三个新文件。
