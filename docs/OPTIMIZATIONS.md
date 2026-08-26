# 三大可靠性优化 —— 技术实现详解

> 对应 xuanji 简历亮点中的三项稀缺优化：**轨迹记录与离线重放（Trace & Replay）**、**Token 预算驱动的上下文压缩（Compaction）**、**参数级最小权限策略（Policy）**。
> 本文件包含：每个优化的技术实现（核心代码）、作用、测试方法、测试数据集与测试结果。

---

## 0. 总览：为什么是这三件事

agent 生产落地有三大障碍，对应三大优化：

| 障碍 | 优化 | 一句话效果 |
|---|---|---|
| 非确定性，**不可测** | 轨迹记录与离线重放 | 运行可固化、可重放、可回归比对 |
| token 成本**失控** | 预算驱动的上下文压缩 | 长会话 token 峰值 ↓96% |
| 危险操作**不可控** | 参数级最小权限策略 | 危险命令拦截、高风险调用人工审批 |

三者共用同一个地基：**类型化事件流（AgentEvent）** —— 事件流既是轨迹的记录对象，也是压缩的触发信号源，还是审批推送的通道。

---

## 1. 轨迹记录与离线重放（Trace & Replay）

### 1.1 技术实现

**数据模型**：一次运行 = 一个 JSONL 文件。第一行是元数据，之后每行一个事件。

```jsonl
{"type":"trace.meta","v":1,"id":"tr_xxx","startedAt":"2026-...","input":"帮我查一下文件","provider":"mock","model":"m"}
{"type":"agent.start","input":"帮我查一下文件"}
{"type":"turn.start","iteration":1}
{"type":"llm.turn","message":{"role":"assistant","content":null,"toolCalls":[{"id":"c1","name":"fs.list_dir","arguments":{}}]},"usage":{"promptTokens":10,"completionTokens":5,"totalTokens":15}}
{"type":"tool.call","name":"fs.list_dir","args":{},"callId":"c1"}
{"type":"tool.result","name":"fs.list_dir","callId":"c1","result":{"ok":true,"data":[...]},"durationMs":2}
{"type":"turn.start","iteration":2}
{"type":"agent.done","result":{"status":"ok","iterations":2,"toolCalls":1,"usage":{"totalTokens":38}}}
```

**记录器（`src/trace.ts`）** —— 订阅事件流，序列化落盘：

```ts
export class TraceRecorder {
  onEvent(event: AgentEvent): void { this.events.push(event); }   // 挂到 Agent 的 onEvent
  toJSONL(): string { /* meta 行 + 事件逐行 JSON */ }
  static parse(text): { meta; events }                            // 校验版本、首行
  static async load(file): Promise<LoadedTrace>
}
```

**重放器（`src/replay.ts`）** —— 三个纯函数，不调模型：

```ts
// 1. 顺序校验：轨迹必须是合法的事件序列
export function validateEventOrder(events: AgentEvent[]): string[] {
  // 规则：agent.start 必须首位；agent.done 必须结尾；
  //       tool.result/error 必须存在对应的 tool.call（未闭环 = 违规）；
  //       turn.start 出现时不能有悬挂的工具调用。
}

// 2. 离线统计：从事件重建指标（不执行任何工具/不调 LLM）
export function summarizeEvents(events: AgentEvent[]): ReplaySummary {
  // status（agent.done）、iterations（turn.start）、toolCalls、toolSequence（tool.call 的 name 序列）
  // tokens（llm.turn 的 usage 累加）、eventCount、violations
}

// 3. 黄金轨迹比对：检出行为漂移
export function compareTraces(golden: AgentEvent[], actual: AgentEvent[]): TraceDiff {
  // 对比：最终状态、轮次、工具调用次数、工具序列（逐位）、token 总量
}
```

**集成点**：
- `xuanji run --trace out.jsonl` —— 运行并记录
- `xuanji replay out.jsonl` —— 离线重放，输出统计 + 顺序校验
- `xuanji trace diff golden.jsonl actual.jsonl` —— 黄金比对，差异时退出码非 0（可接 CI）

### 1.2 作用

