# 璇玑（xuanji）— 开源项目简历版介绍

> 用于求职简历 / 作品集的项目介绍。可直接复制使用，建议按需删减到 5-8 行。

---

## 简洁版简介（一段话）

**璇玑（xuanji）** 是一个从零实现的 TypeScript Agent Harness —— **可测、可控、可管的 agent harness 个人助手产品**。提供 Agent Loop / MCP / Skill 三大能力与 Codex 式 Web 工作台（SSE 流式对话、工作区隔离、工具可视化、模型切换、审批弹窗），并内置免 Key 的联网搜索。GitHub：github.com/dz2001-beep/agent-xuanji

### 四项优化

1. **轨迹记录与离线重放**：把一次运行的完整事件流记录为 JSONL 轨迹文件；支持离线回放（不调模型）校验事件顺序、统计工具调用序列与 token 消耗；与黄金轨迹比对可发现行为变化 —— agent 行为可回归验证
2. **Token 预算驱动的上下文压缩**：在 Agent Loop 模型调用前接入可配置的预算检查，超出预算时按层级自动压缩：先截断超长工具结果，再把最旧的对话轮次折叠为保留工具序列与结论的结构化摘要；压缩过程不依赖 LLM（可离线确定性测试），压缩前后 token 数与裁剪/折叠次数通过事件流可观测；实测长会话 token 减少 96%
3. **参数级最小权限策略 + 人工审批**：用声明式规则按"工具名 + 参数"判断放行/拒绝/询问；危险命令直接拒绝，高风险操作需人工确认，无确认通道时默认拒绝（fail-closed）
4. **技能学习**：把成功运行的轨迹自动转成可复用的 SKILL.md 技能；多条同类轨迹合并时按使用频率加权 —— 下次同类任务可直接复用

---

## 一句话定位

**璇玑（xuanji）**：一个从零实现的 TypeScript **Agent Harness**（代理运行时），把 **Agent Loop（循环编排）、MCP（模型上下文协议）、Skill（技能系统）** 三大能力组合成带 Web 工作台的完整产品，并针对 agent 生产落地的三大难题（不可测、成本失控、危险操作）做了三项稀缺优化。

**GitHub**：https://github.com/dz2001-beep/agent-xuanji （TypeScript · Node.js · 100% 自研）

---

## 技术栈

TypeScript / Node.js · 官方 MCP SDK · OpenAI 兼容协议（DeepSeek/OpenAI/本地模型）· node:http + SSE · vitest

---

## 核心能力

| 模块 | 说明 |
|---|---|
| **Agent Loop** | 循环状态机：5 种终止态（ok/max-iterations/stopped/aborted/error）、LLM 退避重试、AbortSignal 全链路取消、工具超时、参数预校验、类型化事件流 |
| **MCP 集成** | 官方 SDK 客户端（stdio/HTTP）、多 server 命名空间、工具缓存与刷新、协议结果归一化 |
| **Skill 技能系统** | SKILL.md 约定、递归加载、中英文相关性匹配（CJK bigram）、按请求自动注入 system prompt |
| **Web 工作台** | SSE 流式对话、工作区隔离、工具调用可视化、模型运行时切换、联网搜索（免 Key） |
| **CLI 全套** | run / ui / doctor（一键自检）/ replay / trace diff 等 12 个命令 |

---

## 自己做的优化（重点 ✦）

### 1. Agent 轨迹记录与重放回归（Trace & Replay）— 解决"agent 不可测"
- 把一次运行的完整事件流（LLM 轮次 / 工具调用序列 / token 记账 / 终止状态）序列化为 JSONL 轨迹
- 提供**离线重放器**：不调模型即可校验事件顺序合法性、复算统计（轮次/工具序列/token）
- 提供**黄金轨迹比对**：检出状态/工具序列/token 漂移 —— agent 行为的快照式回归测试，可直接接入 CI
- CLI：`run --trace` 记录 → `replay` 重放 → `trace diff` 比对

### 2. Token 预算驱动的上下文压缩（Compaction）— 解决"token 成本失控"
- 零依赖 token 估算器（CJK/ASCII 混合启发式），可确定性断言
- **分层压缩策略**：超预算先裁剪超长工具结果，再折叠最旧轮次为结构化摘要（保留工具序列与结论）
- 触发全程可观测（`context.compacted` 事件：压缩前后 token 数）
- 实测：8 轮长会话 **29,990 → 1,240 tokens（↓96%）**

### 3. 最小权限策略引擎 + 人工审批流（Policy）— 解决"危险操作不可控"
- 声明式策略（JSON）：按**工具名 + 参数模式**（equals/正则）裁决 `allow / deny / ask`
- 危险命令（如 `rm -rf`）直接拦截；高风险操作推送**工作台审批弹窗**（允许一次/拒绝）；无审批回调时 **fail-closed 默认拒绝**
- CLI 终端交互审批 + SSE 双通道

### 4. 技能学习（Skill Learning）— 经验沉淀闭环（Trace → Skill）
- `xuanji skill learn` 把**成功运行的轨迹自动提炼为可复用 SKILL.md**：提取有序工具路径 + 参数示例 + 参考输出
- 多条同类轨迹合并时按**采用频次加权**（2/2 vs 1/2 的"高频"信号），只提炼成功运行
- 闭环：跑成功 → 自动沉淀 → 下次同类任务**自动匹配注入**（对应 Voyager skill library / Agent Skills 生态方向）

