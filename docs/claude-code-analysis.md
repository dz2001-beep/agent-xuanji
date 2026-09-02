# Claude Code 源码解读与分析

> 分析对象：`@anthropic-ai/claude-code@2.1.258`（2026-08 npm 最新版）发布包 + 官方公开文档 + 社区公开资料。
> 说明：Claude Code 的 CLI 为**闭源原生二进制**（非可读 JS 源码），本文对"能拿到的真实产物"做直接分析（发布包结构、安装器实现），对其余部分基于官方文档的架构级解读 —— 不臆造代码细节。

---

## 1. 最直接的源码级发现：它已经"不是一个 npm 应用"了

把 `@anthropic-ai/claude-code` 下载解压，全部内容只有 7 个文件、约 196KB：

```
package/
├── bin/claude.exe          # 占位
├── cli-wrapper.cjs         # 兜底 launcher（见下）
├── install.cjs             # postinstall：平台检测 + 复制原生二进制
├── sdk-tools.d.ts          # 类型声明（对外 SDK 用）
├── package.json
├── LICENSE.md
└── README.md
```

**解读：这是一个"分发器"而不是应用本体。** 真正的 CLI 是编译好的**原生二进制**，通过平台子包分发（`@anthropic-ai/claude-code-darwin-arm64`、`linux-x64`、`win32-x64`…），postinstall 时按平台复制到 `bin/`：

```
npm i @anthropic-ai/claude-code
   └─ install.cjs
        ├─ getPlatformKey(): darwin-arm64 / linux-x64 / linux-x64-musl / android…
        ├─ 检测 musl（process.report.header.glibcVersionRuntime === undefined）
        ├─ require.resolve('@anthropic-ai/claude-code-darwin-arm64/package.json')
        └─ 复制原生二进制 → bin/claude
```

细节（真实代码证据）：
- **平台矩阵非常细**：darwin-x64/arm64、linux-x64/arm64、**musl 变体**、**android 变体**、win32-x64/arm64，连 freebsd 都有明确报错提示（"Consider running under Linuxulator"）
- **Rosetta 处理**：darwin-arm64 机器上若跑的是 x64 的 Node，会提示安装 darwin-x64 二进制并要求 AVX
- **兜底 launcher**（`cli-wrapper.cjs`）：`--ignore-scripts` 环境（如 Docker 镜像、安全策略禁止 postinstall）下用 Node spawn 原生二进制，代价是"pay the Node-process overhead"

**结论：Claude Code 已经走完"JS 应用 → 原生二进制"的工业化路径** —— 性能、启动速度、体积（不含 Node runtime）都为此服务。这对开源 JS 项目（比如 xuanji）的意义是：**先做对架构，再考虑编译分发**。

---

## 2. 产品架构解读（基于官方文档与公开资料）

### 2.1 进程模型：主进程 + 后台子进程

```
终端 UI（ANSI 流式渲染）
   │
Claude Code 主进程（agent loop + 工具调度 + 权限裁决）
   ├─ Bash 沙箱子进程（受限 shell，安全执行命令）
   ├─ WebFetch / 抓取子进程
   ├─ 本地搜索（grep/glob 语义检索）子进程
   └─ 子代理（subagent）进程（Task 工具触发，独立上下文）
```

主进程负责循环与决策，重活（命令执行、抓取、搜索）放到子进程 —— 崩溃隔离 + 资源限制都在子进程边界做。

### 2.2 Agent Loop 与权限模式

核心循环：**读取输入 → 规划（thinking）→ 工具调用 → 观察结果 → 循环直到完成**。
关键工程点是 **permission 模式**贯穿循环：

| 模式 | 行为 |
|---|---|
| `default` | 每个工具调用都询问（或按 hooks 规则自动允许/拒绝） |
| `acceptEdits` | 文件编辑自动允许，危险操作仍询问 |
| `plan` | 只产出计划不执行，用户确认后切换模式执行 |
| `bypassPermissions` | 全自动（高风险，供 CI/可信环境） |

这正是 xuanji 的 `Policy（allow/deny/ask + 人工审批 + fail-closed）` 所对标的机制 —— 我们把"模式"做成了"可编程的声明式规则"。

### 2.3 工具系统

| 工具 | 作用 |
|---|---|
| `Bash` | 沙箱内执行命令（超时、受限目录） |
| `Edit` / `Write` | 结构化文件编辑（精确替换，非整文件重写） |
| `Read` / `Grep` / `Glob` | 读文件、正则搜索、路径匹配 |
| `WebFetch` / `WebSearch` | 联网（内置搜索工具） |
| `Task` | **调用子代理**（见 2.4） |
| MCP 工具 | 动态接入任意 MCP server 的工具 |

与 xuanji 对照：我们的 `Tool` 抽象（name/description/schema/execute）+ MCP 命名空间接入是同一思路；差异是 Claude Code 的编辑工具是**结构化 diff 级别**（我们目前是整文件 write）。

