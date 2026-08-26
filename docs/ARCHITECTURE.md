# harness-kit 架构设计

本文档讲清楚三件事：**系统由哪些模块组成、每个模块的关键设计决策、以及与生产级 agent harness 的差距和补齐路径**。面试时顺着本文的"设计决策"部分讲，能完整展示工程判断力。

---

## 1. 系统总览

```
                        ┌──────────────────────────────────────────┐
                        │                 Harness                  │
                        │  配置归一化 + 装配（组合根）              │
                        └──────┬──────────┬──────────┬─────────────┘
                               │          │          │
              ┌────────────────┘          │          └────────────────┐
              ▼                           ▼                           ▼
      ┌───────────────┐          ┌──────────────┐            ┌──────────────┐
      │  ChatProvider │          │  ToolRegistry│            │ SkillRegistry│
      │  (LLM 供应商) │          │  (工具注册表) │            │ (技能库)      │
      └──────┬────────┘          └──────┬───────┘            └──────┬───────┘
             │                         │                            │
             │                 ┌───────┴────────┐                   │
             │                 │ 内置工具 fs/shell│                 │
             │                 └───────┬────────┘                   │
             │                 ┌───────┴────────┐                   │
             │                 │ McpRegistry    │──stdio/http──▶ MCP Server
             │                 │ (适配+命名空间) │                   │
             │                 └────────────────┘                   │
             ▼                                                        │
      ┌───────────────────────────────────────────────────────────────┘
      ▼
┌─────────────────────┐      事件流（AgentEvent，类型化）
│     Agent Loop      │ ────────────────────────────────▶ CLI / UI / Trace
└─────────────────────┘
```

数据流（一次 `harness.run(prompt)`）：

1. `Harness.run` 用 `SkillRegistry.select(prompt)` 选出相关技能 → 渲染为 `<skill>` 块 → 拼进 system prompt。
2. `Agent.run` 进入循环：调 `provider.chat(messages, tools)`。
3. `tools` 来自 `ToolRegistry`，其中 MCP 工具是 `McpRegistry.toTools()` 适配出来的（名字带 server 前缀）。
4. 模型返回 tool_calls → 校验参数 → `Tool.execute()` → 结果以 `tool` 消息回填 → 回到 2。
5. 模型返回纯文本 → 循环以 `ok` 终止，返回 `AgentResult`（含完整 transcript 与 token 统计）。

---

## 2. Agent Loop（`src/loop/`）

### 2.1 为什么循环必须显式建模

LLM 本身是"无状态的单步函数"，agent 的所有智能来自**循环编排**。工程上必须回答：什么时候停？出错了怎么办？怎么观察？——这就是 loop 的价值。

### 2.2 状态机与终止矩阵

| 状态 | 触发条件 | 语义 |
|---|---|---|
| `ok` | 模型回复不含 tool_calls | 正常完成 |
| `max-iterations` | 迭代次数达到预算 | 兜底：LLM 可能陷入工具循环 |
| `stopped` | `stopWhen(state)` 谓词为真 | 调用方自定义（如"结果已足够好"） |
| `aborted` | 调用方 `AbortSignal` 触发 | 用户取消 / 超时取消 |
| `error` | provider 重试耗尽 / 致命异常 | 失败返回（带 error 与部分 transcript） |

### 2.3 关键设计决策

- **终止保证优先**：`maxIterations` 是硬约束，写在循环入口，任何路径都不可能死循环。
- **重试只针对"瞬时失败"**：provider 抛错时先检查 AbortSignal——被取消绝不重试（重试已取消的请求是无意义的浪费），然后线性退避重试 `maxRetries` 次。
- **工具错误是可恢复的，不是致命的**：未知工具名、参数校验失败、工具抛错、工具超时，全部转成 `[tool error] ...` 文本回喂模型。模型有上下文修正自己（换个参数、换个工具、直接作答）。这是 agent 与普通函数调用的本质区别。
- **参数预校验（轻量 schema check）**：不引入 ajv 之类完整 JSON-Schema 实现，只检查必需字段、基础类型、数组元素类型。理由：模型绝大多数时候守规矩，防的是偶发幻觉；完整校验器带来的复杂度与依赖不值得。校验失败也走"回喂模型"路径。
- **事件流 = 可观测性契约**：`AgentEvent` 是类型化的联合类型，`onEvent` 是唯一观察口。CLI 实时输出、trace 记录、未来做人类审批，都是同一个事件流的消费者。事件处理器抛错不影响循环（try/catch 包裹）。
- **默认值合并防 `undefined` 覆盖**：调用方传 `{ maxRetries: undefined }` 时，默认值仍生效（`Object.entries` 过滤后再合并）。这是真实工程中常见的隐性 bug（本次开发中就被测试抓到过一次）。

