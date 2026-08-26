/**
 * Trace report — render a recorded trace as a human-readable markdown
 * "link view": full timeline with LLM turns, tool calls (name/args/duration/
 * result), token accounting and anomalies — the debugging companion to
 * offline replay (链路回放/调试工具).
 */

import type { LoadedTrace } from './trace.js';
import type { AgentEvent } from './loop/events.js';
import { summarizeEvents } from './replay.js';
import { stringify } from './utils.js';

export function renderTraceReport(trace: LoadedTrace): string {
  const s = summarizeEvents(trace.events);
  const lines: string[] = [];

  lines.push(`# 链路报告 — ${trace.meta.id}`);
  lines.push('');
  lines.push(`- 输入: ${trace.meta.input}`);
  lines.push(`- 开始时间: ${trace.meta.startedAt}`);
  if (trace.meta.provider) lines.push(`- provider: ${trace.meta.provider} / model: ${trace.meta.model ?? '-'}`);
  lines.push(`- 状态: ${s.status} | 轮次: ${s.iterations} | 工具调用: ${s.toolCalls}`);
  lines.push(`- token: ${s.tokens.promptTokens} prompt / ${s.tokens.completionTokens} completion / ${s.tokens.totalTokens} total`);
  lines.push('');

  if (s.violations.length > 0) {
    lines.push('## ⚠ 顺序校验异常');
    for (const v of s.violations) lines.push(`- ${v}`);
    lines.push('');
  }

  lines.push('## 时间线');
  lines.push('');
  let turn = 0;
  let pending: { name: string; callId: string; started?: number } | null = null;
  for (const e of trace.events) {
    switch (e.type) {
      case 'turn.start':
        turn = e.iteration;
        lines.push(`### 轮次 ${turn}`);
        break;
      case 'llm.turn':
        if (e.message.toolCalls?.length) {
          lines.push(`- LLM 请求调用工具: ${e.message.toolCalls.map((t) => t.name).join(', ')}`);
        } else if (e.message.content) {
          lines.push(`- LLM 输出: ${oneLine(e.message.content, 120)}`);
        }
        if (e.usage) lines.push(`  - token: ${e.usage.promptTokens} + ${e.usage.completionTokens}`);
        break;
      case 'tool.call':
        pending = { name: e.name, callId: e.callId };
        lines.push(`- 🔧 **${e.name}** \`${oneLine(stringify(e.args, 100), 100)}\``);
        break;
      case 'tool.result':
        if (pending?.callId === e.callId) pending = null;
        lines.push(`  - ✅ 完成 (${e.durationMs}ms) → ${oneLine(stringify(e.result.ok ? e.result.data : e.result.error, 100), 100)}`);
        break;
      case 'tool.error':
        if (pending?.callId === e.callId) pending = null;
        lines.push(`  - ❌ 失败: ${e.error.message}`);
        break;
      case 'context.compacted':
        lines.push(`- 📦 上下文压缩: ${e.beforeTokens} → ${e.afterTokens} tokens（折叠 ${e.foldedTurns} 轮 / 裁剪 ${e.trimmedResults} 个结果）`);
        break;
      case 'agent.done':
        lines.push('');
        lines.push(`### 结果: ${e.result.status}`);
        if (e.result.error) lines.push(`- 错误: ${e.result.error.message}`);
        break;
      default:
        break;
    }
  }
  lines.push('');

  if (s.toolSequence.length > 0) {
    lines.push('## 工具调用序列');
    lines.push('');
    lines.push(`\`${s.toolSequence.join(' → ')}\``);
    lines.push('');
  }

  return lines.join('\n');
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
