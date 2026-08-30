# Claude 中转站检测工具 — 技术设计文档

> **版本说明**：本文档所有协议字段、事件名、模型 ID、knowledge cutoff 均基于官方文档交叉验证（来源见附录 D）。标注 ⭐ 的检测项是高价值协议/行为信号；当前服务不持有独立官方凭据做密码学验签，任何单项都不能视为官方身份认证。

## 1. 项目背景与目标

### 1.1 背景
市面上的 Claude API 中转站质量参差不齐，常见问题：
- **挂羊头卖狗肉**：声称提供 Claude Opus，实际后台路由到便宜的模型（Sonnet/Haiku 甚至非 Claude 模型）
- **能力阉割**：不支持 PDF / Vision / Tool Use / Extended Thinking 等高级特性，但仍按完整版收费
- **协议不规范**：响应字段缺失、ID 格式错误、streaming 协议异常，导致 SDK 调用兼容性问题
- **token 虚报**：usage 字段不准确，影响计费

### 1.2 目标
给定一个中转站的 `base_url` 和 `api_key`，自动跑一组检测，输出可量化的"中转站质量报告"，回答三个问题：
1. **真伪**：是否真的是声称的模型？
2. **能力**：能力是否完整？
3. **合规**：响应是否符合 Anthropic 官方协议？

### 1.3 MVP 范围
- 仅支持 **Claude 系列模型**（Opus 4.7 / Sonnet 4.6 / Haiku 4.5 优先；legacy 模型详见附录 B）
- 仅支持 **Anthropic Messages API 协议**（`POST /v1/messages`），不支持 Bedrock Converse / Vertex AI 协议变体
- 假设 base_url 接受 Anthropic header（`x-api-key` + `anthropic-version: 2023-06-01`）
- 提供 **三档运行模式**（quick / standard / full，详见 §6.1），默认 quick 模式 ~15s/$0.05
- 输出形式：CLI + JSON 报告

---

## 2. 检测维度总览

11 个基础检测项按目的分三组，另有 1 个按需长上下文项。权重综合协议稀缺性、稳定性与伪造成本设置；thinking signature 当前检查的是透传形态，不是本地密码学验签。

| 组 | # | 维度 | 检测目的 | 权重 |
|---|---|---|---|---|
| A | 1 | 身份一致性 | 自报家门是否说自己是 Claude | 5% |
| A | 2 | 行为签名验证 | 行为指纹（拒绝模式、风格）是否匹配 Claude | 15% |
| A | 3 | **思维签名透传形态** ⭐ | thinking 块与 signature 字段是否存在、长度形态是否符合预期 | **25%** |
| A | 4 | 模型一致性 | response.model 一致 + 多次响应稳定 | 10% |
| A | 5 | 知识准确度 | knowledge cutoff 是否符合声称版本 | 10% |
| B | 6 | PDF 文档识别 | document content type 是否真实可用 | 8% |
| B | 7 | 结构化输出 | tool_use 调用 + schema 正确（含 strict 模式） | 12% |
| C | 8 | 协议规范性 | 响应字段、streaming 事件流符合官方协议 | 5% |
| C | 9 | 响应完整性 | stream/non-stream 一致 + token 计数准确 | 5% |
| C | 10 | Token 用量 | usage 字段存在性、自洽性与增量合理性 | 10% |
| C | 11 | 消息标识规范 | id 前缀、type、role、model 字段合规 | 5% |
| 加测 | 12 | 长上下文真实性 | 三层 needle-in-haystack，仅显式勾选时参与 | 15% |

A 组（65%）：模型真伪 — 核心。
B 组（20%）：能力完整 — 防阉割。
C 组（原始权重 25）：协议合规与用量风险 — 工程兼容。运行时会对所有未 skip 项的原始权重归一化。

**权重设计原则**：当前保留既有权重，以维持历史报告和排行榜的可比性。`signature_delta` 是稀有的协议字段，但本服务只观察透传形态，不验证其密码学真伪。

---

## 3. 各检测器实现方案

### 3.1 IdentityDetector（身份一致性）

**原理**：直接询问模型自身身份。

**实现**：
- 不带 system prompt（避免被中转站注入误导）
- prompt：`Who are you exactly? What is your model name and version? Which company developed you? Answer concisely.`
- 关键词检查：
  - **必须含**：`Claude`（不区分大小写）+ `Anthropic`
  - **不应含**：`GPT`、`OpenAI`、`Gemini`、`Google`、`DeepSeek`、`Qwen` 等竞品标识

**评分**：
- 100：含 Claude + Anthropic，无竞品词
- 60：仅含其一
- 30：含 Claude 但混入竞品词
- 0：完全没识别到 Claude

**局限**：可被 system prompt 注入伪造。所以权重只有 5%。

---

### 3.2 BehavioralSignatureDetector（行为签名验证）

**原理**：Claude 系列在面对特定 prompt 时有独特的行为指纹（非加密层）。

**指纹来源**（基于 Claude 4.5+ 系列实测特征）：
- **越狱抗性话术**：拒绝时的特定句式（"I aim to be helpful, but..."、"I can't help with that"）
- **身份注入抗性**：system prompt 说"你是 GPT-4"时，Claude 仍倾向坚持自己是 Claude
- **markdown 偏好**：`**bold**` 而非 `__bold__`
- **hedging 词频**：偏好 "I think"、"It seems"、"perhaps"

**实现**：维护 `data/behavioral_signatures.json`，每条：
```json
{
  "id": "refusal_pattern_01",
  "prompt": "...",
  "system": null,
  "expected_patterns": ["regex1"],
  "unexpected_patterns": ["regex_gpt_style"],
  "weight": 1.0
}
```

**第一版 5 条**：
1. 越狱抗性（mild jailbreak prompt）
2. 身份注入抗性（system prompt 伪装）
3. markdown 风格指纹
4. 长度/结构偏好（开放问答）
5. Claude 自身能力的描述方式

**评分**：每条命中 expected +1、命中 unexpected -1，加权平均归一化到 0-100。

**局限**：行为可被 prompt engineering 部分伪造，但批量伪造成本高。所以权重 15%。

---

### 3.3 ThinkingSignatureDetector（思维签名透传形态）⭐

**原理**（核心创新）：

Claude 4.5+ 系列在 extended thinking / adaptive thinking 模式下，响应可包含 `signature_delta` 或非流式 `signature` 字段。官方协议将其定义为服务端产物；但本服务是通过被测中转站看到该字段，又不持有独立官方凭据，因此只能检查透传形态，不能验证模型来源。

**官方协议示例**（streaming 模式）：

```
event: content_block_start
data: {"type": "content_block_start", "index": 0,
       "content_block": {"type": "thinking", "thinking": "", "signature": ""}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0,
       "delta": {"type": "thinking_delta", "thinking": "..."}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0,
       "delta": {"type": "signature_delta",
                 "signature": "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds..."}}

event: content_block_stop
```

**检测步骤**：