### 2.4 子代理（Subagents）

- **定义即文件**：`.claude/agents/*.md`（frontmatter：name/description/tools + 指令正文）—— 和 SKILL.md 约定同构
- **调用**：主代理通过 `Task` 工具动态拉起，子代理有**独立上下文窗口**，只接收"任务描述 + 必要的文件引用"，结果以文本返回
- **价值**：上下文隔离（子任务不污染主上下文）、专业分工（不同 tools/提示词）、失败隔离
- 这正是 xuanji 规划的 **subagent-as-tool**（Agent 封装成 Tool）多 agent 方案的业界原型

### 2.5 上下文管理

- **auto-compact**：上下文接近窗口上限时自动压缩 —— 把早期对话摘要化，保留关键信息（工具结果、决策）
- 用户可 `/compact` 手动触发；压缩策略可配置
- xuanji 的 **Token 预算驱动分层压缩**（估算器 + 裁剪工具结果 + 折叠旧轮次摘要）走的是同一目标，且我们做到了**无 LLM、可离线确定性测试**（Claude Code 的摘要压缩依赖模型）

### 2.6 会话与恢复

- 每次会话落盘（JSONL 记录），支持 `--resume` / `/rewind`（回退到之前的 checkpoint）
- 崩溃/中断后可恢复现场
- xuanji 当前：工作区历史为内存态 + 轨迹 JSONL 可回放 —— **会话持久化恢复**是明确差距（已有轨迹数据基础，做恢复是自然延伸）

### 2.7 Hooks（生命周期钩子）

`PreToolUse` / `PostToolUse` / `Stop` / `SubagentStop` / `Notification` 等，用户可在工具调用前后挂自定义脚本（校验、注入、告警、权限策略）。

**这是 Claude Code 最值得借鉴的扩展点之一** —— 相比我们的"策略引擎内置"，Hooks 允许用户用任意语言在固定时点注入逻辑。xuanji 的事件流（AgentEvent）已经具备等价的可观测钩子基础，缺的是"用户自定义脚本"通道。

### 2.8 终端 UI

- ANSI 流式渲染：思考过程折叠、工具调用卡片化、状态行（token/轮次）
- 输出结构化为事件流 → 终端渲染器消费
- xuanji 的 Web 工作台用 SSE 事件流做同样的事（工具卡片/流式文本/状态行），只是渲染目标从终端变成了浏览器

---

## 3. 与 xuanji 的架构对照

| 能力 | Claude Code | xuanji | 差距/借鉴 |
|---|---|---|---|
| Agent Loop | 权限模式驱动的循环 | 5 终止态状态机 + 事件流 | 目标一致，我们显式化终止矩阵 |
| 权限控制 | permission 模式 + hooks | 参数级策略引擎 + 审批 + fail-closed | 我们更细粒度、可编程 |
| 上下文管理 | auto-compact（模型摘要） | 预算驱动分层压缩（无 LLM、可测 ↓96%） | 我们确定性更强 |
| 子代理 | Task 工具 + .md 定义 | 规划中（subagent-as-tool） | 差距：未实现 |
| 会话 | resume/rewind | 轨迹回放（无状态恢复） | 差距：会话恢复 |
| 扩展点 | Hooks（任意语言脚本） | 事件流 + 策略规则 | 差距：用户脚本钩子 |
| 可观测 | 会话 JSONL | 轨迹 JSONL + 重放 + 链路视图 | 我们更强（回归测试） |
| 分发 | 原生二进制 | Node 源码包 | 阶段不同，不必追 |

## 4. 从解读中得到的行动清单（供 xuanji 参考）

1. **多 agent（Task/子代理）**：Claude Code 已证明 .md 定义 + 独立上下文的价值 → 落地 subagent-as-tool
2. **会话持久化 + resume/rewind**：轨迹数据已有，补状态恢复闭环
3. **Hooks 扩展通道**：让用户脚本在工具调用前后注入（复用事件流）
4. **结构化编辑工具**：Edit 级精确替换（避免整文件重写）
5. **权限模式预设**：`plan` / `acceptEdits` 等一键模式（我们的 Policy 已能表达，补 UI 预设）

## 5. 结论

Claude Code 的"源码"解读，最有价值的三点：

1. **工业化分发**：原生二进制 + 平台矩阵（我们实际拆包验证），说明成熟 CLI 产品的分发路径
2. **权限即循环核心**：permission 模式不是附加功能，而是贯穿 Agent Loop 的主干 —— xuanji 的策略引擎正是同一哲学
3. **可观测与可恢复**：一切落盘（会话/checkpoint），一切可恢复 —— 与 xuanji 的轨迹/重放理念同源

作为一个从零实现的 Agent Harness，**对照商业产品不是为了复刻，而是确认架构方向正确、并找出真正值得补的差距**（子代理、会话恢复、Hooks）。
