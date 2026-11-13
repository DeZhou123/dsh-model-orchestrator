# 免费渠道模型指纹鉴定报告（dsh-model-orchestrator）

- 时间：2026-11-13 16:40–16:52（Asia/Shanghai）
- 执行者：模型身份鉴定子代理（工作区 `E:\06AI\00DeeSeekHarness`）
- 工具：`dsh-model-orchestrator/tools/_fingerprint.mjs`（本次新建）
- 请求预算：**59 / 60**（串行、间隔 1.2–2.0s、失败不重试）
- 纪律遵守：**未向 deepseek-official / deepseek-account 发任何请求**；脚本内写死黑名单；报告不含任何 key 明文

---

## 1. 可用的调用通道（端点 + 凭据来源，只记路径不记明文）

| 通道 | 端点 | 凭据来源（文件路径 / 环境变量名） | 本次可用性 |
| --- | --- | --- | --- |
| **渠道互借（唯一真正可用）** | `http://127.0.0.1:18326/peershare/v1/stream`（NDJSON） | `C:\Users\11096\.dsh\model-orchestrator\peer-token`（43 字符）；同值亦见 `...\model-orchestrator\overrides.json` 的 `peerShare.token` | ✅ 192 条车道可枚举、可发请求 |
| 车道枚举 | `GET /peershare/v1/models`、`/hello` | 同上 | ✅ 返回 `version 2.7.0`、192 条 |
| 渠道账号登记 | —— | `C:\Users\11096\.dsh\channel-pack\state.json`（20 个账号 + `credentialRef`）、`token-ledger.json` | ✅ 读取 |
| 渠道凭据本体 | 各上游私有协议 | `C:\Users\11096\.dsh\.credentials.yaml`（refs 如 `QODERCN_ACCOUNT_* / ZCODE_ACCOUNT_* / CLINE_ACCOUNT_*`） | ✅ 登记在册（**未读明文、未外传**） |
| 上游端点定义 | qoder `https://api2-v2.qoder.sh` / 加密端点 `https://api2.qoder.sh`；qodercn `https://gateway.qoder.com.cn`；zcode `https://api.z.ai/api/anthropic`；trae `https://trae-api-cn.mchost.guru`；cline `https://api.cline.bot`；loomy `https://loomyad.xunfei.cn/api/v1`；raccoon `https://xiaohuanxiong.com`；lobsterai `https://lobsterai-server.youdao.com`；codearts `https://snap-access.cn-north-4.myhuaweicloud.com/api/v2`；minimax `https://agent.minimax.cn`；gemini `https://cloudcode-pa.googleapis.com` | 源码：`dsh-free-model\src\lanes.js:79-191`；`profiles\web\node_modules\dsh-our-free-model\vendor\channel-pack\pack.js`（qoder 表 `36351-36650`） | 参考 |
| FreeLLMAPI 本地网关 | `http://127.0.0.1:31415/v1`，key 环境变量 `FREELLMAPI_API_KEY` | `C:\Users\11096\.dsh\profiles\web\cordis.patch.yml:362-374` | ❌ 端口 31415 未监听（网关未启动） |

**为什么用互借端点而不是直连上游**：本机 DSH 进程已持有全部凭据与各家私有协议（Qoder 走加密推理端点、Cline 带 `workos:` 前缀头、Loomy/Raccoon 各有代理层）。互借端点把它们统一成一条 NDJSON 线，探针不必重写任何一家协议，也不必把 key 复制出来。

---

## 2. 探针设计

| 探针 | 内容 | 作用 | 权重 |
| --- | --- | --- | --- |
| **P1 自述** | `只回答一行：你的模型名称、厂商、参数规模。不要解释。` | 抓系统提示里被注入的身份 | 低（本次实测会漂移，见 §4.2） |
| **P2 家族校准 + 指令陷阱** | `A) Which number is larger: 9.11 or 9.9? Answer with the number only.` + `B) 用恰好 5 个字说明什么是 HTTP。只输出那 5 个字。` | A 是跨家族稳定错法基线；B 是「字数约束」陷阱，实测能分出档位 | 中 |
| **P3 元信息** | 固定 125 字符中英混合样本 → 读 `usage` 帧（`inputTokens / reasoningTokens / cacheReadTokens`）+ 响应头子集 | 非生成侧证据：分词/系统提示体量/是否带 prompt cache | 高（唯一不可被模型"演"的证据） |