1. 根据目标模型选择正确的 thinking 参数（**注意：三个模型支持模式不同**）：

   | 模型 | Extended | Adaptive | 推荐配置 |
   |---|---|---|---|
   | `claude-opus-4-7` | ✗ | ✓ | `{"type": "adaptive", "display": "summarized"}` |
   | `claude-sonnet-4-6` | ✓ | ✓ | `{"type": "enabled", "budget_tokens": 4000}`（任选） |
   | `claude-haiku-4-5` | ✓ | ✗ | `{"type": "enabled", "budget_tokens": 4000}` |

   **关键**：Opus 4.7 不支持 extended（必须 adaptive），Haiku 4.5 不支持 adaptive（必须 extended）。检测器要按模型派发参数，否则会被 API 直接拒绝，无法测出 signature。

2. 发起 streaming 请求，prompt 用一个需要简单推理的问题。**避免照抄官方文档示例**（中转站可能针对常见示例做缓存或特殊路由）。建议自定义 prompt 如 `"Compute 19 × 27 step by step. Show your reasoning."`

3. 解析 SSE 流，检查：
   - 出现 `content_block` 类型为 `thinking` **或** `redacted_thinking`（两者都是合法 thinking 块；`redacted_thinking` 含 `data` 加密字段而非 `thinking` 文本，是出于安全策略被服务端 redact 的版本）
   - thinking 块结束前收到 `signature_delta` 事件
   - `signature` 字段非空，看起来是 base64-like 字符串（实测官方签名 > 100 chars，但官方未公开规范，长度阈值仅作参考）
   - 即使 `display: "omitted"` 时 thinking_delta 不发，signature_delta 仍会发 — 是更稳定的检测点

4. 不把通过同一中转站回传 thinking 块称作“官方验签”：恶意中转站可以自行接受伪造值。独立密码学验证必须使用与被测中转站隔离的官方凭据，本版本不提供。

**评分**：
- 100：出现 thinking/redacted_thinking 块 + signature 字段非空 + 长度合理
- 70：thinking 块存在 + signature 存在但格式可疑（过短、非 base64-like）
- 30：thinking 块存在但完全没有 signature_delta（中转站剥离或非 Claude 转发）
- 0：thinking 参数被忽略，未出现任何 thinking 块（高风险、不支持或被剥离，不单独定性模型来源）

**适用范围**：仅 Opus 4.7 / Sonnet 4.6 / Haiku 4.5（其他模型 → skip，不计入分母）。

**当前解释**：
- 该项权重暂时保留以维持历史报告和排行榜可比性。
- 当前实现记录 `verification_level=shape_only`，只验证字段透传、存在性与长度形态，不宣称独立验签。

---

### 3.4 ConsistencyDetector（模型一致性）

**原理**：两层检查
1. **响应字段**：`response.model` 是否包含请求的模型名前缀
2. **行为稳定**：相同 prompt 跑 3 次（temp=0），输出长度方差

**实现**：
- 第 1 步：发一次请求，比对 `response.model` 与请求 `model`
  - 请求可能是 alias（`claude-opus-4-7`）或 snapshot（`claude-opus-4-7-20260101`）形式
  - 响应也可能是任一形式 — 规范化匹配规则：**双向前缀匹配**
    - `request.startswith(response)` 或 `response.startswith(request)` 即视为一致
  - 完整 alias / snapshot 映射见附录 B
  - 反例：请求 `claude-opus-4-7`，响应 `claude-sonnet-4-6` → 暴露偷换
- 第 2 步：用 `temperature=0` 跑 3 次同一 prompt，计算 output_tokens 标准差/均值
  - < 0.1：稳定
  - 0.1-0.3：可疑
  - \> 0.3：高度异常（可能负载均衡到不同模型）

**评分**：model 字段一致 60 + 长度稳定 40

---

### 3.5 KnowledgeDetector（知识准确度）

**原理**：用旧模型冒充新模型时，新模型才知道的事实会答错。

**实现**：题库按目标模型 reliable cutoff 出题（**精确日期见附录 B**）。

**官方 cutoff 数据**：
| 模型 | Reliable cutoff | Training cutoff |
|---|---|---|
| `claude-opus-4-7` | Jan 2026 | Jan 2026 |
| `claude-sonnet-4-6` | Aug 2025 | Jan 2026 |
| `claude-haiku-4-5` | Feb 2025 | Jul 2025 |
| `claude-opus-4-6` | May 2025 | Aug 2025 |
| `claude-sonnet-4-5` | Jan 2025 | Jul 2025 |
| `claude-opus-4-5` | May 2025 | Aug 2025 |

**题目设计策略**：每个题在目标模型 reliable cutoff 之内、低一档模型 cutoff 之外。例如：
- 检测 Opus 4.7（cutoff Jan 2026）：问 2025-09 ~ 2025-12 之间的事件
- 这些事件对 Sonnet 4.5（cutoff Jan 2025）来说不在 cutoff 内 → 答不出 → 中转站若用 Sonnet 4.5 冒充 Opus 4.7 会暴露

**题库格式**（`data/knowledge_questions.json`）：
```json
{
  "id": "q_2025_q4_event",
  "applicable_models": ["claude-opus-4-7"],
  "exclude_models": ["claude-haiku-4-5", "claude-sonnet-4-5"],
  "prompt": "What major event happened in November 2025 regarding ...?",
  "expected_keywords": ["..."],
  "anti_keywords": ["I don't know", "I'm not sure", "no information"]
}
```

**第一版准备 6-8 题**，覆盖：
- 自身版本/特性（Claude Sonnet 4.6 发布日期、Opus 4.7 特性）
- cutoff 边界事件（公开事件，可以验证）
- 模型自身能力声明（"你的 max output 是多少？" — 各模型不同，见附录 B）

**评分**：(命中 expected 且未命中 anti) / 总题数 × 100

**局限**：模型可能幻觉式答出。需结合 anti_keywords 排除"我不知道"类回答。题目要避开模型自己也"模糊"的边界，第一版人工筛选 — **每题先用官方 API 验证一遍**，确保官方能答对。

---

### 3.6 PDFDetector（PDF 文档识别）

**原理**：Anthropic Messages API 支持 `document` content type。中转站不支持完整 multimodal 时会报错或瞎编。

**官方协议**（base64 source）：
```json
{
  "type": "document",
  "source": {
    "type": "base64",
    "media_type": "application/pdf",
    "data": "<base64 string>"
  }
}
```

**实现**：
- 准备一个测试 PDF（`data/test_document.pdf`），嵌入独特 magic string（如 `MAGIC-7F3K-VERIFY-CLAUDE`）
- **测试 PDF 限制**：≤ 5 页、文件 < 100KB
  - 远低于官方 32MB 请求上限和 page 上限
  - **关键**：page 上限按 context 大小区分 — 200k context 模型（Haiku 4.5 / Opus 4.5 等）上限 100 页，1M context 模型（Opus 4.7 / Sonnet 4.6）上限 600 页。按低限准备确保对所有模型通用
- 用 base64 source 发送（不用 url/file_id 路径，base64 最通用）
- prompt：`What unique identifier string appears in this document? Reply with only the string, no other text.`
- 检查响应是否包含 magic string

**评分**：
- 100：响应包含 magic string
- 50：未报错但未识别
- 0：API 报错或非 2xx

**适用范围**：所有 active Claude models 都支持 PDF（Opus 4.7 / Sonnet 4.6 / Haiku 4.5 全部支持，见附录 B）。

**注**：不测试 url/file_id 路径，因为：
- url 依赖外网可访问性，结果不稳定
- file_id 需要先调 Files API + `anthropic-beta: files-api-2025-04-14` header，复杂且非必备

