# harness-kit

> 一个轻量、可扩展、provider 无关的 **Agent Harness**：把 **Agent Loop（代理循环）**、**MCP（模型上下文协议）**、**Skill（技能系统）** 三大能力组合成一个可运行的 agent 运行时。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

---

## 为什么做这个项目

这是一个展示 **agent harness 工程能力** 的开源作品。harness 是"agent 的运行时操作系统"——它不负责模型本身，而是解决让 agent **可靠、可观测、可组合** 的问题：

- **Agent Loop**：思考 → 调用工具 → 观察结果 → 继续思考 的循环如何被工程化（终止保证、重试、取消、超时、事件流）。
- **MCP**：如何把任意 MCP server 的工具无缝接入 agent（多 server 注册表、命名空间、schema 适配、协议结果映射）。
- **Skill**：如何让 agent 按需获得"任务专用指令包"（SKILL.md 约定、目录加载、相关性匹配、注入 system prompt）。

三大能力通过一个 **Harness 组合层** 装配：一条 JSON 配置即可把 provider、内置工具、MCP servers、skills 组合成一个可跑的 agent。

> 该项目刻意保持单包、无框架依赖的核心循环，方便阅读与二次开发；生产级 harness（如 DeepSeek Harness）的 goal 循环、plan mode、compaction、权限系统等，都可以作为扩展点接入，详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 快速开始

```bash
# 克隆后
npm install
npm test          # 57 个单元/集成测试（全部离线，无网络依赖）

npm run demo      # 端到端 demo：MCP weather server + skills 自动注入 + Agent Loop
```

**没有 API Key 也能跑**：demo 默认使用确定性的 MockProvider（离线演示）；设置了 `OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY` 后自动切换到真实模型（OpenAI 兼容协议）。

```bash
# 使用真实模型（任一即可）
export DEEPSEEK_API_KEY=sk-xxx
npm run demo

# CLI 直接跑 agent
node dist/src/cli/index.js run --mock "你好"          # 离线
node dist/src/cli/index.js run "查一下北京天气" -c examples/config.demo.json   # 真实模型
```

---

## 三大核心概念

### 1. Agent Loop（`src/loop/`）

一个类型化的 **循环状态机**，保证每次运行**必然终止**：

```
while (true) {
  response = await provider.chat({ messages, tools })   // 可流式、可取消、失败自动重试
  messages.push(assistant(response))
  if (response 没有 tool_calls) return 最终答案          // 正常终止
  for (call of response.tool_calls)
    校验参数 → 执行工具（带超时）→ 结果作为 tool 消息回填
  if (stopWhen(state)) return 自定义终止
  // maxIterations 兜底：绝不死循环
}
```

关键工程点：

- **终止条件矩阵**：`ok`（模型给出最终答案）/ `max-iterations`（预算耗尽兜底）/ `stopped`（自定义谓词）/ `aborted`（调用方 AbortSignal）/ `error`（重试耗尽）。
- **可观测性**：每一步都发射类型化事件（`llm.delta` / `llm.turn` / `tool.call` / `tool.result` / `tool.error` / `agent.done`），CLI 的实时输出就是事件流的消费者。
- **健壮性**：LLM 瞬时失败线性退避重试；工具调用前做轻量 JSON-Schema 校验（缺依赖、可解释）；未知工具、工具抛错都作为**可恢复错误**回喂模型；工具执行有超时保护。
- **零框架依赖**：循环核心只用 Node 内置能力，`ChatProvider` 是唯一的外部接口。

```ts
const agent = new Agent({ provider, tools, onEvent: (e) => console.log(e) });
const result = await agent.run('帮我写一个 sum 函数');
// result.status / result.output / result.messages（完整对话记录）/ result.usage
```

### 2. MCP（`src/mcp/`）

基于 **官方 MCP SDK** 的多 server 客户端，把 MCP 工具接入 harness：

- 支持 `stdio`（本地子进程）与 `streamable-http`（远程）两种传输。
- **工具命名空间**：`<serverId>.<toolName>`（如 `weather.current`），多个 server 即使暴露同名工具也不会冲突。
- **工具列表缓存** + 按需 `refresh()`（server 运行时可以动态增删工具）。
- 协议结果（`content[]` / `isError` / `structuredContent`）统一映射为 harness 的 `ToolResult`，**Agent Loop 无需感知 MCP**。

```ts
const registry = new McpRegistry();
await registry.connect({ id: 'weather', transport: 'stdio', command: 'node', args: ['weather-server.js'] });
const tools = registry.toTools();      // 已适配 + 命名空间的 Tool[]
```

仓库自带一个 demo MCP server（`examples/mcp-servers/weather-server.ts`，天气 + 时间工具），测试中通过 in-memory transport 链接，demo 中通过真实 stdio 子进程链接。

