# dsh-model-orchestrator — 模型调度（两级）

先选**模型**，再选这个模型所在的**渠道**；失败时先换渠道、再换模型。
输入框下方实时显示当前模型、渠道健康、今日用量与自动切换记录。

装在 DSH 里就是一个 bundle：一个 Host 半身（路由决策）+ 一个浏览器半身（状态条与详情面板）。

> **配套插件：[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（OFM）——推荐一起装，但不是依赖。**
> OFM 把免费模型接进来，本插件在这些车道之间做调度。两者零代码依赖，
> 只有 OFM 写在本机的状态文件被当作额外信号读进来。详见 [与 dsh-our-free-model 的关系](#与-dsh-our-free-model-的关系)。

---

## 与 dsh-our-free-model 的关系

**本插件定位为 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（OFM）的配套插件。** 分工是这样的：

- **OFM 负责「把免费模型接进来，并记录渠道状态」**——免登录、免注册、免 API Key，
  把一批前沿模型注册成 `our-free-model` / `our-free-model-region` 两条 provider 车道；
  并在本机维护一份渠道账本（`$DSH_HOME/channel-pack/`，记录账号、每账号每模型的限流解禁时间、
  逐渠道首字与今日 token，以及免费车道的可用性探测结果）。
- **本插件负责「在这些车道之间做调度」**——选哪个模型（智力/速度/成本/用量打分）、走哪条渠道
  （实时健康、限流、首字、粘滞）、失败了先换渠道还是换模型、锁定一个模型时怎么在它的渠道间切换。
  它**不产生模型**，只决定请求走哪条已经存在的路。

两者**没有代码依赖，也没有互相 import**（`package.json` 里没有 `dependencies`），
模型清单来自内核的 LLM 注册表（`llm.listProviders/listModels/resolveModelInfo`），**不硬编码任何渠道**。

| 你装了什么 | 得到什么 |
| --- | --- |
| 只装 OFM | 免费模型可用；走哪条渠道由 OFM 自己决定，本插件不参与 |
| 只装本插件 | 任何 DSH provider 都能正常路由；少了 OFM 那层渠道旁证，改用本插件自己观测的流量账本 |
| **两个都装（推荐）** | 免费模型 + 两级调度：渠道健康排序、失败先换渠道再换模型、偏好锁定、状态条全部生效，且冷却与限流以 OFM 账号池的真实解禁时间为准 |

### OFM 提供哪些信号（可选）

OFM 往本机写四个 JSON，本插件**只读不写**：

| 文件 | 由谁写 | 不装 OFM 时 |
| --- | --- | --- |
| `$DSH_HOME/our-free-model/availability.json` | OFM | 免费车道的可用/不可用判定缺失，该渠道按「未知」处理 |
| `$DSH_HOME/our-free-model/stats.json` | OFM | 免费车道的今日用量缺失，用量项按 0 计 |
| `$DSH_HOME/channel-pack/state.json` | OFM（内嵌 channel pack） | 拿不到每账号每模型的限流解禁时间，冷却判定改用本插件自己观测到的失败 |
| `$DSH_HOME/channel-pack/token-ledger.json` | OFM | 少了第二优先的延迟证据，延迟只认本插件实测和报告值 |

读不到文件、格式不认、provider 不认识，一律降级成「没有信号」——`signal()` 返回 `available: null`（未知），
不是 `false`（不可用），所以未知不会被当成坏渠道排掉。
想彻底关掉这两个来源：配置里 `channelData: false` 和 `freeModelData: false`。

**证据**：集成测试 `tools/integration.mjs` 把 `DSH_HOME` 指向一个空临时目录
（既没有 `our-free-model/` 也没有 `channel-pack/`），在这个前提下加载真实的 Host 半身、
跑通路由、失败换渠道、偏好模式与暂停恢复——27 项全过。

---

## 安装

需要一个已经装好的 DSH（Desktop 或 `dsh web`）。

```bash
# 1) 把仓库放到任意目录，然后作为一个本地 link 依赖装进你的 DSH profile
cd ~/.dsh/profiles/web
pnpm add link:/absolute/path/to/dsh-model-orchestrator
```

```bash
# 2) 把 dsh-model-orchestrator 加进 ~/.dsh/profiles/web/package.json 的
#    dsh.profile.bundles 数组（漏了这一步插件不会被加载）
# 3) 重启一次 DSH Desktop（或 dsh web）
```

Host 半身只在启动时加载一次，浏览器半身（状态条/详情面板）由 HMR 或刷新页面加载。

验证：输入框下方出现模型状态条；`/route status` 能列出模型组；
`model_orchestrator {"action":"status"}` 的 `catalog.total` > 0。

## 它解决什么

你手上有十几条免费/低价渠道，同一个模型（比如 `glm-5.3`）往往在 4~6 条渠道上都有。
真正要回答的问题不是「哪个模型分数最高」，而是：

1. **现在该用哪个模型？** —— 由报告里的智力分、实测速度、成本和你的偏好共同决定。
2. **这个模型该走哪条渠道？** —— 由渠道的实时健康、限流、额度和实测首字决定。
3. **渠道挂了怎么办？** —— 先换同模型的其它渠道；只有整个模型的渠道都用不了，才换模型。
4. **我只想用某个模型。** —— 打开**偏好模式**：只调用该模型，自动在它的渠道间切换；全部渠道不可用时暂停偏好、改用备用模式并提醒你。

旧版把「模型」和「渠道」压成一个分数：每次失败都重新给所有 `provider/model` 排序，
于是可能在 `glm-5.3` 的另一条渠道还活着的时候，换到一个更弱的模型上。
这一版把两层分开，并把「用户明确选的模型」放到最高优先级。

---

## 优先级是怎么算的（可以逐项复述）

**模型层**（选哪个模型的权重）：

| 项 | 含义 | 数据来源 |
| --- | --- | --- |
| quality | 智力分 / 46，按可信度向中性收缩 | 测速报告（先验） |
| speed | `1/(1+首字/10s)` | 本机实测优先 → 渠道账本 → 报告逐车道 |
| health | `1/(1+0.8×衰减失败数)` | 本机流量账本 |
| cost | `1/(1+家族消耗×车道倍率)` | 报告标签 + 模型名里的 `x0.2` 倍率 |
| usage | `1/(1+今日 token/2M)` | 渠道账本今日用量 |

四档策略只是重新分配这些权重（每档权重和为 1）：

- **quality**：智力 0.58，速度/健康/成本/用量各占少量；
- **balanced**（默认）：智力 0.46，速度 0.18，健康 0.14，成本 0.14，用量 0.08；
- **economy**：成本 0.30，智力 0.34；
- **speed**：速度 0.34，智力 0.34。

**渠道层**（同一个模型内选哪条渠道）：同样的五项，但 quality 相同（同模型），
真正起作用的是健康、首字、倍率、今日用量，以及「是否正持有本会话的 prompt 缓存」。

**粘滞**：当前模型/渠道领先不到切换阈值时不换；切换阈值随任务复杂度收紧或放宽。
用户刚在选择器里手动选过的模型，切换阈值翻倍（默认 30 分钟内）。

**失败处理顺序**：

1. 记录到**实际失败的那条 `provider/model`**（用 `agent/request` 的最终配置，而不是可能滞后的请求头）；
2. 先在同模型的其它渠道里重试（同一步内 `{kind:'retry'}`，调用方看不见）；
3. 整个模型都没有可用渠道时，才按策略换模型；
4. 偏好模式下第 3 步会触发「偏好暂停」：改用备用模式并通知，渠道恢复后自动恢复偏好。

**两种「不是我们的错、但也不能一直忍」的情况**（LOCAL PATCH 2026-10-18）：

- **渠道安全审核拦截**（如腾讯 CodeBuddy/WorkBuddy 回 `HTTP 400 请求被拦截，请重新发送 request illegal`）。
  这类 400 会被识别成 `safety` 判定：该渠道对**这个模型**冷却 30 分钟，同渠道的其它模型不受影响，
  本次请求立刻换渠道重试。以前它被当作 `INVALID_REQUEST`（「我们的请求写错了」），于是既不冷却也不换渠道，
  连续两个回合都撞同一堵墙。
- **连续被同一个渠道拒绝**（任意 400）。单次 `INVALID_REQUEST` 仍然**不动路由**（渠道无罪），
  但同一渠道 `requestRepeatThreshold`（默认 2）次、在 `requestRepeatWindowMs`（默认 10 分钟）内接连拒绝时，
  该模型被暂停 `requestRepeatBlockMs`（默认 30 分钟）并立刻换渠道。收到一次成功响应就清零。

---

## 偏好模式

面板里点「偏好」，或在 `/route` 里：

```
/route prefer glm-5.3          # 只调用 glm-5.3，自动在它的渠道间切换
/route prefer glm-5.3 buddy    # 限定只走 buddy 这一条渠道（该渠道挂了就算偏好不可用）
/route unprefer                # 回到自动
```

规则：

- **同一个模型，换渠道不换模型。** 渠道限流/额度耗尽/不可用时，优先在同模型的其它渠道重试。
- **只在本步不满足时临时改选。** 如果这次请求需要图片、而偏好模型不支持视觉，或者上下文超过它的窗口，
  这一步会临时用别的模型，但**不会**暂停偏好模式（下一次请求仍回到偏好模型）。
- **所有渠道都不可用才暂停。** 判定标准是渠道级：冷却、被屏蔽、渠道面板关闭、免费车道探测不可用。
  暂停时：状态条变黄、面板显示原因与倒计时、桌面端弹通知；默认在渠道恢复后自动恢复并再通知一次。
- **选择器跟着走。** 路由切换会写入内核的 `model/selection`，所以浏览器里的模型选择器、会话日志、
  模型收到的「模型已变更」提示、面板显示的模型是同一个。
  在偏好模式下从选择器里改选模型，会把偏好模型一起改掉（可在配置里关闭）。

---

## 数据从哪来（以及为什么更准）

| 数据 | 来源 | 用法 |
| --- | --- | --- |
| 模型清单、上下文窗口、模态、reasoning 档 | 内核 `llm.listProviders/listModels/resolveModelInfo` | 能力过滤、effort 选择 |
| 渠道账号、每账号每模型的限流解禁时间 | OFM 写的 `$DSH_HOME/channel-pack/state.json` | 渠道级可用性（只读） |
| 今日每渠道每模型的请求/错误/token/首字 | OFM 写的 `$DSH_HOME/channel-pack/token-ledger.json` | 第二优先的延迟证据 + 用量项 |
| 免费车道的逐模型可用性与探测延迟 | OFM 写的 `$DSH_HOME/our-free-model/availability.json` | 免费车道不可用/可用判定 |
| 免费车道今日逐模型统计 | OFM 写的 `$DSH_HOME/our-free-model/stats.json` | 免费车道用量 |
| 真实流量的首字、token、失败 | 本插件观测 `llm/stream` | 第一优先的延迟证据 + 健康账本 |
| 智力分、逐车道报告首字、标签 | 报告导入 / 随包 `priority-data.json` | **先验**，可信度收缩 |

关键点：

- **报告只是先验。** 报告是别的机器、别的日期、benchmark 最大 effort 下测的。
  `quality` 会按「识别可信度 × 实测/估算」向 0.5 收缩：精确别名 0.9，模式猜测 0.7，
  报告没见过的 id 直接中性 0.5。它不会因为「报告没写」就被排除。
- **不再拿家族最快车道的首字当某条车道的首字。** 旧版会让一条 45 秒的车道继承另一条 1 秒车道的速度；
  现在只认**这条车道**的实测/账本/报告值，没有就承认「没有证据」。
- **渠道限流以渠道面板自己记录的为准。** 同一渠道多账号时，只有**所有启用账号**都被该模型限流才判不可用。
- **所有数据都在本机。** 不上传任何东西；渠道文件读取失败只是「没有信号」，路由照常工作。

---

## 界面

输入框下方一条状态带（`conversation.composer.dock`，与「用量/余额看板」并排）：

```
[模型调度 · 自动]  ● glm-5.3  可用  今日 12.4k  自动切换 2   ▾
[模型调度 · 偏好]  ● glm-5.3  偏好模式生效中 · 4/6
[模型调度 · 偏好!] ⚠ glm-5.3  偏好模式已暂停 → 自动
```

展开后：

- **模式**：自动 / 偏好 / 手动 / 关闭；**策略**：质量优先 / 均衡 / 省 token / 速度优先；
- **偏好模型**下拉（带可用渠道数）、**偏好不可用时**的备用模式、单轮 token 预算；
- **当前模型卡**：家族、真实渠道、推理档、请求数、自动切换、失败原因与倒计时、一键「设为偏好」；
- **模型组表**：★ 设为偏好、可用渠道/总渠道、最佳渠道、智力、得分；
- **当前模型的渠道表**：渠道、状态、得分、首字、今日 token；
- **最近切换**：时间、从哪到哪、为什么；
- 偏好暂停横幅：原因 + 「重试偏好」。

面板只读 `/api/model-orchestrator/summary`、写 `/api/model-orchestrator/config`；
两条路由都走宿主自己的鉴权闸门（`ctx.connection`），未登录的 loopback 调用者拿到 401。

---

## 给模型用的工具与命令

工具 **`model_orchestrator`**：

- `status` / `explain` / `lanes`
- `set`（mode/strategy/preferModel/preferProvider/preferFallback/turnTokenBudget/deny/allow/denyProviders/reasoningEffort）
- `prefer` / `unprefer`
- `refresh` / `import_report` / `clear_import`

命令 **`/route`**：

```
/route status|explain|lanes|auto|manual|off|prefer <模型> [渠道]|unprefer
/route quality|balanced|economy|speed|reasoning <auto|preserve|effort>|refresh
```

面板上的每个操作和工具/命令走的是**同一份实现**。

---

## 配置

写在 profile 的 `cordis.patch.yml`（优先级最高），或在面板里改（存到 `$DSH_HOME/model-orchestrator/overrides.json`）。
补丁层里显式写过的键会盖过面板。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。 |
| `mode` | `auto` | `auto` / `prefer` / `manual` / `off`。 |
| `preferModel` / `preferProvider` | `''` | 偏好模型（家族 id、模型 id 或 `provider/model`）与可选渠道限制。 |
| `preferFallback` | `auto` | 偏好不可用时的模式：`auto` / `manual` / `off`。 |
| `preferNotify` | `true` | 暂停/恢复时发桌面通知。 |
| `preferAutoResume` | `true` | 渠道恢复后自动恢复偏好。 |
| `preferFollowSelection` | `true` | 选择器改选时同步改偏好模型。 |
| `strategy` | `balanced` | `quality` / `balanced` / `economy` / `speed`。 |
| `deny` / `allow` | `[]` | 额外屏蔽 / 放行的模型（id 或 `provider/model`）。 |
| `denyProviders` | `[]` | 整条渠道排除。 |
| `maxSwitchesPerStep` / `maxSwitchesPerTurn` | `3` / `12` | 同一步/同一轮最多自动切几次。 |
| `requestRepeatThreshold` | `2` | 同一渠道在窗口内连续拒绝几次后暂停该模型（1–10）。 |
| `requestRepeatWindowMs` | `600000` | 上面那个「连续」的时间窗口。 |
| `requestRepeatBlockMs` | `1800000` | 连续被拒后暂停多久（0 = 只换渠道不暂停）。 |
| `proactiveSwitch` | `true` | 冷却中的渠道直接跳过，而不是等它。 |
| `escalateOnFailure` | `true` | 失败后优先换到智力不低于失败模型的模型。 |
| `turnTokenBudget` | `0` | 单轮输出 token 预算，超出后切省 token 档；0 关闭。 |
| `longContextThreshold` | `120000` | 超过这个 prompt 规模就只考虑长上下文模型。 |
| `latencyGateMs` | `10000` | 首字达到这个值时速度项为 0.5；0 关闭。 |
| `anchorBonus` | `0.04` | 保持当前渠道的加分（只影响渠道层，不参与模型比较）。 |
| `switchMargin` / `laneSwitchMargin` | `0.04` / `0.05` | 换模型 / 换渠道的粘滞阈值。 |
| `userChoiceTtlMs` | `1800000` | 手动选择器改动被尊重的时长（自动模式，翻倍阈值）。 |
| `routeSubagents` | `false` | 是否也路由子代理会话（默认让子代理自己的模型选择生效）。 |
| `reasoningEffort` | `auto` | `auto`（按策略）/ `preserve`（能保留就保留）/ 具体 effort。 |
| `channelData` / `freeModelData` | `true` | 是否读取渠道面板账本 / 免费车道探测。 |
| `catalogRefreshMs` / `channelDataRefreshMs` | `120000` / `30000` | 模型清单 / 渠道数据的刷新间隔。 |
| `modelInfoTtlMs` | `21600000` | 模型元数据缓存时长。 |
| `usageUnitTokens` | `2000000` | 用量项的参考规模。 |
| `reportPath` | `''` | 启动时自动导入这份报告。 |

**旧键兼容**：`pinProvider`/`pinModel` 会被折叠成 `preferModel`/`preferProvider`，并把 `auto` 改为 `prefer`。

---

## 数据存在哪

- `$DSH_HOME/model-orchestrator/health.json` —— 渠道/模型账本：状态、冷却到期、失败次数（3 小时半衰期衰减）、
  首字 EWMA、token 用量（15 分钟 / 1 小时 / 5 小时 / 当天）。
- `$DSH_HOME/model-orchestrator/overrides.json` —— 面板/工具改过的设置。
- `$DSH_HOME/model-orchestrator/priority.json` —— 你导入的报告数据层；`clear_import` 删除它。

---

## 它是怎么接进内核的

- **决策点：`system-prompt/assemble`（`prepend: true`）。** 内核在组装时快照本步模型；插件在快照前写入选择。
- **写选择：`sessionController.selectForNextRequest(agent, selection)`。** 它同时追加 `model/selection`
  事件并更新选择对象，这是浏览器选择器、会话日志和面板保持一致的唯一正确路径。
- **请求兜底：`agent/request`。** 在 `next()` 之后再按 `state.applied` 覆盖一次 `provider/model/effort`，
  保证真正发出去的请求就是路由器选的那条。
- **同一步故障转移：`agent/request-error`。** 返回 `{kind:'retry'}` 让内核在同一 step 重新解析配置。
- **观测：`llm/stream`。** 只记录抛出的异常；带内 `finish.error` 交给 `agent/request-error`，
  避免一次失败记两次（非 agent 循环的调用例外，它们没有 request-error）。
- **同步：`llm/adapters-updated` + 自适应定时器。** 新登录的渠道账号会自动出现；刷新间隔改了不用重启。

---

## 验收情况

```
node tools/smoke.mjs        # 109 项离线校验
node tools/integration.mjs  # 22 项：用 mock Cordis 上下文加载真实 Host 半身
```

覆盖：配置、家族识别与可信度、失败分类、账本自愈、渠道账本/限流/免费探测、
目录装饰（能力/倍率/重复 id/批处理/用户屏蔽）、两级选择、同模型换渠道、偏好模式
（生效/限流/暂停/备用关闭/本步临时改选/恢复）、回合结束恢复用户选择、粘滞与升级、effort 选择、报告导入。
集成测试还覆盖：真实插件 `apply()` 接线、`model/selection` 落盘、请求覆盖、回合边界恢复用户选择、
失败重试、偏好暂停通知、成功恢复通知、工具与命令面。

---

## 部署动作

- 以 `link:<你的插件目录>` 装在 web profile，并已加入 `dsh.profile.bundles`。
- **Host 半身改动需要重启一次 DSH Desktop（或 `dsh web`）才会加载**；浏览器半身由 HMR/刷新加载。
- 重启后确认：状态条显示真实模型；`/route status` 能列出模型组；
  `model_orchestrator { "action": "status" }` 的 `catalog.total` > 0。

---

## 已知边界

- **只路由 agent 的模型请求。** 其它直接调用 `ctx.llm.stream` 的代码不经过本插件（但仍会被观测用量）。
- **剩余额度不可知。** 免费渠道的上游不告诉你余额；面板显示的是状态、冷却、实测首字和本插件统计的用量。
- **报告是快照。** 报告没有的模型按中性先验处理；跨版本 AA 分数不可比。
- **家族识别仍可能有误。** 精确别名/规范表可信；模式匹配只有 0.7；识别错了会把不同模型当成同一个。
- **渠道账本读的是 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的私有文件格式。**
  那四个 JSON 是 OFM 的内部状态，没有版本承诺；文件缺失或结构变化时自动退化为「没有信号」，不会阻断路由。
  见 [与 dsh-our-free-model 的关系](#与-dsh-our-free-model-的关系)。
- **偏好模式的「全部渠道不可用」是全局判断。** 一次请求的图片/窗口限制只会临时改选，不会暂停偏好。
- **切换会改变模型看到的上下文。** 换 provider 时内核会丢掉适配器私有的 replay 信封（文本与工具历史保留），
  并追加一条持久提示告知模型发生过切换——这是内核设计好的行为。

## 开发

```
node tools/build-data.mjs [报告.md]   # 重新生成 src/priority-data.json
node tools/smoke.mjs                  # 109 项离线校验
node tools/integration.mjs            # 22 项接线校验
```

`tools/build-data.mjs` 只写「实测事实」；策略（黑名单、车道提示、权重、冷却时长、effort 选择）
在 `src/policy-defaults.js`，所以重新导入一份报告不会悄悄改变插件的行为。

## 许可

MIT