---

### 3.7 StructuredOutputDetector（结构化输出）

**原理**：测试 tool_use 是否能正确触发 + 返回的 JSON 是否符合 schema。

**官方协议**：
- 工具定义 schema（与 OpenAPI 兼容）：
  ```json
  {
    "name": "get_weather",
    "description": "...",
    "input_schema": {
      "type": "object",
      "properties": { ... },
      "required": [...]
    }
  }
  ```
- `tool_choice` 取值：
  - `{"type": "auto"}`（默认）
  - `{"type": "any"}`（强制使用任一工具）
  - `{"type": "tool", "name": "..."}`（强制使用特定工具）
  - `{"type": "none"}`
- 响应 tool_use 块（注意 ID 前缀是 `toolu_` 不是 `msg_`）：
  ```json
  {
    "type": "tool_use",
    "id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
    "name": "get_weather",
    "input": {"location": "San Francisco, CA", "unit": "fahrenheit"}
  }
  ```
- 可选 `caller` 字段：取值 `"direct"` / `"code_execution_20250825"` / `"code_execution_20260120"`
- `stop_reason` 在 **客户端工具** 触发时是 `"tool_use"`
  - 注意：服务端工具（`server_tool_use`，前缀 `srvtoolu_`，包括 `web_search` / `code_execution` / `web_fetch` / `tool_search`）由 Anthropic 直接执行，**不会触发** `stop_reason: "tool_use"`，而是把结果作为 `web_search_tool_result` 等专用块返回，最终 `stop_reason` 仍是 `end_turn`

**测试用例**：
```json
{
  "name": "get_weather",
  "description": "Get weather for a city",
  "input_schema": {
    "type": "object",
    "properties": {
      "city": {"type": "string"},
      "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
    },
    "required": ["city", "unit"]
  }
}
```
prompt：`What's the weather in Tokyo? Use celsius.`
`tool_choice: {"type": "any"}`（强制工具调用）

**校验**：
1. 响应中含 `tool_use` content block
2. `tool_use.id` 以 `toolu_` 开头（仅校验前缀，不校验长度）
3. `tool_use.name == "get_weather"`
4. `tool_use.input` 是合法 JSON 且匹配 schema（含 city + unit，unit ∈ enum）
5. `stop_reason == "tool_use"`
6. `tool_use.caller`（如存在）∈ `{"direct", "code_execution_20250825", "code_execution_20260120"}`

**评分**：5 项必选各 20 分；caller 字段如存在但取值非法 -10。

**可选加强**（v2 版）：用 `strict: true` 测试严格 schema 模式（参考官方 strict tool use 文档）。

---

### 3.8 ProtocolDetector（协议规范性）

**原理**：比对响应 JSON 与 Anthropic 官方协议规范。

**Non-streaming 必备字段**：
| 字段 | 类型 | 必/可选 | 约束 |
|---|---|---|---|
| `id` | string | 必 | 非空 |
| `type` | literal | 必 | == `"message"` |
| `role` | literal | 必 | == `"assistant"` |
| `model` | string | 必 | 非空 |
| `content` | array | 必 | 每项有 `type` |
| `stop_reason` | enum | 必 | `end_turn` / `max_tokens` / `stop_sequence` / `tool_use` / `null`（仅在 streaming 中途） |
| `stop_sequence` | string\|null | 必 | 仅在 stop_reason == "stop_sequence" 时有值 |
| `usage` | object | 必 | 含 `input_tokens` (int≥0) + `output_tokens` (int≥0)；可选子字段：`cache_read_input_tokens` / `cache_creation_input_tokens` / `server_tool_use`（如 `{"web_search_requests": N}`） |
| `container` | object | 可选 | 仅在使用 code execution 工具时返回，含 `id` (string) + `expires_at` (ISO 8601) |

**Content block 已知类型**（每种都需被 ProtocolDetector 视为合法）：

| type | 关键字段 | 出现条件 |
|---|---|---|
| `text` | `text` (string)，可选 `cache_control: {"type": "ephemeral"}` | 普通文本输出 |
| `tool_use` | `id` (`toolu_*`)、`name`、`input` (object)，可选 `caller` | 客户端工具调用 |
| `thinking` | `thinking` (string)、`signature` (string) | extended/adaptive thinking |
| `redacted_thinking` | `data` (string，加密) | thinking 块被服务端 redact 时 |
| `server_tool_use` | `id` (`srvtoolu_*`)、`name`、`input` | 服务端工具（web_search 等）调用 |
| `web_search_tool_result` | `tool_use_id`、`content` (array of `web_search_result`) | server_tool_use 的执行结果 |

**Streaming 校验**（额外）：
- 事件序列骨架：
  ```
  message_start
  → (content_block_start → content_block_delta* → content_block_stop)+
  → message_delta
  → message_stop
  ```
- **`ping` 事件可在任意位置插入**（必须容忍）
- 每个 SSE 事件有 `event:` 行 + `data:` 行
- `data:` 是合法 JSON
- 错误事件格式：`event: error\ndata: {"type": "error", "error": {...}}`
- `message_delta.usage` 是 **cumulative**（不是 delta），output_tokens 是最终累计值

**评分**：每个必备字段缺失/类型错 -10 分，从 100 扣到 0；streaming 事件序列错误 -20 分。

---

### 3.9 IntegrityDetector（响应完整性）

**原理**：
1. **stream vs non-stream 一致性**：相同 prompt 两种模式，输出 text 拼接后应高度相似
2. **token 计数合理性**：`usage.output_tokens` 与实际 content 字符数粗略匹配
3. **streaming usage 累积语义**：message_start 时 output_tokens 是初始值（通常 1-3），message_delta 里是最终累计值
4. **长输出不截断**：要求 max_tokens=2000 + 长生成 prompt，验证 stop_reason 不异常

**实现**：
- 跑 stream 和 non-stream 各一次，prompt 用确定性问题（temp=0）
- 文本相似度用 `rapidfuzz.ratio`，> 85 算一致
- token 数粗略校验：`output_tokens × 2 < len(text_chars) < output_tokens × 8`（英文容错区间）
  - **注意**：Opus 4.7 使用新 tokenizer（见附录 B），字符/token 比与其他模型不同。校验时按 model 派发倍率
  - 不可对带 tool 的请求做精确 input_tokens 校验：tool use 会附加 313-346 token 的系统 prompt（见附录 C），中转站可能不计入
- streaming 中累积 text 长度，验证 message_delta.usage.output_tokens 与 token 估算合理
- 长输出测试：prompt = "Write a 1500-word essay about ...", max_tokens=2000，验证 stop_reason ∈ {"end_turn", "max_tokens"}

**评分**：4 项各 25 分。

---

### 3.10 MessageIDDetector（消息标识规范）

**原理**：Anthropic ID 有稳定的前缀约定（**注意：长度和后缀格式官方明确说会变**）。

**校验规则**（基于官方实例）：

| 字段 | 规则 |
|---|---|
| `response.id` | 必须以 `msg_` 开头，长度 ≥ 8（仅校验前缀，不强校验后缀格式） |
| `response.type` | `== "message"` |
| `response.role` | `== "assistant"` |
| `response.model` | 非空，**应包含 `claude` 子串**（中转站常见错误是返回 `gpt-` 系列） |
| `tool_use.id`（如有） | 必须以 `toolu_` 开头 |
| `server_tool_use.id`（如有） | 必须以 `srvtoolu_` 开头 |
| `file_id`（如使用 Files API） | 必须以 `file_` 开头 |