- **测试**：agent 行为从"不可预测"变成"可断言" —— 工具调用序列是 agent 的行为签名
- **调试**：轨迹文件即"运行回放"，复现问题不用重新跑模型（省钱省时）
- **回归**：CI 里跑一次 → 存为黄金轨迹 → 每次改动后 diff，检出"这次改动让 agent 多调/少调了工具"
- **成本审计**：轨迹里的 usage 是精确的 token 账单

### 1.3 测试是怎么做的

**思路**：用构造的事件序列（手工数据集）喂给纯函数，断言统计/校验/比对结果 —— 完全离线、确定性。

**测试数据集**（`test/trace.test.ts` 中的 `sampleEvents()`）：手工构造一次"工具调用 → 最终回答"的完整合法轨迹（7 个事件，含 usage）。

**用例与断言（9 个）**：

| 用例 | 数据集/输入 | 断言 |
|---|---|---|
| 记录器 JSONL 往返 | recorder.save → load | meta 字段一致、事件数一致、首尾事件类型正确 |
| 非法轨迹拒绝 | 空文件 / 缺 meta / 版本 999 | 抛错（为空 / trace.meta / 版本不兼容） |
| 离线统计 | sampleEvents() | status=ok、iterations=2、toolCalls=1、toolSequence=['echo']、tokens=38 |
| 顺序校验：缺头尾 | 去掉 agent.start/agent.done | 报告"必须出现在首位/结尾" |
| 顺序校验：悬挂调用 | 去掉 tool.call | 报告"无对应 call" |
| 黄金比对：一致 | 同一份事件 | identical=true |
| 黄金比对：工具漂移 | 改一个 tool.call 的名字 | 报告"工具序列[0]不同" |
| 黄金比对：状态漂移 | 改 agent.done 的 status | 报告"最终状态不同" |
| 端到端确定性 | MockProvider 脚本 turns 跑真实 Agent | replay 统计 == result 统计、violations 为空 |

**测试结果**：9/9 通过；CLI 实测（mock 确定性）：

```
$ xuanji replay /tmp/run1.jsonl
状态: ok | 轮次: 1 | 工具调用: 0 | tokens: 0 | 事件数: 4
顺序校验: ✅ 事件序列合法

$ xuanji trace diff /tmp/run1.jsonl /tmp/run2.jsonl
✅ 行为一致（状态/轮次/工具序列/token 全部匹配）
```

---

## 2. Token 预算驱动的上下文压缩（Compaction）

### 2.1 技术实现

**零依赖估算器（`src/loop/budget.ts`）**：

```ts
export function estimateTokens(text: string): number {
  // CJK 字符约 1 token/字；ASCII 约 3.5 字符/token —— 确定性启发式
  for (const ch of text) if (是CJK) cjk++; else ascii++;
  return Math.ceil(cjk + ascii / 3.5);
}
export function estimateMessagesTokens(messages): number { /* 含 toolCalls 参数 */ }
```

**分层压缩策略（`src/loop/compact.ts`）** —— 超预算时逐层降级，便宜的先做：

```ts
export function compactMessages(messages, opts): CompactedResult {
  // 层 1：裁剪超长工具结果（低成本、安全）
  msgs = msgs.map(m => m.role==='tool' && 超长 ? truncate(m, maxToolResultChars) : m);

  // 层 2：折叠最旧轮次为结构化摘要（无模型、可离线测）
  while (estimateMessagesTokens(msgs) > maxContextTokens) {
    msgs = foldTurn(msgs, firstFoldableTurn(msgs));
  }
}

// foldTurn 摘要从事件重建 —— 不依赖 LLM：
//   "[上下文已压缩] 此前的对话回合，调用工具: fs.list_dir→fs.read_file，结论："…"（详情见轨迹）"
// 修复过的边界：一个 turn 含"工具调用 assistant + 结果 + 最终回答 assistant"多条消息，
// 折叠必须吃完整轮，否则工具序列会丢（真实 bug，被测试抓到后修复）。
```

**Loop 集成（`src/loop/agent.ts`）** —— 每轮 `turn.start` 后、调模型前检查：

```ts
private maybeCompact(state, emitter) {
  if (!opts.compaction) return;
  if (!isOverBudget(state.messages, opts.maxContextTokens)) return;   // 未超预算零开销
  const r = compactMessages(state.messages, opts);
  state.messages = r.messages;
  emitter.emit({ type: 'context.compacted', beforeTokens, afterTokens, foldedTurns, trimmedResults });
}
```