### 5. 其他工程优化
- **wire 层工具名编解码**：规避 OpenAI 兼容 API 对工具名的字符约束（400 报错 → 协议层修复）
- **空字符串 Key 陷阱**：`export KEY=""` 被误判的问题 → 修正取值优先级并给出诊断提示
- **IP 定位不准**（网络出口聚合）：增加「我的城市」设置，持久化后天气查询优先用户真实位置
- **doctor 一键自检**：Key / 模型连通性 / 工具名合法性 / 工作区，一条命令定位环境问题
- **事件驱动架构**：单一类型化事件流同时服务 CLI 实时输出、UI 工具卡片、轨迹记录、审批推送、技能提炼

---

## 量化数据（写简历用）

- 上下文压缩实测 **token 峰值 ↓96%**
- 代码量：约 4,500 行 TypeScript，核心循环零框架依赖
- 12 个 CLI 命令；联网搜索免 API Key

---

## 四项优化（简历独立亮点）

1. **轨迹记录与离线重放，让 agent 行为可回归测试** —— 把一次运行的事件流固化为 JSONL 轨迹，离线重放（不调模型）即可校验事件顺序、复算工具序列与 token，黄金轨迹比对可检出行为漂移，直接接入 CI 做 agent 的"快照回归测试"。
2. **Token 预算驱动的上下文压缩，长会话成本可控** —— 零依赖 token 估算 + 分层策略（先裁剪超长工具结果、再折叠最旧轮次为结构化摘要），触发全程可观测；实测 8 轮长会话 token 峰值 **↓96%**。
3. **参数级最小权限策略 + 人工审批流，危险操作可控** —— 声明式规则按"工具名 + 参数模式"裁决 allow/deny/ask：`rm -rf` 一类危险命令直接拦截，高风险调用推工作台弹窗审批（允许一次/拒绝），无审批回调时 fail-closed 默认拒绝。
4. **技能学习（经验沉淀闭环）** —— 把成功运行的轨迹自动提炼为可复用 SKILL.md，多条同类轨迹按采用频次加权合并，跑成功 → 自动沉淀 → 下次同类任务自动匹配注入。

---

## 测试是怎么做的（面试讲解版）

测试策略：**全部离线、确定性、无网络** —— 用"脚本化数据"代替真实 LLM/API 调用，跑得快且可精确断言。

| 测试数据 | 长什么样 | 验证什么 |
|---|---|---|
| **MockProvider 脚本 turns** | `turns: [{toolCalls:[...]}, {content:'pong'}]` —— 预写"模型每轮会说什么" | 循环的终止/重试/abort/事件顺序/工具回填 |
| **fake fetch 响应** | 手写 OpenAI 兼容的 JSON 响应，注入 provider 的 `fetch` | wire 层编解码往返、工具名合法性 |
| **HTML fixture** | 一段必应搜索结果页 HTML 常量 | 搜索解析器（标题/链接/摘要提取） |
| **演示数据** | `DEMO_CITIES`（北京/上海/深圳/杭州） | 天气 server 的网络降级路径 |
| **策略规则** | `rules: [{tool:'shell.*', when:{command:{matches:'rm -rf'}}, action:'deny'}]` | 策略裁决矩阵（deny/ask/allow/默认） |
| **临时目录 fixture** | 测试里现场创建的真实文件/技能目录 | 文件工具、SKILL.md 加载 |

---

## 简历写法参考（中文）

> **璇玑 xuanji** — 开源 Agent Harness（GitHub：github.com/dz2001-beep/agent-xuanji，TypeScript，100% 自研）
> - 从零实现 Agent Loop 循环状态机（5 种终止态/重试/取消/超时）与类型化事件流，核心零框架依赖
> - 基于官方 SDK 集成 MCP（stdio/HTTP、多 server 命名空间）；自研 SKILL.md 技能系统（中英文匹配、自动注入）
> - 亮点一：**轨迹记录与离线重放**，agent 行为可做快照式回归测试（CI 可接入）
> - 亮点二：**token 预算驱动上下文压缩**，长会话 token 峰值实测 ↓96%
> - 亮点三：**参数级最小权限策略 + 人工审批流**，危险调用 fail-closed 默认拒绝
> - 亮点四：**技能学习**，成功轨迹自动提炼为可复用技能（经验沉淀闭环）
> - 交付 Codex 式 Web 工作台（SSE 流式/工作区隔离/模型切换/联网搜索免 Key）+ doctor 一键自检

## 简历写法参考（English）

> **xuanji** — Open-source Agent Harness (TypeScript/Node, 100% self-built)
> - Built the Agent Loop state machine from scratch (5 termination states, typed event stream, retry/cancel/timeout), zero-dependency core
> - Integrated MCP via official SDK; designed a SKILL.md skill system with CJK-aware relevance matching and auto-injection
> - Highlight 1: trace recording & offline replay — agent behavior becomes regression-testable (CI-ready)
> - Highlight 2: token-budget-driven context compaction — measured −96% peak tokens on long sessions
> - Highlight 3: parameter-level least-privilege policy engine + human approval flow — fail-closed by default
> - Highlight 4: skill learning — successful traces auto-distilled into reusable skills (experience loop)
> - Shipped a Codex-style web workspace (SSE streaming, workspace isolation, model switching, key-free web search) + one-command diagnostics