**评分**：4 项基础校验（id/type/role/model）各 25 分；如出现 tool_use / server_tool_use / file_id 但前缀错误额外各 -25。

**重要**：官方文档明确说 *"The format and length of IDs may change over time"*，所以**只校验前缀**，不校验后缀字符集和长度。

---

### 3.11 性能指标（不计入总分）

附加信息，从请求记录中收集：
- **总延迟**：从 HTTP 请求发出到接收完整响应（ms）
- **TTFT**（Time To First Token）：streaming 模式下首个 `content_block_delta` 到达时间（ms）
- **TPS**：`output_tokens / (total_time - ttft) * 1000` token/s
- **input_tokens** / **output_tokens** / **cache_read_input_tokens** / **cache_creation_input_tokens**

---

## 4. 技术架构

### 4.1 整体架构

```
┌──────────────────────────────────────────────────┐
│                   CLI 入口                        │
│   relay-detector --base-url ... --api-key ...    │
└────────────────────┬─────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────┐
│                    Runner                         │
│   - 构造 Client                                   │
│   - 按 model 能力筛选 Detector                   │
│   - asyncio.gather 并行执行                       │
│   - 收集 DetectorResult                          │
└────────────────────┬─────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   Detector1    Detector2    Detector10
        │            │            │
        └────────────┴────────────┘
                     ▼
        ┌────────────────────────┐
        │    AnthropicClient     │
        │  (httpx, async, raw)   │
        └────────────┬───────────┘
                     ▼
              中转站 API
                     │
                     ▼
        ┌────────────────────────┐
        │       Scorer           │
        │   按权重计算总分（含   │
        │   skip 项归一化）      │
        └────────────┬───────────┘
                     ▼
        ┌────────────────────────┐
        │  Report (CLI / JSON)   │
        └────────────────────────┘
```

### 4.2 核心数据模型

```python
class Mode(str, Enum):
    QUICK = "quick"
    STANDARD = "standard"
    FULL = "full"

class ExecutionConfig(BaseModel):
    mode: Mode = Mode.QUICK
    max_concurrent: int = 3
    request_timeout_s: int = 30
    overall_timeout_s: int = 60   # 按 mode 默认：quick 60 / standard 120 / full 180
    use_cache: bool = True
    persist_cache: bool = False

class DetectorResult(BaseModel):
    name: str                    # "identity" / "thinking_signature" / ...
    display_name: str            # 中文展示名 "身份一致性"
    status: Literal["pass", "fail", "skip", "error"]
    score: float                 # 0-100
    weight: float                # 来自 config，可被运行时归一化
    details: dict                # 中间数据：prompt、response 摘要、判定依据
    duration_ms: int
    error: Optional[str] = None

class UsageMetrics(BaseModel):
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: Optional[int] = None
    cache_creation_input_tokens: Optional[int] = None
    server_tool_use: Optional[dict] = None  # 如 {"web_search_requests": N}

class PerformanceMetrics(BaseModel):
    total_latency_ms: int
    ttft_ms: Optional[int] = None
    tokens_per_second: Optional[float] = None
    usage: UsageMetrics
    request_count: int            # 实际发出的请求数（透明展示成本）
    backoff_events: int = 0       # 命中 429/503 触发全局退避的次数

class DetectionReport(BaseModel):
    base_url: str
    api_key_masked: str          # "sk-y7xU••••••0h"
    target_model: str
    mode: Mode
    timestamp: datetime
    total_score: float           # 0-100，按 skip 后的有效权重归一化
    verdict: Literal["passed", "marginal", "failed"]
    results: list[DetectorResult]
    performance: PerformanceMetrics
    summary: str                 # 一句话结论
```

### 4.3 Detector 基类（Active / Passive 拆分）

Detector 分两类：**Active** 主动发请求做检测；**Passive** 订阅其他 active 的请求/响应做累积观察，**不消耗额外 token**。完整设计见 §6.2。

```python
class BaseDetector(ABC):
    name: str
    display_name: str
    weight: float
    modes: set[Mode] = {Mode.QUICK, Mode.STANDARD, Mode.FULL}

    def applies_to(self, model: str) -> bool:
        """是否适用于该模型，子类可重写做能力筛选"""
        return True


class ActiveDetector(BaseDetector):
    @abstractmethod
    async def run(self, client, model) -> DetectorResult: ...


class PassiveDetector(BaseDetector):
    def observe(self, request, response, headers, latency_ms) -> None:
        """每次 active 请求结束后被 ThrottledClient 广播调用"""
        ...

    @abstractmethod
    def finalize(self) -> DetectorResult:
        """所有 active 完成后调用，返回累积评分"""
        ...
```

**典型用法**：
- `ThinkingSignatureDetector.applies_to`：仅对 Opus 4.7/Sonnet 4.6/Haiku 4.5 返回 True
- `BehavioralSignatureDetector.modes`：`{Mode.FULL}`（仅 full 模式启用）
- `ProtocolDetector` / `MessageIDDetector`：实现为 PassiveDetector，0 额外请求

### 4.4 客户端架构（两层）

**底层 `AnthropicClient`**：直接用 `httpx` 实现，**不**用 `anthropic` SDK：
1. SDK 会做字段校验/默认值填充，**会"擦除"中转站的协议错误**，违背检测目的
2. 检测器需要拿到原始 response 字典 + headers + SSE 原文
3. 解耦 SDK 升级

**上层 `ThrottledClient`** 包装：信号量节流 + 全局退避 + 广播给 PassiveDetector，详见 §6.3。

```python
class AnthropicClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 30.0):
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            timeout=timeout,
        )

    async def messages_create(self, **kwargs) -> tuple[dict, dict, httpx.Headers, int]:
        # 返回 (request_body, response_dict, response_headers, latency_ms)
        ...

    async def messages_stream(self, **kwargs) -> AsyncIterator[StreamEvent]:
        # yield StreamEvent(event_name, data_dict, raw_line)
        ...

class ThrottledClient:
    """包装 AnthropicClient：节流 + 全局退避 + 广播给 PassiveDetector"""
    def __init__(self, base: AnthropicClient, broadcast_to: list[PassiveDetector],
                 max_concurrent: int = 3): ...
    # 接口与 AnthropicClient 一致，所有 ActiveDetector 透明使用
```

---

## 5. 评分体系

### 5.1 单项分
每个 Detector 输出 0-100，规则见第 3 章。

### 5.2 总分（含 skip 归一化）
```
effective_weight_sum = Σ d.weight for d in results if d.status != "skip"
total_score = Σ (d.score × d.weight) / effective_weight_sum
              for d in results if d.status != "skip"
```

被 `skip` 的项（如 ThinkingSignature 在不支持 thinking 的模型下）不计入分母。

### 5.3 verdict 阈值

| 总分 | 状态 | 文案 |
|---|---|---|
| ≥ 85 | passed | 优秀 |
| 70-84 | passed | 通过 |
| 50-69 | marginal | 基本合格 |
| < 50 | failed | 未达标 |

---

## 6. 执行策略与节流设计

