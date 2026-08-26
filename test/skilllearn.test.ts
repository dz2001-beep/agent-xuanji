/**
 * Skill Learning tests: trace → step extraction, multi-trace merging with
 * frequency weighting, SKILL.md rendering (parseable + matchable), and the
 * full experience loop (run → trace → learn → auto-inject).
 */

import { describe, expect, it } from 'vitest';
import { Agent } from '../src/loop/agent.js';
import { MockProvider } from '../src/llm/mock.js';
import { ToolRegistry } from '../src/tools/tool.js';
import { TraceRecorder, type LoadedTrace } from '../src/trace.js';
import { extractSteps, mergeTraces, renderSkillMd } from '../src/skilllearn.js';
import { parseSkillFile } from '../src/skills/frontmatter.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { AgentEvent } from '../src/loop/events.js';

function makeTrace(events: AgentEvent[], input: string, id = 'tr_test'): LoadedTrace {
  return { meta: { type: 'trace.meta', v: 1, id, startedAt: '2026-01-01T00:00:00Z', input }, events };
}

function reviewEvents(extra: Array<{ name: string; args?: Record<string, string> }>): AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'agent.start', input: 'review' }];
  let n = 0;
  for (const step of extra) {
    const callId = `c${n++}`;
    events.push({ type: 'turn.start', iteration: n });
    events.push({
      type: 'llm.turn',
      message: { role: 'assistant', content: null, toolCalls: [{ id: callId, name: step.name, arguments: step.args ?? {} }] },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    events.push({ type: 'tool.call', name: step.name, args: step.args ?? {}, callId });
    events.push({ type: 'tool.result', name: step.name, callId, result: { ok: true, data: 'ok' }, durationMs: 1 });
  }
  events.push({ type: 'turn.start', iteration: n + 1 });
  events.push({ type: 'llm.turn', message: { role: 'assistant', content: '评审完成，发现 2 个问题。' }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 10 } });
  events.push({
    type: 'agent.done',
    result: { status: 'ok', output: '评审完成，发现 2 个问题。', messages: [], iterations: n + 1, toolCalls: n, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
  });
  return events;
}

const TRACE_A = makeTrace(
  reviewEvents([{ name: 'fs.list_dir' }, { name: 'fs.read_file', args: { path: 'src/a.ts' } }, { name: 'fs.read_file', args: { path: 'src/b.ts' } }]),
  '帮我 review 一下代码',
  'tr_a',
);
const TRACE_B = makeTrace(
  reviewEvents([{ name: 'fs.list_dir' }, { name: 'fs.read_file', args: { path: 'src/a.ts' } }]),
  '审阅一下这段代码',
  'tr_b',
);

describe('extractSteps', () => {
  it('extracts the ordered tool path with argument summaries', () => {
    const steps = extractSteps(TRACE_A.events);
    expect(steps.map((s) => s.name)).toEqual(['fs.list_dir', 'fs.read_file', 'fs.read_file']);
    expect(steps[1]?.args).toContain('src/a.ts');
    expect(steps.every((s) => s.ok)).toBe(true);
  });
});

describe('mergeTraces', () => {
  it('dedupes steps and counts frequency (high-frequency signal)', () => {
    const learned = mergeTraces([TRACE_A, TRACE_B], { name: 'code-review', description: '审阅代码' })!;
    expect(learned.totalRuns).toBe(2);
    expect(learned.traceIds).toEqual(['tr_a', 'tr_b']);
    // fs.list_dir appears in both runs → count 2; the rest once
    const listDir = learned.steps.find((s) => s.name === 'fs.list_dir');
    expect(listDir?.count).toBe(2);
    const b = learned.steps.find((s) => s.name === 'fs.read_file' && s.args.includes('src/b.ts'));
    expect(b?.count).toBe(1);
    // body carries the frequency annotation
    expect(learned.body).toContain('2/2');
  });

  it('filters out failed runs', () => {
    const failed = makeTrace(
      [{ type: 'agent.start', input: 'x' }, { type: 'turn.start', iteration: 1 }, {
        type: 'agent.done',
        result: { status: 'error', output: '', messages: [], iterations: 1, toolCalls: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
      }],
      'x',
      'tr_fail',
    );
    const learned = mergeTraces([failed, TRACE_A], { name: 's' });
    expect(learned?.totalRuns).toBe(1);
    expect(learned?.traceIds).toEqual(['tr_a']);
  });

  it('returns null when no successful run exists', () => {
    expect(mergeTraces([], { name: 's' })).toBeNull();
  });
});

describe('renderSkillMd', () => {
  it('renders a parseable SKILL.md that the registry can match', () => {
    const learned = mergeTraces([TRACE_A, TRACE_B], { name: 'code-review', description: '审阅 TypeScript 代码，输出分级评审意见。' })!;
    const md = renderSkillMd(learned);

    const { meta, body } = parseSkillFile(md, 'SKILL.md');
    expect(meta.name).toBe('code-review');
    expect(meta.description).toContain('审阅');
    expect(body).toContain('fs.list_dir');
    expect(body).toContain('参考输出');

    // round-trip through the real registry + matching
    const registry = new SkillRegistry();
    registry.add({
      name: meta.name,
      description: meta.description,
      path: '/skills/code-review/SKILL.md',
      dir: '/skills/code-review',
      instructions: body,
      resources: [],
      metadata: meta,
    });
    const matched = registry.select('帮我 review 一下代码', { top: 1 });
    expect(matched.map((s) => s.name)).toContain('code-review');
  });
});

describe('experience loop (run → trace → learn → auto-inject)', () => {
  it('records a successful run, distills it, and the skill is selected next time', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'fs.list_dir',
      description: 'list',
      inputSchema: { type: 'object' },
      async execute() {
        return { ok: true, data: ['src', 'test'] };
      },
    });

    // Run 1: a successful "code review"-ish task with a tool call.
    const provider = new MockProvider({
      turns: [{ toolCalls: [{ id: 'c1', name: 'fs.list_dir', arguments: {} }] }, { content: '评审完成' }],
    });
    const recorder = new TraceRecorder();
    recorder.setContext({ input: '帮我 review 代码', provider: 'mock', model: 'm' });
    const agent = new Agent({ provider, tools: registry, onEvent: (e) => recorder.onEvent(e) });
    const result = await agent.run('帮我 review 代码');
    expect(result.status).toBe('ok');

    // Distill the trace into a skill.
    const learned = mergeTraces(
      [{ meta: { type: 'trace.meta', v: 1, id: recorder.id, startedAt: recorder.startedAt, input: '帮我 review 代码' }, events: recorder.eventsCopy }],
      { name: 'code-review', description: '审阅代码，输出评审意见。' },
    )!;
    const md = renderSkillMd(learned);
    const { meta, body } = parseSkillFile(md, 'SKILL.md');

    // The distilled skill is auto-selected for a similar future request.
    const skills = new SkillRegistry();
    skills.add({ name: meta.name, description: meta.description, path: 'x', dir: 'x', instructions: body, resources: [], metadata: meta });
    const selected = skills.select('请 review 一下这段代码', { top: 1 });
    expect(selected.map((s) => s.name)).toContain('code-review');
  });
});
