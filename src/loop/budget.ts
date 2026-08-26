/**
 * Token estimation — dependency-free heuristics used for context budgeting.
 *
 * Not a tokenizer: a cheap, deterministic estimate is enough to drive budget
 * decisions (trigger compaction, cap tool results). Chinese ~1 token/char,
 * English ~4 chars/token → we approximate with len/2.5 blended by content.
 */

import type { Message } from '../types.js';

/** Rough token estimate for a text (deterministic, no deps). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // CJK characters are ~1 token each; ASCII ~4 chars/token.
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else ascii++;
  }
  return Math.ceil(cjk + ascii / 3.5);
}

/** Total token estimate for a message list. */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content ?? '');
    for (const tc of m.toolCalls ?? []) {
      total += estimateTokens(JSON.stringify(tc.arguments));
    }
  }
  return total;
}