### 2.4 与生产级 harness 的差距

DeepSeek Harness / Claude Agent SDK 在 loop 之上还有：

- **goal 循环**（goal-round-driver）：把长任务拆成多"轮"，每轮是独立的 loop 生命周期，轮间持久化目标状态；
- **plan mode**：进入工具执行前先产出显式计划，可让用户确认；
- **compaction**（上下文压缩）：transcript 过长时摘要旧消息，防止 token 爆炸（本实现只有工具结果截断 20k）；
- **权限/审批**：高风险工具（shell、写文件）执行前经策略引擎或人工确认。

这些在本项目中都是清晰的扩展点：事件流已经提供了插入点，`stopWhen`/`AgentResult` 已经为 goal 驱动留了形状。**能把"和生产的差距"讲清楚，本身就是加分项。**

---

## 3. MCP 集成（`src/mcp/`）

### 3.1 为什么用官方 SDK 而不是自己实现协议

MCP 是 **wire protocol**（JSON-RPC 2.0 over stdio/HTTP），实现它的意义在于"对齐规范"，而不是"展示能力"。用官方 `@modelcontextprotocol/sdk`：

- 协议演进（init 握手、capability 协商、错误码）由官方跟进，我们不重复造轮子；
- 我们的工程量集中在**接入与适配**：多 server 管理、命名空间、缓存、结果映射——这才是 harness 工程师的活。

（作为对照：LLM 侧我们同样用 `openai` SDK 只做 HTTP 层，自行实现的是流式 tool_calls 增量聚合与 usage 采集。）

### 3.2 设计决策

- **命名空间 `<serverId>.<toolName>`**：Claude Desktop 的做法。两个 server 都提供 `search` 时，`confluence.search` 与 `github.search` 无歧义；模型看到的名字即调用名，调用时剥掉前缀路由到对应连接。牺牲一点"名字简洁"，换来确定性与可调试性。
- **工具列表缓存 + refresh**：connect 时拉一次 `listTools` 缓存；server 运行中动态加工具时，`refresh()` 重新拉取。避免每次循环都做一次网络往返。
- **传输抽象**：`attach(id, transport)` 允许注入任意 Transport——测试用 in-memory link 走真实协议路径但零子进程，demo 用 stdio 子进程走真实生产路径，同一套客户端代码。
- **结果归一化**：`isError` → `{ok:false}`；`structuredContent` 优先；纯 text content 拼接。Agent Loop 完全感知不到 MCP 的存在。

---

## 4. Skill 系统（`src/skills/`）

### 4.1 为什么是 SKILL.md 约定

把"任务专用指令"做成**文件系统上的可复用资产**：技能可版本化、可分享、可由社区贡献。这也是 Anthropic skills 与 DeepSeek Harness skill 共同的形态。frontmatter（name/description）是给**机器**的元数据，正文是给**模型**的指令。

### 4.2 匹配算法：零依赖的关键词打分

```
tokenize(text):
  ASCII 词：text.toLowerCase() 按 [a-z0-9]+ 切分（连字符拆开）
  CJK：连续中文字符串 → 全部字符 bigram（"审阅代码" → 审阅/阅代/代码）

score(query, skill) = Σ 4×queryToken∈skillName + 1×queryToken∈skillDescription
                     + 精确 name 匹配 ? +10 : 0
```

决策理由：

- **为什么 CJK 要 bigram**：中文没有空格分词，把整句当一个 token 匹配率极低；bigram 是信息检索里经典的无词典方案，"审阅代码"与"代码审阅"也能共享 `代码` 这个 bigram。
- **为什么不用 embedding**：一个小技能库（几十个）用向量检索是杀鸡用牛刀，且引入模型依赖和离线成本。关键词打分可解释、可测试（`test/skills.test.ts` 覆盖中英文场景）。接口按 `select(query)` 收口，日后换 embedding 检索不动调用方。