关键实现细节（踩坑后修好）：思考型模型会把 `maxTokens` 先花在 reasoning 上，给 160 token 会**只拿到思考、拿不到答案**；最终 P1 用 1200、P2 用 1000。另：`usage` 帧有两种形状（字段平铺 / 挂在 `chunk.usage` 下），解析要两者都认。

---

## 3. 结果表

| id | provider | 疑似真实家族 | 置信度 | 证据摘要（实际返回片段 ≤2 行 + usage/头） | 建议（是否入 canonical 别名表） |
| --- | --- | --- | --- | --- | --- |
| `GLM-5.3-Flash` | loomy | **GLM 系（Z.ai/智谱）** | **high** | P1 `"GLM | 智谱AI（Z.ai）| 参数规模未公开披露"`；思维链 `"My model is GLM, made by Z.ai."`。P3 `{"type":"usage","usage":{"inputTokens":61,"outputTokens":12,"reasoningTokens":12}}` | ✅ 入表（canonical → `z-ai/glm-5.3-flash`） |
| `auto` | loomy | **GLM 系（该时刻路由到 GLM）** | medium | P1 `"GLM，Z.ai，参数规模未公开。"`（两次请求一致） | ⚠️ 不入表（路由可变，只能标 `auto→GLM 倾向`） |
| `spark-x2.6` | loomy | **讯飞星火（iFlytek Spark）** | **high** | P1 `"讯飞星火大模型，科大讯飞，参数规模约千亿级。"`；P2 `"A=9.9 B=超文本传输协议"`（7 字，陷阱未守住）；P3 `inputTokens:78` | ✅ 入表（→ `spark/x2.6`） |
| `qwen3.8-flash` | loomy | **Qwen 系（阿里）** | medium-high | P1 `"Qwen、阿里巴巴、未公开具体参数规模"` | ✅ 入表（→ `qwen/qwen3.8-flash`） |
| `deepseek-v4-flash-1017` | loomy | **不确定；自述漂移**（一次 DeepSeek、一次 GPT-4） | **low** | 第一轮思维链：`"我是DeepSeek最新版模型。厂商深度求索…DeepSeek-V3 是671B总参数"`；第二轮同一 prompt 的正文：`"GPT-4、OpenAI、参数规模未公开"`。P3 `inputTokens:77` | ❌ 不入表；需补 P4（见 §6） |
| `MiniMax-M3.1-Flash` | minimax | **MiniMax 系（直系渠道）** | medium-high | P1 回避：`"模型名称：未提供；厂商：未提供；参数规模：未公开。"`；但 P2 是唯一守住陷阱的：`"A=9.9 B=超文本协议"`（恰好 5 字）；P3 `{"inputTokens":52,"outputTokens":12,"cacheReadTokens":197,"reasoningTokens":11}` | ✅ 入表（→ `minimax/MiniMax-M3.1-flash`） |
| `MiniMax-M3` | minimax | **MiniMax 系** | high | P1 `"MiniMax， MiniMax, 未公开"`；响应无 reasoning 帧（与 M3.1-Flash 有 reasoning 形成档位差异） | ✅ 入表 |
| `gmodel / gfmodel / kmodel_latest / kmodel / dmodel / dfmodel / mmodel / qmodel_38max / qmodel / qmodel_latest / qfmodel` | qoder | **无法判定** | — | 三次请求全部 `qoder: transport error: fetch failed`（TLS 建连即断） | ❌ 缺证据：需先解决 qoder 国际站网络可达性 |
| `gmodel / gm51model / kmodel_latest / kmodel / dmodel / dfmodel / qmodel / qmodel_38max / qfmodel / q37fmodel` | qodercn | **无法判定** | — | 上游固定回 `{"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"} (112/model_error)`（4 个不同 id 同一错误） | ❌ 缺证据：需一次真实账号闭环（额度/权益未生效或客户端身份不匹配） |
| `sn-sensenova-6-8-flash / sn-glm-5-3 / sn-glm-5-3-flash / sn-kimi-k3 / sn-deepseek-v4-1-flash-1017` | raccoon | **无法判定** | — | 两轮共 5 次全部 HTTP 429 `"您的模型请求频率超限，请稍后重试"` | ❌ 缺证据：需等到频率窗口重置后重跑（命令见 §5） |
| `GLM-5.3-Flash / GLM-5.3` | zcode | **无法判定**（渠道=智谱 z.ai，但未出货） | — | `账号在模型 "GLM-5.3-Flash" 上的额度已用尽或没有可用权益（上游返回 200 但没有任何内容，请求未送达模型）` | ❌ 缺证据：等自然日额度重置 |
| `glm-5.3-flashx` 等 34 条 | trae | **无法判定** | — | `Your requests have exceeded the quota. (code=4008)` | ❌ 缺证据：额度耗尽 |
| `fast-model / default-model / balanced-model / primary-model / deep-model` 等 22 条 | workbuddy | **无法判定** | — | `未配置凭据，请先登录` | ❌ 缺证据：账号未登录（**这批角色位 id 是最高价值目标，务必优先补上**） |
| `deepseek-v4.1-flash / hy4free / glm-5.3` | buddy | **无法判定** | — | `未配置凭据，请先登录` | ❌ 缺证据：同上 |
| `glm-5.3-flash / openpangu-2.0-* / kimi-k3` 等 9 条 | codearts | **无法判定** | — | `codearts: model request failed with HTTP 403` | ❌ 缺证据：403（鉴权/权益） |
| 19 条 | lobsterai | **无法判定** | — | `账号已被禁用` | ❌ 缺证据：账号被禁用 |
| `gemini-3.8-flash` | gemini | **无法判定** | — | `渠道网络请求失败（环境代理；ECONNRESET）` | ❌ 缺证据：环境代理不通 |
| `big-pickle / longcat-2.5-free` 等 34 条 | our-free-model | **无法判定** | — | `upstream request failed: Bun worker failed before completing the response.`（两次不同 id 同因） | ❌ 缺证据：免费桶后端 worker 崩了 |
| `auto / qwen3.6-27b` 等 6 条 | freellmapi | **无法判定** | — | `Connection error.` + `127.0.0.1:31415` 未监听 | ❌ 缺证据：本地网关没启动 |