**配置**：`budget.maxContextTokens`（预算）/ `trimToolResults` / `maxToolResultChars`。

### 2.2 作用

- **成本**：长会话 token 峰值显著下降（实测 ↓96%），省 token 即省钱
- **不丢关键信息**：摘要保留"工具序列 + 结论"，折叠掉的是细节不是语义骨架
- **确定性**：压缩是可复现的纯函数，不引入 LLM 摘要的不确定性
- **可观测**：`context.compacted` 事件让"压缩发生了什么"透明可见

### 2.3 测试是怎么做的

**数据集**（`test/compact.test.ts`）：`makeMessages()` 构造 7 条消息（system + 2 轮对话，其中一轮带 20,000 字符的超大工具结果）+ 真实长会话场景。

**用例与断言（9 个）**：

| 用例 | 输入/数据集 | 断言 |
|---|---|---|
| 估算器：CJK 比 ASCII 重 | "天气怎么样" vs "hello" | 前者估算更大；空串为 0 |
| 估算器：确定且单调 | 同串两次 / 不同长度 | 相等 / 更长串更大 |
| 层 1：裁剪工具结果 | makeMessages + 预算 100k、maxChars 1000 | 工具消息以 1000 个 x 开头、含"已截断"、trimmedResults=1 |
| 层 2：折叠旧轮 | makeMessages + 预算 20 | foldedTurns>0、含"[上下文已压缩]"、摘要含工具序列、消息数减少 |
| 预算可行时压回预算内 | 构造 6 条消息 + 预算 500 | foldedTurns>0、压后 estimate <= 500、system 保留 |
| 保护：不删 system/未配对 user | [system, u1, a1, u2-tail] + 预算 1 | system 在首位、尾部 u2-tail 不被删 |
| Loop 集成：触发压缩 | 大结果工具 + 预算 500 + MockProvider | 发出 context.compacted 事件、after<before、trimmedResults>0、transcript 里工具结果已截断 |
| Loop 集成：预算内不动 | 小对话 + 预算 100k | 无 compacted 事件 |
| 消息估算一致性 | 两条消息 | 逐条之和 == 整体估算 |

**测试结果**：9/9 通过；量化实测（8 轮长会话，每轮 8k 字符工具结果）：

```
压缩前估算 tokens : 29990
压缩后估算 tokens : 1240   （↓ 96%）
裁剪工具结果数    : 8
折叠旧轮次数      : 6
消息条数          : 33 → 15
```

---

## 3. 参数级最小权限策略（Policy）

### 3.1 技术实现

**规则模型（`src/policy.ts`）** —— 声明式 JSON：

```ts
interface PolicyRule {
  tool: string;                              // 精确名或通配："shell.*"、"*"
  action: 'allow' | 'deny' | 'ask';
  when?: Record<string, { equals?: unknown; matches?: string }>;  // 参数条件
  reason?: string;
}
```

**引擎** —— 规则按顺序、**首个匹配生效**：

```ts
export class PolicyEngine {
  decide(toolName, args): { decision, rule?, reason? } {
    for (const rule of config.rules) {
      if (!toolMatches(rule.tool, toolName)) continue;      // glob 匹配
      if (rule.when && !whenMatches(args, rule.when)) continue;  // 参数条件全中才生效
      return { decision: rule.action, ... };
    }
    return { decision: config.defaultAction ?? 'allow' };    // 无匹配回退默认
  }
}
```

**Loop 集成（`src/loop/agent.ts`）** —— 工具执行前裁决：

```ts
const policy = this.opts.policy?.decide(call.name, call.arguments);
if (policy?.decision === 'deny') {
  result = { ok: false, error: `[策略拒绝] ...（${reason}）` };   // 不执行，错误回喂模型
} else if (policy?.decision === 'ask') {
  result = await this.requestApproval(call, policy, runOpts);      // 人工审批
} else {
  result = await this.executeWithTimeout(call, runOpts);           // 放行
}
```

**审批流（fail-closed）**：