### 3. Skill（`src/skills/`）

遵循 **SKILL.md 约定** 的技能系统：每个技能是包含 `SKILL.md`（YAML frontmatter + 指令正文）的目录。

```markdown
---
name: code-review
description: 审阅 TypeScript/JavaScript 代码，定位 bug 与安全隐患，输出分级评审意见。
---
（正文：完整的使用步骤与输出格式约定）
```

- **加载**：递归扫描技能目录，frontmatter 解析与校验（坏文件跳过并告警，不阻断）。
- **匹配**：零依赖的关键词相关性打分 —— ASCII 词 token + **CJK 字符 bigram**（"审阅代码" → 审阅/阅代/代码），名称命中权重 4、描述命中权重 1、精确名称 +10；对中英文查询都可用，且接口可替换为 embedding 检索。
- **注入**：`Harness.run()` 时按用户请求自动选择 Top-K 技能，渲染为 `<skill>` 块追加进 system prompt。

---

## CLI

```bash
harness-kit run "prompt..."      # 运行 agent（支持流式输出；无 prompt 时读 stdin）
harness-kit run --mock "hi"      # 离线模式
harness-kit mcp list             # 列出配置中 MCP server 的工具
harness-kit skills list          # 列出已加载的技能
harness-kit skills show <name>   # 查看某个技能的完整指令
harness-kit demo                 # 跑内置端到端 demo
```

全局选项：`-c/--config <file>`、`-m/--model`、`--no-stream`、`--verbose`（打印完整事件时间线）、`-i/--max-iterations`。

## 配置

`harness.config.json`（或任意路径 + `-c`）：

```json
{
  "provider": { "type": "openai", "model": "deepseek-chat" },
  "tools": ["fs", "shell"],
  "skills": { "dirs": ["./skills"], "autoSelect": true, "maxSelected": 2 },
  "mcp": [
    { "id": "weather", "transport": "stdio", "command": "node", "args": ["dist/examples/mcp-servers/weather-server.js"] }
  ],
  "budget": { "maxIterations": 15, "toolTimeoutMs": 30000, "maxRetries": 2 }
}
```

API Key 解析顺序：`config.provider.apiKey` → `OPENAI_API_KEY` → `DEEPSEEK_API_KEY`（使用 DeepSeek Key 时自动指向 `https://api.deepseek.com`）。

## 作为库使用

```ts
import { Harness } from 'harness-kit';

const harness = await Harness.create({
  config: {
    provider: { type: 'openai', model: 'deepseek-chat' },
    tools: ['fs', 'shell'],
    skills: { dirs: ['./skills'] },
    mcp: [{ id: 'weather', transport: 'stdio', command: 'node', args: ['./weather-server.js'] }],
  },
});

try {
  const result = await harness.run('查一下北京天气，然后 review 一下 src/main.ts');
  console.log(result.output);          // 最终回答
  console.log(result.messages);        // 完整对话记录（含工具结果）
} finally {
  await harness.dispose();             // 关闭所有 MCP 连接
}
```

## 目录结构

```
src/
├── loop/        Agent Loop 核心（agent.ts 循环状态机 + events.ts 事件流）
├── llm/         ChatProvider 接口 + OpenAI 兼容实现 + Mock 实现
├── tools/       Tool 抽象、JSON-Schema 校验、内置工具（fs/shell）
├── mcp/         MCP 客户端注册表（stdio/http）、工具适配与命名空间
├── skills/      SKILL.md 解析、加载、相关性匹配、渲染注入
├── harness/     组合层：配置归一化 + 装配 provider/tools/mcp/skills
└── cli/         commander CLI（run / mcp / skills / demo）
examples/        demo MCP server、示例 skills、带 bug 的样例代码、端到端 demo
test/            vitest 单元 + 集成测试（57 个，全离线）
docs/            架构设计文档
```

## 测试

```bash
npm test                 # 全部测试（离线）
npm run test:watch       # 监听模式
npm run typecheck        # 纯类型检查
```

覆盖：循环终止/重试/abort/超时/事件顺序、工具注册与参数校验、内置工具行为、SKILL.md 解析与中英文匹配、MCP in-memory 集成（真实协议路径）、Harness 组合与 skill 注入。

## 设计决策与扩展点

设计取舍的完整讨论（为什么用官方 MCP SDK、为什么自己写轻量 schema 校验、匹配算法为什么是"零依赖打分"、与生产级 harness 的差距如何补齐）见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

值得关注的可扩展方向：goal 循环（多轮长任务）、plan mode、上下文压缩（compaction）、工具权限/审批系统、事件追踪导出、embedding 技能检索。

## License

MIT