**成功鉴定：5 条**（loomy/GLM-5.3-Flash、loomy/spark-x2.6、loomy/qwen3.8-flash、minimax/MiniMax-M3.1-Flash、minimax/MiniMax-M3），另有 2 条给出中等置信倾向（loomy/auto、loomy/deepseek-v4-flash-1017 判低）。
**无法判定：全部 16 个渠道里 10 个渠道因额度/凭据/网络不可达**（qoder、qodercn、raccoon、zcode、trae、workbuddy、buddy、codearts、lobsterai、gemini、our-free-model、freellmapi、cline 未命中出借清单）。

---

## 4. 最关键的结论

### 4.1 P1 自述不可单独作为证据
同一个 id（`loomy/deepseek-v4-flash-1017`）用**同一个 prompt** 两次拿到两个互斥答案：`DeepSeek/深度求索` 与 `GPT-4/OpenAI`。**自述是系统提示的产物，不是权重的事实**；它可以证明「渠道标注了什么」，不能证明「背后是谁」。→ 判定必须以 P3（usage/分词/缓存）与 P2 的稳定行为分布为主证。

### 4.2 usage 帧是唯一不可演的证据
同一段 125 字符中英混合样本，三个渠道的计数差 40% 以上：

| 渠道/id | inputTokens | 其它 |
| --- | --- | --- |
| loomy/minimax `MiniMax-M3.1-Flash` | **52** | `cacheReadTokens:197`、`reasoningTokens:11` → 有 prompt cache |
| loomy `GLM-5.3-Flash` | **61** | `reasoningTokens:12` |
| loomy `deepseek-v4-flash-1017` | **77** | `reasoningTokens:12` |
| loomy `spark-x2.6` | **78** | 无 reasoningTokens |

口径提醒：`inputTokens` = **系统提示 + 适配器注入 + 样本** 的总和，不是纯分词器差异；但当**同一渠道内**比较时，它可用来给「这个 id 换没换后端」打点。

