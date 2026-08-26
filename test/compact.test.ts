/**
 * Context compaction tests: token estimation, layered strategy
 * (trim tool results → fold oldest turns), and loop integration
 * (budget-driven trigger + observable event).
 */

import { describe, expect, it } from 'vitest';
import { Agent } from '../src/loop/agent.js';
import { MockProvider } from '../src/llm/mock.js';
import { ToolRegistry } from '../src/tools/tool.js';
import { estimateMessagesTokens, estimateTokens } from '../src/loop/budget.js';
import { compactMessages, isOverBudget } from '../src/loop/compact.js';
import type { AgentEvent } from '../src/loop/events.js';
import type { Message } from '../src/types.js';

describe('estimateTokens', () => {
  it('estimates CJK-heavy text heavier than ASCII', () => {
    expect(estimateTokens('天气怎么样')).toBeGreaterThan(estimateTokens('hello'));
    expect(estimateTokens('')).toBe(0);
  });

  it('is deterministic and monotonic', () => {
    const a = estimateTokens('中文混合 mixed content 混合');
    expect(a).toBe(estimateTokens('中文混合 mixed content 混合'));
    expect(estimateTokens('a'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(10)));
  });
});

describe('compactMessages', () => {
  function makeMessages(): Message[] {
    return [
      { role: 'system', content: 'system' },
      { role: 'user', content: '第一轮问题' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'fs.read_file', arguments: { path: 'a.txt' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(20_000) }, // huge result
      { role: 'assistant', content: '第一轮的回答内容' },
      { role: 'user', content: '第二轮问题' },
      { role: 'assistant', content: '第二轮的回答内容' },
    ];
  }

  it('trims oversized tool results first', () => {
    const result = compactMessages(makeMessages(), {
      maxContextTokens: 100_000,
      maxToolResultChars: 1_000,
    });
    const toolMsg = result.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content?.startsWith('x'.repeat(1_000))).toBe(true);
    expect(toolMsg.content).toContain('已截断');
    expect(result.trimmedResults).toBe(1);
  });

  it('folds the oldest turns when over budget', () => {
    const result = compactMessages(makeMessages(), { maxContextTokens: 20 });
    expect(result.foldedTurns).toBeGreaterThan(0);
    const summary = result.messages.find((m) => m.content?.startsWith('[上下文已压缩]'));
    expect(summary).toBeDefined();
    // system survives; the summary carries the tool sequence; nothing crashes
    expect(result.messages.some((m) => m.role === 'system')).toBe(true);
    expect(result.messages.some((m) => m.content?.includes('fs.read_file'))).toBe(true);
    // messages shrank meaningfully
    expect(result.messages.length).toBeLessThan(makeMessages().length);
  });

  it('compresses back within budget when the budget is feasible', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '问题一' },
      { role: 'tool', toolCallId: 'c1', content: 'z'.repeat(20_000) },
      { role: 'assistant', content: '回答一' },
      { role: 'user', content: '问题二' },
      { role: 'assistant', content: '回答二' },
    ];
    const result = compactMessages(msgs, { maxContextTokens: 500, maxToolResultChars: 2_000 });
    expect(result.foldedTurns).toBeGreaterThan(0);
    expect(isOverBudget(result.messages, 1_000)).toBe(false);
    expect(result.messages[0]?.role).toBe('system');
  });

  it('never deletes the system prompt or an unpaired trailing user', () => {
    const msgs: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2-tail' },
    ];
    const result = compactMessages(msgs, { maxContextTokens: 1 });
    expect(result.messages[0]?.role).toBe('system');
    // the trailing user has no assistant reply, so it cannot be folded away
    expect(result.messages.at(-1)?.content).toBe('u2-tail');
  });
});

describe('loop integration', () => {
  it('triggers compaction when the budget is exceeded and emits an event', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'big',
      description: 'returns a huge result',
      inputSchema: { type: 'object' },
      async execute() {
        return { ok: true, data: 'y'.repeat(50_000) };
      },
    });

    const events: AgentEvent[] = [];
    const provider = new MockProvider({
      turns: [
        { toolCalls: [{ id: 'c1', name: 'big', arguments: {} }] },
        { content: '最终回答' },
      ],
    });

    const agent = new Agent({
      provider,
      tools: registry,
      compaction: { maxContextTokens: 500, maxToolResultChars: 100 },
      onEvent: (e) => events.push(e),
    });

    const result = await agent.run('go');
    expect(result.status).toBe('ok');

    const compacted = events.filter((e) => e.type === 'context.compacted');
    expect(compacted.length).toBeGreaterThan(0);
    const first = compacted[0] as Extract<AgentEvent, { type: 'context.compacted' }>;
    expect(first.afterTokens).toBeLessThan(first.beforeTokens);
    expect(first.trimmedResults).toBeGreaterThan(0);

    // the oversized tool result was trimmed inside the transcript
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content?.length).toBeLessThan(10_000);
    expect(toolMsg?.content).toContain('已截断');
  });

  it('does nothing when under budget', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockProvider({ turns: [{ content: 'ok' }] });
    const agent = new Agent({
      provider,
      compaction: { maxContextTokens: 100_000 },
      onEvent: (e) => events.push(e),
    });
    const result = await agent.run('hi');
    expect(result.status).toBe('ok');
    expect(events.some((e) => e.type === 'context.compacted')).toBe(false);
  });

  it('estimates message tokens consistently', () => {
    const msgs: Message[] = [
      { role: 'user', content: '你好 world' },
      { role: 'assistant', content: '回答内容' },
    ];
    const sum = msgs.reduce((acc, m) => acc + estimateTokens(m.content ?? ''), 0);
    expect(estimateMessagesTokens(msgs)).toBe(sum);
  });
});