### 4.3 注入时机

技能不是常驻 system prompt（会稀释注意力、浪费 token），而是 **`Harness.run()` 时按用户请求动态选择 Top-K 注入**。名字精确匹配会获得高权重，保证"点名要某个技能"必然命中。

---

## 5. Provider 抽象（`src/llm/`）

- 内部统一 `Message`/`Tool`/`ToolCall` 方言；`ChatProvider.chat(req)` 是唯一契约；`OpenAICompatibleProvider` 负责与 OpenAI wire format 互转（含流式 tool_calls 增量按 index 聚合、`include_usage` 统计）。
- **任何 OpenAI 兼容端点都能用**：OpenAI、DeepSeek、Moonshot、Ollama、vLLM……换模型只改配置不改代码。
- `MockProvider` 是确定性脚本 provider：测试无网络、demo 无 Key 可跑，同时保留 `calls` 记录供断言。

## 6. Harness 组合层（`src/harness/`）

组合根只做三件事：**归一化配置 → 装配子系统 → 暴露一个 run()**。失败策略：MCP 连接失败记日志但**不阻断**启动（一个 server 挂了不该让整个 harness 不可用）；skill 坏文件跳过并告警；未知内置工具组告警。这些"部分失败容忍"是运行时稳定性的基本功。

## 6.5 工作目录贯穿（cwd）

对话客户端引入"会话工作目录"后，cwd 成为一条贯穿全链路的上下文：`ChatSession.cwd` → `RunOptions.cwd` → `ToolContext.cwd` → 内置工具（fs 相对路径基于它解析、shell 默认 cwd 指向它）。核心 loop 与工具层因此能复用同一套代码服务 CLI 与 Web 两种入口，这也是"harness 上下文传播"的典型工程问题。

## 6.6 Web 客户端（`src/server/`）

本地 Web 工作台是一个**零框架依赖**的 `node:http` 服务（不引 express，路由与 SSE 手写，展示 HTTP 功底）：

- **SSE 事件流**：`POST /api/chat` 返回 `text/event-stream`，把 AgentLoop 的类型化事件逐帧推给浏览器；前端用 `fetch + ReadableStream` 消费（EventSource 不支持 POST，因此不用它）。
- **会话模型**：`ChatSession` 持有多轮历史（上限 60 条截断）、cwd、abort 生命周期；每次 chat 用 `Harness.run(messages)` 重放历史 —— 多轮上下文完整，且 skill 自动注入按最新用户消息计算。
- **前端**：零构建原生 JS（无 webpack/vite），所有渲染走 `textContent` 防 XSS；工具卡片按 `callId` 关联状态，流式与一次性返回通过 `llm.delta` / `llm.turn` 双通道兼容（`llm.turn` 按已显示长度补差，避免重复）。

## 7. 测试策略

| 层 | 手段 | 覆盖 |
|---|---|---|
| Loop | MockProvider 脚本化 turns | 全部终止分支、事件顺序、重试、abort、超时 |
| Tools | 真实 fs + 真实 shell（temp dir） | 读写往返、超时击杀、错误映射 |
| Skills | 临时目录 fixture | frontmatter 校验、递归加载、中英文匹配 |
| MCP | in-memory transport + 真实 Server | 协议全链路：list/call/错误/命名空间/refresh |
| Harness | 组合 + 注入 | 配置归一化、skill 注入开关、provider 注入、无 Key 报错 |

原则：**除 MCP stdio 子进程外全部离线**；测试即文档（每个用例就是一个行为契约）。

## 8. 目录速查

| 文件 | 职责 |
|---|---|
| `src/loop/agent.ts` | 循环状态机（本项目的"心脏"） |
| `src/loop/events.ts` | 类型化事件流 |
| `src/mcp/registry.ts` | MCP 客户端注册表 + 适配器 |
| `src/skills/match.ts` | 分词 + 打分（可替换的检索接口） |
| `src/harness/harness.ts` | 组合根 |
| `examples/demo.ts` | 端到端演示（离线可跑） |
| `examples/mcp-servers/weather-server.ts` | 自带 MCP server（stdio + in-memory 双用） |
