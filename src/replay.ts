/**
 * Replay & golden-trace diffing.
 *
 * A recorded trace can be replayed OFFLINE (no model calls) to:
 *  - validate event ordering (a malformed run is a bug in the harness);
 *  - compute deterministic statistics (iterations, tool calls, tokens,
 *    tool-call sequence) for regression assertions;
 *  - diff an actual trace against a golden trace to catch behavior drift —
 *    the agent-testing equivalent of a snapshot test.
 */

import type { AgentEvent } from './loop/events.js';
import { emptyUsage, addUsage, type TokenUsage } from './types.js';

export interface ReplaySummary {
  status: string | null;
  iterations: number;
  toolCalls: number;
  tokens: TokenUsage;
  /** Tool names in exact call order (reconstructed from tool.call events). */
  toolSequence: string[];
  eventCount: number;
  /** Any ordering violations found during validation. */
  violations: string[];
}

/** Validate that an event stream follows the loop's legal order. */
export function validateEventOrder(events: AgentEvent[]): string[] {
  const violations: string[] = [];
  let openCalls = new Set<string>();

  for (const e of events) {
    switch (e.type) {
      case 'agent.start':
        if (events[0] !== e) violations.push('agent.start 必须出现在首位');
        break;
      case 'turn.start': {
        if (openCalls.size > 0) {
          violations.push(`turn.start 出现时仍有未结束的工具调用: ${[...openCalls].join(', ')}`);
        }
        break;
      }
      case 'tool.call':
        if (openCalls.has(e.callId)) violations.push(`重复的 tool.call: ${e.callId}`);
        openCalls.add(e.callId);
        break;
      case 'tool.result':
      case 'tool.error':
        if (!openCalls.has(e.callId)) {
          violations.push(`tool.result/error 无对应 call: ${e.callId}`);
        } else {
          openCalls.delete(e.callId);
        }
        break;
      case 'agent.done':
        if (openCalls.size > 0) violations.push(`agent.done 时仍有未结束工具调用: ${[...openCalls].join(', ')}`);
        break;
      default:
        break;
    }
  }

  const last = events[events.length - 1];
  if (last?.type !== 'agent.done') violations.push('轨迹必须以 agent.done 结束');
  const first = events[0];
  if (first?.type !== 'agent.start') violations.push('轨迹必须以 agent.start 开始');
  return violations;
}

/** Offline statistics over a recorded trace (no model calls). */
export function summarizeEvents(events: AgentEvent[]): ReplaySummary {
  const violations = validateEventOrder(events);
  const tokens = emptyUsage();
  const toolSequence: string[] = [];
  let iterations = 0;
  let toolCalls = 0;
  let status: string | null = null;

  for (const e of events) {
    switch (e.type) {
      case 'turn.start':
        iterations = Math.max(iterations, e.iteration);
        break;
      case 'tool.call':
        toolCalls++;
        toolSequence.push(e.name);
        break;
      case 'llm.turn':
        addUsage(tokens, e.usage);
        break;
      case 'agent.done':
        status = e.result.status;
        iterations = Math.max(iterations, e.result.iterations);
        toolCalls = Math.max(toolCalls, e.result.toolCalls);
        break;
      default:
        break;
    }
  }

  return { status, iterations, toolCalls, tokens, toolSequence, eventCount: events.length, violations };
}

export interface TraceDiff {
  identical: boolean;
  /** Human-readable differences (empty when identical). */
  differences: string[];
}

/**
 * Compare an actual trace against a golden one. Differences reported:
 * final status, iterations, tool-call sequence (the key behavior signature),
 * and token totals (mock runs are deterministic, so exact equality holds).
 */
export function compareTraces(golden: AgentEvent[], actual: AgentEvent[]): TraceDiff {
  const differences: string[] = [];
  const g = summarizeEvents(golden);
  const a = summarizeEvents(actual);

  if (g.status !== a.status) differences.push(`最终状态不同: golden=${g.status} actual=${a.status}`);
  if (g.iterations !== a.iterations) differences.push(`轮次不同: golden=${g.iterations} actual=${a.iterations}`);
  if (g.toolCalls !== a.toolCalls) differences.push(`工具调用次数不同: golden=${g.toolCalls} actual=${a.toolCalls}`);

  const seqLen = Math.max(g.toolSequence.length, a.toolSequence.length);
  for (let i = 0; i < seqLen; i++) {
    if (g.toolSequence[i] !== a.toolSequence[i]) {
      differences.push(`工具序列[${i}]不同: golden=${g.toolSequence[i] ?? '(无)'} actual=${a.toolSequence[i] ?? '(无)'}`);
    }
  }

  if (g.tokens.totalTokens !== a.tokens.totalTokens) {
    differences.push(`token 总量不同: golden=${g.tokens.totalTokens} actual=${a.tokens.totalTokens}`);
  }

  return { identical: differences.length === 0, differences };
}