### 4.3 指令跟随陷阱能分档
P2 的 B 题（恰好 5 个字）是目前唯一分开档位的题：`MiniMax-M3.1-Flash` 给出 `超文本协议`（5 字，守住），而 `GLM-5.3-Flash / spark-x2.6 / deepseek-v4-flash-1017` 都给出 7 字的 `超文本传输协议`（陷阱未守住）。A 题（9.11 vs 9.9）本次**全部**答 9.9，无区分力 —— 保留它只作基线。

### 4.4 阻塞点集中在「额度与凭据」，不是方法
16 个渠道里 12 个的失败都是**可恢复的运营状态**（429 频率、4008 配额、403 权益、未登录、账号禁用、worker 崩、代理 ECONNRESET），只有 qoder 国际站的 `fetch failed` 更像网络层封锁。方法本身在 5 条可达车道上一次跑通。

---

## 5. 复现命令

```bash
cd E:\06AI\00DeeSeekHarness\dsh-model-orchestrator

# 单点鉴定
node tools/_fingerprint.mjs --provider loomy --model GLM-5.3-Flash

# 批量（本报告的全部批次文件在 _fp/ 下）
node tools/_fingerprint.mjs --batch _fp/batch-a.json --request p1,p2 --max-requests 30 --min-gap-ms 1500 --out _fp/run-a.json

# 换渠道/换凭据来源（参数化，不写死任何 key）
node tools/_fingerprint.mjs --provider X --model Y --endpoint http://127.0.0.1:18326 --token-file /path/to/peer-token
node tools/_fingerprint.mjs --transport direct --base-url https://api.example.com/v1 --api-key-env MY_KEY --provider X --model Y

# 恢复后重跑的高价值目标（额度/频率窗口重置时）
node tools/_fingerprint.mjs --provider raccoon --model sn-glm-5-3-flash --request p1,p2
node tools/_fingerprint.mjs --provider qodercn --model gmodel --request p1,p2
```

---

## 6. 局限与下一步

1. **raccoon / zcode / trae / workbuddy / buddy / our-free-model 需要等额度窗口**：建议次日额度重置后原样重跑 `_fp/batch-a.json`，无需改脚本。
2. **qoder 国际站应先解决网络可达性**（本机对 `api2.qoder.sh` 恒定 `fetch failed`）——这与 pack.js 里既有的注释（`NGHTTP2_INTERNAL_ERROR`）一致，属已知阻塞。
3. **建议补 P4「身份一致性探针」**：同一 id 用 5 个不同措辞问同一件事，看答案的**方差**；方差大 = 自述不可信，方差小 = 渠道系统提示里确实钉了身份。这是本次发现的漂移问题的直接对策。
4. **建议为 P3 建基线表**：在同一渠道内，把每个 id 的 `inputTokens`（固定样本）记录下来，形成指纹档案；id 名字变了但计数没变 = 同一个后端换了名字。
5. **本报告的判定未用于任何配置变更**：不涉及 `src/`、版本号、发布。

---

## 附录：本次请求账目（59 次，逐条可核）

| 批次 | 目标 | 请求数 | 结果 |
| --- | --- | --- | --- |
| 手工 | qoder/qfmodel | 1 | 502 transport |
| probe2 | qodercn/qfmodel、trae/deepseek-v4.1-flash、raccoon/sn-glm-5-3-flash、loomy/GLM-5.3-Flash、zcode/GLM-5.3-Flash、workbuddy/fast-model | 6 | 1 通（loomy） |
| probe3 | codearts、lobsterai、minimax、gemini、buddy、our-free-model、freellmapi、cline、qoder、qodercn、raccoon、trae 各 1 | 12 | 1 通（minimax） |
| batch-a | 16 个目标 × p1,p2 | 24 | 6 通 |
| batch-b | 4 个目标 × p1（加大 token 预算重跑） | 4 | 4 通 |
| batch-c | 3 个目标 × p3 + raccoon × 2 | 5 | 3 通（p3 全成功） |
| batch-d | qodercn/q37fmodel、loomy/qwen3.8-flash、loomy/spark-x2.6 × p1,p3 | 6 | 2 通 |
| single | minimax/MiniMax-M3 × p1 | 1 | 通 |
| **合计** | | **59** | **19 次出货 / 40 次被上游状态挡住** |