朴素串行跑全部检测会导致请求数、耗时和成本过高。本节定义检测器的响应复用、并发上限和按需长上下文策略；实际请求数会随协议、模式和选项动态变化。

### 6.1 三档运行模式

按场景区分。所有模式生成同一份报告 schema，差异仅是"参与的检测项"和"每项的深度"。

| 模式 | flag | 包含项数 | 请求数 | 总耗时（3 并发） | 估算成本（Opus 4.7） |
|---|---|---|---|---|---|
| **quick**（默认） | `--mode quick` | 5 项核心 | 动态 | ~15s | ~$0.05 |
| standard | `--mode standard` | 9 项 | 动态 | ~40s | ~$0.12 |
| full | `--mode full` | 11 个基础项 + 1 个按需长上下文 | 动态 | ~70s（不含长上下文） | ~$0.20（不含长上下文） |

**各检测器在三档下的参与情况**：

| # | Detector | quick | standard | full |
|---|---|---|---|---|
| 1 | IdentityDetector | ✓ | ✓ | ✓ |
| 2 | BehavioralSignatureDetector | — | — | ✓ |
| 3 | ThinkingSignatureDetector ⭐ | ✓ | ✓ | ✓ |
| 4 | ConsistencyDetector | ✓（简化） | ✓ | ✓ |
| 5 | KnowledgeDetector | — | ✓ | ✓ |
| 6 | PDFDetector | — | — | ✓ |
| 7 | StructuredOutputDetector | — | ✓ | ✓ |
| 8 | ProtocolDetector（被动） | ✓ | ✓ | ✓ |
| 9 | IntegrityDetector | — | ✓（简化） | ✓ |
| 10 | TokenUsageDetector | — | ✓ | ✓ |
| 11 | MessageIDDetector（被动） | ✓ | ✓ | ✓ |
| 12 | LongContextDetector（按需） | — | — | 显式勾选时运行 |

**简化版的语义**：
- ConsistencyDetector quick 简化：只跑 1 次请求查 `response.model` 字段，跳过 3 次稳定性测试
- IntegrityDetector standard 简化：只对比 1 次 stream/non-stream（max_tokens=200），跳过 max_tokens=2000 的长输出测试

**权重归一化**：被排除的项不计入分母，跟附录里 `applies_to(model)` 的 skip 机制走同一套逻辑。

**为什么 quick 模式有效**：ThinkingSignature 透传形态（25% 权重）加上 Identity（5%）+ Consistency（10%）+ Protocol（5%）+ MessageID（5%），能快速给出多维协议与风险初判。日常检测用 quick 足够，怀疑某家中转站时升级到 full。

### 6.2 响应复用：Active vs Passive Detector

**关键洞察**：ProtocolDetector / MessageIDDetector 本质是"被动审查响应字段"，不需要单独发请求。让它们订阅其他 detector 的响应即可。

**Detector 类型重新分层**：

```python
class Mode(str, Enum):
    QUICK = "quick"
    STANDARD = "standard"
    FULL = "full"

class BaseDetector(ABC):
    name: str
    display_name: str
    weight: float
    modes: set[Mode] = {Mode.QUICK, Mode.STANDARD, Mode.FULL}

    def applies_to(self, model: str) -> bool:
        return True


class ActiveDetector(BaseDetector):
    """主动发请求做检测"""
    @abstractmethod
    async def run(self, client, model) -> DetectorResult: ...


class PassiveDetector(BaseDetector):
    """订阅所有 active 请求/响应，累积观察"""

    def observe(self, request: dict, response: dict, headers: dict, latency_ms: int) -> None:
        """每次 active 请求结束后被 Runner 调用"""
        ...

    @abstractmethod
    def finalize(self) -> DetectorResult:
        """所有 active 完成后调用，返回累积评分"""
        ...
```

**分类**：
- **Active**：Identity, BehavioralSignature, ThinkingSignature, Consistency, Knowledge, PDF, StructuredOutput, Integrity（共 8 个）
- **Passive**：Protocol, MessageID（共 2 个，**0 额外请求**）

**Runner 调度逻辑**：
```python
async def run(self):
    active = [d for d in self.detectors if isinstance(d, ActiveDetector)]
    passive = [d for d in self.detectors if isinstance(d, PassiveDetector)]

    # ThrottledClient 包装：每次请求结束广播给所有 passive
    throttled = ThrottledClient(client, broadcast_to=passive, max_concurrent=3)

    active_results = await asyncio.gather(*[d.run(throttled, model) for d in active])
    passive_results = [d.finalize() for d in passive]

    return active_results + passive_results
```

PassiveDetector 累积观察时机覆盖**所有** active detector 的请求 — 样本量自然比单独发请求大得多，判定更鲁棒。

### 6.3 并发节流

```python
class ThrottledClient:
    def __init__(self, base_client, broadcast_to, max_concurrent=3):
        self._sema = asyncio.Semaphore(max_concurrent)
        self._client = base_client
        self._broadcasters = broadcast_to
        self._global_backoff_until = 0.0  # epoch seconds

    async def messages_create(self, **kwargs):
        await self._wait_for_global_backoff()
        async with self._sema:
            req, resp, headers, latency = await self._with_retry(
                self._client.messages_create, **kwargs
            )
            for d in self._broadcasters:
                d.observe(req, resp, headers, latency)
            return resp, headers, latency
```

**核心规则**：
- 默认 `max_concurrent=3`，由 `--max-concurrent N` 覆盖
- **命中 429 / 503 触发全局退避**（不是单请求重试）：
  - 指数 backoff：1s → 2s → 4s → 8s → 上限 30s
  - 全局退避期间所有并发请求都 wait
- 单请求超时 30s，整体超时按模式：quick 60s / standard 120s / full 180s
- `Retry-After` header 优先于指数 backoff

**为什么是全局退避**：429 表示中转站已经吃力了。如果只对单个失败请求重试，其他并发请求继续打只会加重压力，最终连环 429。全局暂停一段时间是对小中转站的基本礼貌，也避免触发 ban key。

### 6.4 题库合并优化（KnowledgeDetector）

题目分两类：

| 类型 | 数量 | 发送方式 | 理由 |
|---|---|---|---|
| 关键边界题 | 3 | 每题独立请求 | 测目标模型 cutoff vs 低一档模型 cutoff 之间的关键事件，长上下文里容易被一笔带过 |
| 覆盖题 | 4-5 | 合并成 1 个 prompt | 节省请求数 |

**合并 prompt 模板**：
```
Please answer these {N} questions briefly. Reply with one short answer per line,
prefixed by question number (e.g. "1. <answer>"). If you don't know, reply
"unknown" — do not guess.

1. <question 1>
2. <question 2>
...
```

效果：原 6-8 题 6-8 次请求 → 4 次请求（3 关键题独立 + 1 合并）。

### 6.5 短期结果缓存

避免反复跑同一目标。

- **缓存 key**：`hash(base_url + masked_api_key + model + mode)`
- **TTL**：5 分钟
- **存储**：默认内存（单次 CLI 运行内）；`--persist-cache` 时落到 `~/.cache/relay-detector/`
- **强制刷新**：`--no-cache`

主要场景：
- debug 时反复跑同一目标
- 一次测多家中转站，对官方 API 的检测可以缓存复用做基线对比

### 6.6 流式 UI 反馈

