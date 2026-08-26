/**
 * Context compaction — a layered, budget-driven strategy.
 *
 * When the estimated context exceeds the configured budget, messages are
 * reduced in escalating layers (cheapest first):
 *   1. trimToolResults — truncate oversized tool-result messages;
 *   2. foldTurns — collapse the OLDEST user+assistant turns (and their tool
 *      messages) into a single lossy summary message, until back in budget.
 *
 * The fold step is deliberately MODEL-FREE (a deterministic summary from the
 * event data: tool sequence + final answer head) so the whole mechanism is
 * offline-testable; an LLM-based summarizer is a drop-in extension.
 */

import type { Message } from '../types.js';
import { estimateMessagesTokens, estimateTokens } from './budget.js';

export interface CompactionOptions {
  /** Context budget in estimated tokens. When exceeded, compaction triggers. */
  maxContextTokens: number;
  /** Layer 1: truncate tool results longer than this many characters. */
  trimToolResults?: boolean;
  maxToolResultChars?: number;
}

export interface CompactedResult {
  messages: Message[];
  beforeTokens: number;
  afterTokens: number;
  foldedTurns: number;
  trimmedResults: number;
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 4_000;
const SUMMARY_HEAD = 120; // chars of the final answer kept in a folded summary

export function compactMessages(messages: Message[], opts: CompactionOptions): CompactedResult {
  const beforeTokens = estimateMessagesTokens(messages);
  let msgs = messages.map((m) => ({ ...m }));
  let trimmedResults = 0;

  // Layer 1: trim oversized tool results (cheap, lossy but safe).
  if (opts.trimToolResults !== false) {
    const maxChars = opts.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    msgs = msgs.map((m) => {
      if (m.role === 'tool' && m.content && m.content.length > maxChars) {
        trimmedResults++;
        return { ...m, content: `${m.content.slice(0, maxChars)}\n… [已截断，保留 ${maxChars} 字符]` };
      }
      return m;
    });
  }

  // Layer 2: fold the oldest turns until back within budget.
  let foldedTurns = 0;
  while (estimateMessagesTokens(msgs) > opts.maxContextTokens) {
    const idx = firstFoldableTurn(msgs);
    if (idx < 0) break;
    msgs = foldTurn(msgs, idx);
    foldedTurns++;
  }

  return {
    messages: msgs,
    beforeTokens,
    afterTokens: estimateMessagesTokens(msgs),
    foldedTurns,
    trimmedResults,
  };
}

/** Index of the first user message that starts a foldable turn (has an assistant reply). */
function firstFoldableTurn(msgs: Message[]): number {
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i]?.role !== 'user') continue;
    // scan forward for its assistant reply
    for (let j = i + 1; j < msgs.length; j++) {
      const r = msgs[j]?.role;
      if (r === 'assistant') return i;
      if (r === 'user') break; // next user without an assistant reply — skip
    }
  }
  return -1;
}

/**
 * Replace msgs[start..turnEnd] with a single summary user message.
 * A turn may span several messages (user → assistant(tool calls) → tool
 * results → assistant(final answer)); all of them are folded and the summary
 * is rebuilt from the events: tool sequence + final answer head.
 */
function foldTurn(msgs: Message[], start: number): Message[] {
  const toolNames: string[] = [];
  let answer = '';
  let end = start;

  for (let j = start; j < msgs.length; j++) {
    const m = msgs[j]!;
    if (m.role === 'tool') {
      end = j;
      continue;
    }
    if (m.role === 'assistant') {
      end = j;
      for (const tc of m.toolCalls ?? []) toolNames.push(tc.name);
      if (m.content) answer = m.content;
      // Do NOT break: a turn has a trailing "final answer" assistant message
      // after its tool-call assistant message — keep folding until the next user.
      continue;
    }
    if (m.role === 'user' && j > start) break;
    end = j;
  }

  const head = answer ? `，结论："${answer.slice(0, SUMMARY_HEAD)}"` : '';
  const seq = toolNames.length > 0 ? `，调用工具: ${toolNames.join('→')}` : '';
  const summary = `[上下文已压缩] 此前的对话回合${seq}${head}（详情见轨迹）`;

  return [...msgs.slice(0, start), { role: 'user' as const, content: summary }, ...msgs.slice(end + 1)];
}

/** Convenience: whether a message list is over budget. */
export function isOverBudget(messages: Message[], maxTokens: number): boolean {
  return estimateMessagesTokens(messages) > maxTokens;
}