```ts
// Agent 层：没有审批回调 → 默认拒绝
if (!this.opts.onApproval) return { ok: false, error: '需要人工确认（无审批回调，已默认拒绝）' };

// 工作台（src/server/session.ts）：SSE 推帧 + pending 表 + 超时
onApproval: (req) => new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => { pending.delete(req.id); resolve(false); }, 120_000);
  pending.set(req.id, resolve);                    // POST /api/approval 时触发
  emit({ type: 'approval.request', request: req }); // 推给前端弹窗
});

// CLI：TTY 下 readline 问 y/n；非 TTY 默认拒绝
```

**示例策略**（`examples/xuanji.policy.json`）：

```json
{ "rules": [
  { "tool": "shell.*", "when": { "command": { "matches": "rm -rf|git push|:(){|mkfs|dd if=" } },
    "action": "deny", "reason": "危险命令，禁止执行" },
  { "tool": "shell.*", "action": "ask", "reason": "执行任意 shell 命令需要确认" },
  { "tool": "fs.read_file", "action": "allow" },
  { "tool": "fs.write_file", "action": "ask", "reason": "写文件需要确认" }
], "defaultAction": "allow" }
```

### 3.2 作用

- **安全**：危险命令（rm -rf 等）参数级拦截，不等到执行后才后悔
- **最小权限**：按"工具 + 参数"细粒度放行 —— 读放行、写审批、shell 更严，而不是一刀切
- **人机协同**：高风险操作交给人拍板（允许一次/拒绝），低风险自动执行，不打断流程
- **fail-closed**：没有审批通道时默认拒绝 —— 安全优先于可用性

### 3.3 测试是怎么做的

**数据集**（`test/policy.test.ts`）：`CFG` 规则集（4 条规则 + defaultAction）作为策略引擎的输入。

**用例与断言（10 个）**：

| 用例 | 输入 | 断言 |
|---|---|---|
| 参数条件拒绝 | `shell.run` + `rm -rf /tmp/x` | decision=deny、命中 deny-rm 规则 |
| 规则顺序（首个匹配胜） | `shell.run` + `npm test` | decision=ask（未命中 deny 条件） |
| 显式 allow + 默认值 | `fs.read_file` / `web.search` | allow / 回退 allow |
| when 只在命中时生效 | `fs.write_file` path=/etc/hosts vs src/a.ts | ask vs allow |
| defaultAction=deny | 空规则集 | 一律 deny |
| glob 匹配 | `shell.run2` | ask（shell.* 命中） |
| **Agent 集成：deny 不执行** | Mock turns 调 rm -rf | tool 消息含"策略拒绝"+"危险命令"，工具未执行 |
| **Agent 集成：ask + 允许** | onApproval 返回 true | 回调收到请求、工具实际执行、结果回填 |
| **Agent 集成：ask + 拒绝** | onApproval 返回 false | tool 消息含"被用户拒绝" |
| **Agent 集成：无回调 fail-closed** | 不传 onApproval | tool 消息含"需要人工确认" |

**测试结果**：10/10 通过；CLI 实测（mock 脚本化 turns）：

```
[工具结果] [tool error] [策略拒绝] shell.run 被安全策略拦截（危险命令，禁止执行）  ← rm -rf 直接拦
👤 审批弹窗: 允许执行 shell.run {"command":"npm test"}? → 用户点了「允许」
[工具结果] 执行了: npm test                                                        ← 审批后执行
```

---

## 4. 三件套如何协同（面试讲这条线）

1. **事件流是地基**：三个优化都构建在 `AgentEvent` 之上 —— 轨迹记录它、压缩通过它可观测、审批通过它推送
2. **互相增强**：子任务的轨迹可回归（Trace）→ 压缩让长任务不爆上下文（Compaction）→ 子任务权限按角色管控（Policy）
3. **统一 CLI/CI 入口**：`run --trace` 产出黄金轨迹；`replay`/`trace diff` 是 CI 回归步骤；策略与预算都是声明式配置

## 5. 相关测试统计

- 轨迹（Trace & Replay）：`test/trace.test.ts` — 9 个用例
- 压缩（Compaction）：`test/compact.test.ts` — 9 个用例
- 策略（Policy）：`test/policy.test.ts` — 10 个用例
- 全项目：13 个测试文件、126 个用例，全部离线通过（`npm test`）