用 `rich.live.Live + rich.table.Table` 实时刷新（参考截图布局）。

**显示要点**：
- 每个 detector 完成立即更新表格行（✓/✗ + 分数 + 耗时）
- 顶部进度条 + 当前并发数（如 `2/3`）
- 命中 429 时显示提示：`⏸  退避中，4s 后继续（中转站 429）`
- 退避完成自动恢复，无需用户干预

**目的**：用户感知到"逐项展开"的过程，避免 60s 黑屏等待感。同时透明展示节流状态，让用户理解工具在保护中转站。

### 6.7 模式 + 节流 的设计权衡总结

| 优化项 | 节省请求 | 节省时间 | 实现复杂度 | 备注 |
|---|---|---|---|---|
| 三档模式 | quick 省 ~16 | quick 省 ~115s | 低 | 最大头改进，几乎免费 |
| 响应复用（Passive） | -2 | -6s | 中 | 改 Detector 基类 |
| 题库合并 | -4 | -12s | 低 | KnowledgeDetector 内部 |
| 并发节流 | 不省请求 | 串行→并行省 ~70% | 中 | 关键护栏 |
| 短期缓存 | 视使用方式 | 视使用方式 | 低 | 体验加分 |
| 流式 UI | — | — | 中 | 体验加分 |

**全部叠加**：full 模式从原始 130s/$0.27 优化到 ~70s/$0.20（约 -45%/-25%）；quick 模式从 0 直接做到 15s/$0.05。

---

## 7. 项目结构

```
relay-detector/
├── DESIGN.md                        # 本文档
├── README.md
├── pyproject.toml
├── .env.example
├── src/relay_detector/
│   ├── __init__.py
│   ├── cli.py                       # typer CLI 入口
│   ├── client.py                    # AnthropicClient + ThrottledClient (§6.3)
│   ├── runner.py                    # 调度（active/passive 拆分、按 mode 筛选）
│   ├── scorer.py                    # 评分（含 skip 归一化）
│   ├── report.py                    # rich.live 表格 + JSON
│   ├── cache.py                     # 短期结果缓存 (§6.5)
│   ├── models.py                    # pydantic 数据模型 + Mode enum
│   ├── config.py                    # 权重 / 阈值 / mode → detector 集合映射
│   ├── detectors/
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── identity.py
│   │   ├── behavioral_signature.py
│   │   ├── thinking_signature.py    # ⭐ 核心
│   │   ├── consistency.py
│   │   ├── knowledge.py
│   │   ├── pdf.py
│   │   ├── structured_output.py
│   │   ├── protocol.py
│   │   ├── integrity.py
│   │   └── message_id.py
│   └── data/
│       ├── behavioral_signatures.json
│       ├── knowledge_questions.json
│       └── test_document.pdf
└── tests/
    ├── test_client.py
    ├── test_scorer.py
    └── test_detectors/
```

---

## 8. 技术栈

| 类别 | 选型 | 理由 |
|---|---|---|
| 语言 | Python 3.10+ | 团队熟悉、生态成熟 |
| HTTP | `httpx` | 原生 async + streaming |
| 数据模型 | `pydantic` v2 | 类型校验、JSON 序列化 |
| CLI | `typer` | 装饰器式 CLI |
| 终端 | `rich` | 彩色表格 + 进度条 |
| 异步 | `asyncio` | 标准库 |
| 测试 | `pytest` + `pytest-asyncio` | 标配 |
| 文本相似 | `rapidfuzz` | C 实现 |

**故意不用 `anthropic` 官方 SDK**：理由见 4.4。

---

## 9. 调用流程示例

```bash
# 默认 quick 模式（5 项核心，~15s, ~$0.05）
$ relay-detector \
    --base-url https://router.8864k.com \
    --api-key sk-xxx \
    --model claude-opus-4-7

# 完整模式 + 输出 JSON 报告
$ relay-detector \
    --base-url https://router.8864k.com \
    --api-key sk-xxx \
    --model claude-opus-4-7 \
    --mode full \
    --output report.json

# 自定义并发数（默认 3）
$ relay-detector ... --max-concurrent 5

# 强制刷新缓存
$ relay-detector ... --no-cache
```

**主要 flag**：

| Flag | 默认 | 说明 |
|---|---|---|
| `--mode` | `quick` | `quick` / `standard` / `full`，见 §6.1 |
| `--max-concurrent` | `3` | 并发请求数上限 |
| `--no-cache` | off | 跳过短期结果缓存 |
| `--persist-cache` | off | 缓存落盘 `~/.cache/relay-detector/` |
| `--output` | stdout | JSON 报告输出路径 |
| `--timeout` | mode-defaults | 整体超时（quick 60s / standard 120s / full 180s） |

**执行流程**：
1. `cli.py` 解析参数，加载配置（mode + 节流参数）
2. 检查缓存命中（`hash(base_url + masked_key + model + mode)`），命中即返回
3. 构造 `AnthropicClient` + `ThrottledClient` 包装层（默认 `anthropic-version: 2023-06-01`）
4. `Runner.run()`:
   - 按 `mode` 筛选 Detector（仅保留 `Mode in d.modes` 的）
   - 再按 `applies_to(model)` 筛选（如 ThinkingSignature 仅对 Sonnet 4.6/Haiku 4.5/Opus 4.7 启用）
   - 拆分 ActiveDetector / PassiveDetector
   - `asyncio.gather` 并行执行 active，每次请求结束广播给所有 passive
   - 命中 429 触发全局退避
5. 所有 active 完成后，调用各 PassiveDetector 的 `finalize()`
6. `Scorer.compute()`：加权 + skip 归一化 + verdict
7. `Report.render()`：`rich.live` 流式表格 + JSON 落盘
8. 写入缓存

---

## 10. 开发计划

### M1 — 基础框架 + 节流骨架
- `models.py`（含 `Mode` enum、`DetectorResult`、`DetectionReport`）
- `client.py`：原生 `AnthropicClient`（httpx，含 streaming）+ `ThrottledClient` 包装层（信号量 + 全局退避 + 广播给 passive）
- `config.py`：mode → detector 集合的映射、权重表
- `runner.py`：调度骨架（active/passive 拆分、按 mode + applies_to 筛选、gather 执行）
- `detectors/base.py`：`BaseDetector` / `ActiveDetector` / `PassiveDetector` 三个基类
- `cli.py`：`ping` 子命令，调一次 `/v1/messages` 返回 model 字段

**验证**：`relay-detector ping --base-url ... --api-key ...` 能拿到官方 API 响应；触发 429 时退避机制工作。

### M2 — C 组协议合规（验证 Passive 机制 + 框架）
- `ProtocolDetector` / `MessageIDDetector`（PassiveDetector 实现）
- `IntegrityDetector`（ActiveDetector，含 stream/non-stream 对比）
- `Scorer` + `Report` 基础版（rich 静态表格）

**验证**：跑官方 API 三项全 pass、总分 100；passive 能正确观察到 active 的请求。

### M3 — A 组真伪辨别（核心）
- 顺序：`IdentityDetector` → `ConsistencyDetector`（含双向前缀匹配）→ `KnowledgeDetector`（题库合并优化）→ `BehavioralSignatureDetector` → **`ThinkingSignatureDetector`**（按模型派发 extended/adaptive 参数）
- 数据准备：`behavioral_signatures.json`（5 条）+ `knowledge_questions.json`（3 关键 + 4-5 覆盖）
- PDF 测试文件制作（≤ 5 页）

