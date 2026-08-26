/**
 * Trace & Replay tests: recorder round-trip, offline stats, event-order
 * validation, golden-trace diffing, and an end-to-end deterministic replay
 * of a real (mock) agent run.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/loop/agent.js';
import { MockProvider } from '../src/llm/mock.js';
import { ToolRegistry } from '../src/tools/tool.js';
import { TraceRecorder } from '../src/trace.js';
import { compareTraces, summarizeEvents, validateEventOrder } from '../src/replay.js';
import type { AgentEvent } from '../src/loop/events.js';
import type { Message, ToolCall } from '../src/types.js';

function echoRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(input) {
      const { text } = input as { text: string };
      return { ok: true, data: `echo:${text}` };
    },
  });
  return r;
}

function sampleEvents(): AgentEvent[] {
  const tc: ToolCall = { id: 'c1', name: 'echo', arguments: { text: 'hi' } };
  const user: Message = { role: 'user', content: 'go' };
  const asst: Message = { role: 'assistant', content: null, toolCalls: [tc] };
  return [
    { type: 'agent.start', input: 'go' },
    { type: 'turn.start', iteration: 1 },
    { type: 'llm.turn', message: asst, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { type: 'tool.call', name: 'echo', args: { text: 'hi' }, callId: 'c1' },
    { type: 'tool.result', name: 'echo', callId: 'c1', result: { ok: true, data: 'echo:hi' }, durationMs: 1 },
    { type: 'turn.start', iteration: 2 },
    {
      type: 'llm.turn',
      message: { role: 'assistant', content: 'done', toolCalls: [] },
      usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 },
    },
    {
      type: 'agent.done',
      result: {
        status: 'ok',
        output: 'done',
        messages: [],
        iterations: 2,
        toolCalls: 1,
        usage: { promptTokens: 30, completionTokens: 8, totalTokens: 38 },
      },
    },
  ];
}

describe('TraceRecorder', () => {
  it('round-trips through JSONL (save → load)', async () => {
    const rec = new TraceRecorder();
    rec.setContext({ input: 'go', provider: 'mock', model: 'm' });
    for (const e of sampleEvents()) rec.onEvent(e);

    const file = path.join(os.tmpdir(), `trace-${Date.now()}.jsonl`);
    await rec.save(file);
    try {
      const loaded = await TraceRecorder.load(file);
      expect(loaded.meta.input).toBe('go');
      expect(loaded.meta.provider).toBe('mock');
      expect(loaded.events).toHaveLength(sampleEvents().length);
      expect(loaded.events[0]?.type).toBe('agent.start');
      expect(loaded.events[loaded.events.length - 1]?.type).toBe('agent.done');
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it('rejects malformed traces', () => {
    expect(() => TraceRecorder.parse('{"type":"whatever"}')).toThrow(/trace.meta/);
    expect(() => TraceRecorder.parse('')).toThrow(/为空/);
    expect(() =>
      TraceRecorder.parse('{"type":"trace.meta","v":999,"id":"x","startedAt":"","input":""}'),
    ).toThrow(/版本不兼容/);
  });
});

describe('summarizeEvents (offline replay)', () => {
  it('computes stats without calling any model', () => {
    const s = summarizeEvents(sampleEvents());
    expect(s.status).toBe('ok');
    expect(s.iterations).toBe(2);
    expect(s.toolCalls).toBe(1);
    expect(s.toolSequence).toEqual(['echo']);
    expect(s.tokens.totalTokens).toBe(38);
    expect(s.violations).toEqual([]);
  });
});

describe('validateEventOrder', () => {
  it('flags missing start/end and dangling tool calls', () => {
    const bad = sampleEvents().slice(1, -1); // drop agent.start & agent.done
    const violations = validateEventOrder(bad);
    expect(violations.some((v) => v.includes('agent.start'))).toBe(true);
    expect(violations.some((v) => v.includes('agent.done'))).toBe(true);
  });

  it('flags tool.result without a matching call', () => {
    const events = sampleEvents();
    const withDangling = events.filter((e) => !(e.type === 'tool.call' && e.callId === 'c1'));
    const violations = validateEventOrder(withDangling);
    expect(violations.some((v) => v.includes('无对应 call'))).toBe(true);
  });
});

describe('compareTraces (golden vs actual)', () => {
  it('reports identical behavior for the same trace', () => {
    const events = sampleEvents();
    expect(compareTraces(events, [...events]).identical).toBe(true);
  });

  it('detects tool-sequence drift', () => {
    const golden = sampleEvents();
    const actual = golden.map((e) =>
      e.type === 'tool.call' ? { ...e, name: 'echo.other' } : e,
    ) as AgentEvent[];
    const diff = compareTraces(golden, actual);
    expect(diff.identical).toBe(false);
    expect(diff.differences.some((d) => d.includes('工具序列'))).toBe(true);
  });

  it('detects status drift', () => {
    const golden = sampleEvents();
    const actual = golden.map((e) =>
      e.type === 'agent.done' ? { ...e, result: { ...e.result, status: 'error' as const } } : e,
    ) as AgentEvent[];
    const diff = compareTraces(golden, actual);
    expect(diff.differences.some((d) => d.includes('最终状态'))).toBe(true);
  });
});

describe('end-to-end deterministic replay', () => {
  it('records a real (mock) run and replays it offline with matching stats', async () => {
    const provider = new MockProvider({
      turns: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'ping' } }] },
        { content: 'pong' },
      ],
    });
    const recorder = new TraceRecorder();
    recorder.setContext({ input: 'run', provider: 'mock', model: 'm' });

    const agent = new Agent({ provider, tools: echoRegistry(), onEvent: (e) => recorder.onEvent(e) });
    const result = await agent.run('run');

    const replay = summarizeEvents(recorder.eventsCopy);
    expect(replay.status).toBe(result.status);
    expect(replay.iterations).toBe(result.iterations);
    expect(replay.toolCalls).toBe(result.toolCalls);
    expect(replay.toolSequence).toEqual(['echo']);
    expect(replay.violations).toEqual([]);

    // Golden-trace regression: replaying the same events is identical to itself
    expect(compareTraces(recorder.eventsCopy, recorder.eventsCopy).identical).toBe(true);
  });
});