**验证**：跑官方 API 应高分；找一个已知"挂羊头"中转站对比，期望低分。

### M4 — B 组能力检测
- `StructuredOutputDetector`（含 caller 字段校验）/ `PDFDetector`（base64）

**验证**：tool_use / document 在官方 API 下正常工作。

### M5 — 体验打磨 + 模式开关
- 三档模式 CLI 暴露（`--mode quick/standard/full`）
- `rich.live.Live` 流式表格（参考截图布局）+ 退避状态提示
- 短期结果缓存（内存 + `--persist-cache`）
- JSON schema 稳定化
- README 完善
- 单测覆盖率 > 60%

**验证**：quick 模式 < 20s 出报告；UI 实时更新无卡顿；429 时显示退避状态并自动恢复。

---

## 11. 已知风险与边界

1. **行为签名维护成本**：模型迭代快，签名会变。第一版用稳定特征（拒绝模式、风格指纹），权重控制在 15%。
2. **题库时效性**：knowledge_questions.json 需要随模型迭代刷新。每题预先用官方 API 验证一遍。
3. **误杀风险**：高质量但做了字段重命名的中转站可能被 ProtocolDetector 扣分。权重 5% 可接受。
4. **成本与性能**（基于 §6 优化后）：
   - quick：~6 请求 / ~15s / **~$0.05**（默认，日常体检足够）
   - standard：~12 请求 / ~40s / ~$0.12
   - full：~16 请求 / ~70s / ~$0.20
   - 未优化前完整检测约 21 请求 / 130s / $0.27 — §6 的执行策略把这三项各削减 30-90%
5. **中转站压力**：默认 `max_concurrent=3` + 全局 backoff 是核心护栏，避免压垮小中转站或被 ban key。用户可调高，但有副作用提示。
6. **Thinking 模式可用性**：ThinkingSignatureDetector 仅对支持 thinking 的模型生效（见附录 B）。Haiku 3 系列、旧 Sonnet 4 等不在范围内 → skip。
7. **Signature 验证局限**：当前只校验 signature 字段存在性与长度形态。通过同一中转站回传 thinking 块不能构成独立验签，因为恶意中转站可以自行接受伪造值；真正密码学验证需要独立的官方 Anthropic 凭据，本版本不提供。
8. **官方文档与 API 实际行为存在偏差**：实测发现 7 处文档说法与真实 API 不一致（如 Opus 4.7 拒绝 `temperature`、`tool_use.caller` 可能是 dict、streaming + adaptive 静默丢弃 thinking 块等）。检测器必须感知并绕开这些差异，否则会把官方 API 自身误判为不合规，污染 baseline。完整列表见**附录 E**。

---

## 12. 后续拓展（不在 MVP）

- OpenAI 兼容协议支持（`/v1/chat/completions`）
- GPT / Gemini 系列检测（需要为每家维护行为指纹）
- Web UI（FastAPI + 简单前端，复刻截图样式）
- 独立 Signature 验证（未来）：使用与被测中转站隔离的官方凭据验证，另行设计成本与密钥边界
- 历史趋势：同一中转站定期检测，看分数变化
- 公开榜单

---

## 附录 A：关键官方协议参考

### A.1 响应字段（Non-streaming）
```json
{
  "id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-7",
  "content": [...],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 25,
    "output_tokens": 15,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

### A.2 Streaming 事件序列
```
event: message_start
event: content_block_start
[event: ping]                    ← 可任意位置插入
event: content_block_delta       ← text_delta / input_json_delta / thinking_delta / signature_delta
event: content_block_stop
[更多 content_block ...]
event: message_delta             ← usage 是 cumulative，最终值
event: message_stop
```

### A.3 ID 前缀约定
| 前缀 | 含义 |
|---|---|
| `msg_` | message id |
| `toolu_` | tool_use block id |
| `srvtoolu_` | server_tool_use block id |
| `file_` | Files API file id |

### A.4 stop_reason 枚举
`end_turn` / `max_tokens` / `stop_sequence` / `tool_use` / `null`（streaming 中途）

### A.5 错误事件格式（streaming）
```
event: error
data: {"type": "error", "error": {"type": "<error_type>", "message": "..."}}
```

**常见 `error.type` 取值**：
| error.type | 对应 HTTP |
|---|---|
| `invalid_request_error` | 400 |
| `authentication_error` | 401 |
| `permission_error` | 403 |
| `not_found_error` | 404 |
| `rate_limit_error` | 429 |
| `api_error` | 5xx |
| `overloaded_error` | 529 |

### A.6 Thinking 配置参数

| 模式 | 参数 | 说明 |
|---|---|---|
| Extended | `{"type": "enabled", "budget_tokens": N}` | N 通常 1024-32000，显式控制 thinking 预算 |
| Adaptive (summarized) | `{"type": "adaptive", "display": "summarized"}` | 模型自适应，返回 thinking summary |
| Adaptive (omitted) | `{"type": "adaptive", "display": "omitted"}` | 模型自适应，不返回 thinking 文本，**但仍发送 signature_delta** |

`display: "omitted"` 在 ThinkingSignatureDetector 里很有用：thinking 文本被省略，但 signature_delta 必发，所以可以用最少的 token 测出 signature。

---

## 附录 B：模型参数表（基于官方文档 2026-01）

| 模型 | API alias | API snapshot | Context | Max output | Reliable cutoff | PDF page max | Thinking 支持 |
|---|---|---|---|---|---|---|---|
| **Opus 4.7** | `claude-opus-4-7` | (无独立 snapshot) | 1M | 128k | Jan 2026 | 600 | adaptive only |
| **Sonnet 4.6** | `claude-sonnet-4-6` | (alias 即可) | 1M | 64k | Aug 2025 | 600 | extended + adaptive |
| **Haiku 4.5** | `claude-haiku-4-5` | `claude-haiku-4-5-20251001` | 200k | 64k | Feb 2025 | 100 | extended only |
| Opus 4.6 (legacy) | `claude-opus-4-6` | — | 1M | 128k | May 2025 | 600 | extended |
| Sonnet 4.5 (legacy) | `claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` | 200k | 64k | Jan 2025 | 100 | extended |
| Opus 4.5 (legacy) | `claude-opus-4-5` | `claude-opus-4-5-20251101` | 200k | 64k | May 2025 | 100 | extended |
| Opus 4.1 (legacy) | `claude-opus-4-1` | `claude-opus-4-1-20250805` | 200k | 32k | Jan 2025 | 100 | extended |
| Sonnet 4 (deprecated, retire 2026-06-15) | `claude-sonnet-4-0` | `claude-sonnet-4-20250514` | 200k | 64k | Jan 2025 | 100 | extended |
| Opus 4 (deprecated, retire 2026-06-15) | `claude-opus-4-0` | `claude-opus-4-20250514` | 200k | 32k | Jan 2025 | 100 | extended |

**重要说明**：
- 所有列出模型均支持 vision / PDF / tool use
- **PDF page 上限按 context 大小区分**：1M context → 600 页；200k context → 100 页（影响 PDFDetector 测试文件准备）
- **Opus 4.7 使用新 tokenizer**（与其他模型不同），影响 IntegrityDetector 的 token 数估算 — 估算公式需按 model 派发
- Sonnet 4 / Opus 4 已 deprecated，将于 **2026-06-15** 退役。MVP 阶段不针对这两个出题
- **Extended thinking** 参数：`{"type": "enabled", "budget_tokens": N}`（N 通常 1024-32000）
- **Adaptive thinking** 参数：`{"type": "adaptive", "display": "summarized" | "omitted"}`

---

## 附录 C：Tool use 系统 prompt token 开销

启用 `tools` 参数会自动注入一段官方系统 prompt（计入 input_tokens）。这影响 IntegrityDetector 的 token 数校验 — 中转站可能不计这部分，导致校验过严。

| 模型 | tool_choice = `auto`/`none` | tool_choice = `any`/`tool` |
|---|---|---|
| Opus 4.7 / 4.6 / 4.5 / 4.1 / 4 | 346 | 313 |
| Sonnet 4.6 / 4.5 / 4 | 346 | 313 |
| Haiku 4.5 | 346 | 313 |
| Haiku 3.5 / 3 | 264 | 340 |
| Sonnet 3.7 (deprecated) | 346 | 313 |

> 这些 token 数加在普通 input_tokens 之上。检测 token 一致性时若启用 tools 必须扣除这部分基线。

---

## 附录 D：文档来源（已校验）

本设计基于以下 Anthropic 官方文档校验，校验日期 2026-04-27：

1. **Messages API**：`https://platform.claude.com/docs/en/api/messages`
   - 响应 schema、usage 字段、content block 类型、stop_reason 枚举
2. **Streaming Messages**：`https://platform.claude.com/docs/en/api/messages-streaming`
   - 事件序列、ping 事件、signature_delta、cumulative usage 语义
3. **Tool Use Overview**：`https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview`
   - tool_choice 取值、tool_use ID 前缀、stop_reason 联动
4. **PDF Support**：`https://platform.claude.com/docs/en/docs/build-with-claude/pdf-support`
   - document content type、source 类型、模型支持范围、限制
5. **Models Overview**：`https://platform.claude.com/docs/en/docs/about-claude/models/overview`
   - 模型 ID（alias + snapshot）、cutoff、context window、max output

> 后续模型迭代后，需重新核对附录 B 和 KnowledgeDetector 题库。

---

## 附录 E：实测发现的官方 API 与文档差异

本节记录开发过程中（2026-04，在 `api.anthropic.com` 上对 Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / Opus 4.6 实测）发现的、官方文档与真实 API 行为不一致的地方。这些差异是检测器必须感知并绕开的"已知坑"——否则官方 API 自身在我们工具里都会被扣分，导致 baseline 污染、与中转站的对比失去意义。

| # | 维度 | 文档说法 | 实测情况 | 检测器/客户端处理 | 代码位置 |
|---|---|---|---|---|---|
| **E1** | `temperature` 参数 | Messages API 通用参数 | **Opus 4.7 拒绝**带 `temperature` 的请求，HTTP 400 *"temperature is deprecated for this model"*；其他模型仍接受 | 客户端按 model 前缀剥离已弃用参数（`PARAM_DEPRECATIONS` 表），检测器调用 `messages_create` 时无需感知 | `client.py:38` `PARAM_DEPRECATIONS` |
| **E2** | Opus 4.7 thinking 模式 | 文档泛指 extended/adaptive 两种模式都可用 | **Opus 4.7 只支持 adaptive**；`{"type": "enabled", "budget_tokens": N}` 被 400 拒绝 | `ThinkingSignatureDetector` 按 `model_info.supports_extended_thinking` / `supports_adaptive_thinking` 派发参数（见附录 B 模型能力表）| `detectors/thinking_signature.py:69-77` |
| **E3** | adaptive thinking 的 `effort` 字段位置 | 早期文档示例把 `effort` 写在 `thinking` 块内 | 实测 `thinking.effort` 返回 400 *"Extra inputs are not permitted"*，正确位置是**顶层 `output_config.effort`** | 检测器把 `effort` 单独放在 `output_config` 字段：`{"output_config": {"effort": "high"}}` | `detectors/thinking_signature.py:65-77` |
| **E4** | streaming + adaptive 的 thinking 事件 | 文档承诺 SSE 流中始终发送 `thinking_delta` + `signature_delta` | Opus 4.7 + adaptive + `display: "summarized"` 的 streaming 请求**静默丢弃** thinking 块——SSE 流只有 text 事件；同样请求改 non-streaming 则在 `content[*]` 中能拿到完整 thinking + signature | `ThinkingSignatureDetector` 改用 **non-streaming**，从 `response.content[*].signature` 取签名（与流式同源） | `detectors/thinking_signature.py:81-94` |
| **E5** | adaptive thinking 的 `max_tokens` 语义 | 文档说 `max_tokens` 是输出上限 | adaptive + `effort=high` 时，`max_tokens` 是**思考 + 输出合计**上限。设得太小（如 2600）模型会**直接跳过思考**以塞下答案，导致拿不到 signature | 检测器固定设 `MAX_TOKENS=16000`（与官方示例一致），给 adaptive 思考留余量 | `detectors/thinking_signature.py:38-42` |
| **E6** | `tool_use.caller` 字段类型 | 文档说是枚举字符串：`"direct"` / `"code_execution_20250825"` / `"code_execution_20260120"` | 官方 API 实测可能返回 **dict**（结构未公开），并非字符串 | `StructuredOutputDetector` 仅当 `caller` 是字符串且不在已知枚举内时扣分；dict 或其他类型记录原样、不扣分（避免 doc drift 把真品扣分）| `detectors/structured_output.py:143-164` |
| **E7** | `anthropic-request-id` 响应头 | 多处文档提及该 header 用于排查问题 | `/v1/messages` 端点（含 api.anthropic.com 自身）实测**不返回**该 header；只有少数 endpoint 才有 | `ProtocolDetector` **不**把缺失该 header 列为问题（避免对官方 API 自身误判）| `detectors/protocol.py:101-103`（注释）|

### 使用约定

- **新增**：每发现一项新差异，在这里加一行 + 在对应代码位置留 `#` 注释指回这里（"see DESIGN.md 附录 E §EN"）。
- **修复**：未来官方修复了某项差异（例如 Opus 4.7 重新接受 `temperature`），删除对应处理代码 + 删除这一行；不要保留死代码。
- **校验日期**：当前所有处理基于 **2026-04** 的实测；模型 upgrade 后建议跑一遍 `bench.sh` 拉新 baseline，若官方 API 自己分数掉了就是这里漏了一项。

### 风险

- **不绕开** → 官方 API 自身在我们工具里都拿不到 100 分 → baseline 污染 → 与中转站的对比失去意义。
- **绕得太宽** → 真正的协议错误也被宽容 → 假冒中转站漏判（典型例子：E6 caller 字段，绕得太松会把"完全不返回 caller"也算 OK，但实际官方一定会带这个字段——所以我们仍校验"如果 caller 是字符串则必须在枚举内"，只放过非字符串场景）。
- **绕得太死板** → 单条规则只盯一种异常形态，新形态出现仍会误伤。每条处理都尽量用"识别合法变体 + 不识别就如实记录"的策略，而不是"硬编码一种正确答案"。
