/**
 * Evaluation tests: case assertions, metrics report, report diffing,
 * and the trace report renderer (全链路观测的链路报告).
 */

import { describe, expect, it } from 'vitest';
import { Agent } from '../src/loop/agent.js';
import { MockProvider } from '../src/llm/mock.js';
import { ToolRegistry } from '../src/tools/tool.js';
import { TraceRecorder } from '../src/trace.js';
import { evaluateCase, runEval, compareEvalReports, extractToolSequence, type EvalCase } from '../src/eval.js';
import { renderTraceReport } from '../src/trace_report.js';
import type { AgentResult } from '../src/loop/agent.js';
import type { Message } from '../src/types.js';

function makeRunner(turns: Array<{ content?: string; toolCalls?: Array<{ id: string; name: string; arguments: unknown }> }>) {
  const provider = new MockProvider({ turns });
  const registry = new ToolRegistry();
  registry.register({
    name: 'fs.list_dir',
    description: 'list',
    inputSchema: { type: 'object' },
    async execute() {
      return { ok: true, data: ['src', 'test', 'README.md'] };
    },
  });
  registry.register({
    name: 'web.search',
    description: 'search',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute() {
      return { ok: true, data: 'MCP 是模型上下文协议' };
    },
  });
  const agent = new Agent({ provider, tools: registry });
  return (prompt: string) => agent.run(prompt);
}

const TOOL_TURN = [{ id: 'c1', name: 'fs.list_dir', arguments: {} }];

describe('extractToolSequence', () => {
  it('reconstructs tool call order from the transcript', () => {
    const messages: Message[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'fs.list_dir', arguments: {} }] },
      { role: 'tool', toolCallId: 'a', content: '...' },
      { role: 'assistant', content: 'done', toolCalls: [] },
    ];
    expect(extractToolSequence(messages)).toEqual(['fs.list_dir']);
  });
});

describe('evaluateCase', () => {
  it('passes when all expectations hold', async () => {
    const run = makeRunner([{ toolCalls: TOOL_TURN }, { content: '工作区里有 3 个文件' }]);
    const result = await evaluateCase(
      { id: 'c1', prompt: '列出文件', expect: { toolSequence: ['fs.list_dir'], outputContains: ['文件'] } },
      run,
    );
    expect(result.passed).toBe(true);
    expect(result.toolCalls).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it('fails when the tool sequence is missing', async () => {
    const run = makeRunner([{ content: '直接回答' }]);
    const result = await evaluateCase(
      { id: 'c2', prompt: '列出文件', expect: { toolSequence: ['fs.list_dir'] } },
      run,
    );
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('fs.list_dir'))).toBe(true);
  });

  it('fails on missing output keyword and token budget', async () => {
    const run = makeRunner([{ content: '完成' }]);
    const result = await evaluateCase(
      { id: 'c3', prompt: 'x', expect: { outputContains: ['关键词'], maxTokens: 10 } },
      run,
    );
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('关键词'))).toBe(true);
  });

  it('survives runner exceptions as failures', async () => {
    const result = await evaluateCase(
      { id: 'c4', prompt: 'x' },
      async () => {
        throw new Error('boom');
      },
    );
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('boom'))).toBe(true);
  });
});

describe('runEval', () => {
  it('aggregates pass rate / tokens / tool calls into a report', async () => {
    const run = makeRunner([{ toolCalls: TOOL_TURN }, { content: '有 3 个文件' }]);
    const cases: EvalCase[] = [
      { id: 'ok', prompt: '列出文件', expect: { toolSequence: ['fs.list_dir'] } },
      { id: 'bad', prompt: '列出文件', expect: { toolSequence: ['web.search'] } },
    ];
    const report = await runEval(cases, run, { label: 'demo' });
    expect(report.label).toBe('demo');
    expect(report.summary.total).toBe(2);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.passRate).toBe(0.5);
    expect(report.cases.find((c) => c.id === 'ok')?.passed).toBe(true);
    expect(report.cases.find((c) => c.id === 'bad')?.passed).toBe(false);
  });
});

describe('compareEvalReports', () => {
  function report(label: string, passed: string[], failed: string[], tokens = 100): import('../src/eval.js').EvalReport {
    return {
      label,
      startedAt: '',
      summary: {
        total: passed.length + failed.length,
        passed: passed.length,
        passRate: (passed.length + failed.length) > 0 ? passed.length / (passed.length + failed.length) : 0,
        totalTokens: tokens,
        avgTokens: Math.round(tokens / Math.max(1, passed.length + failed.length)),
        totalToolCalls: passed.length,
        avgToolCalls: passed.length,
        totalDurationMs: 0,
      },
      cases: [
        ...passed.map((id) => ({ id, prompt: '', status: 'ok', iterations: 1, toolCalls: 1, tokens, durationMs: 1, passed: true, failures: [] })),
        ...failed.map((id) => ({ id, prompt: '', status: 'ok', iterations: 1, toolCalls: 1, tokens, durationMs: 1, passed: false, failures: ['x'] })),
      ],
    };
  }

  it('reports pass-rate/token deltas, new failures and fixed cases', () => {
    const before = report('v1', ['a'], ['b']);
    const after = report('v2', ['a', 'b'], []);
    const diff = compareEvalReports(before, after);
    expect(diff.summary.passRateDelta).toBeCloseTo(0.5);
    expect(diff.summary.fixedCases).toEqual(['b']);
    expect(diff.summary.newFailures).toEqual([]);
    expect(diff.identical).toBe(false);
  });

  it('detects regressions (new failures)', () => {
    const before = report('v1', ['a', 'b'], []);
    const after = report('v2', ['a'], ['b']);
    const diff = compareEvalReports(before, after);
    expect(diff.summary.newFailures).toEqual(['b']);
    expect(diff.summary.passRateDelta).toBeLessThan(0);
  });
});

describe('renderTraceReport', () => {
  it('renders a link-view markdown with tools, timing and tokens', async () => {
    const run = makeRunner([{ toolCalls: TOOL_TURN }, { content: '有 3 个文件' }]);
    const recorder = new TraceRecorder();
    recorder.setContext({ input: '列出文件', provider: 'mock', model: 'm' });
    const agent = new Agent({ provider: new MockProvider({ turns: [{ toolCalls: TOOL_TURN }, { content: '有 3 个文件' }] }), tools: (() => {
      const r = new ToolRegistry();
      r.register({
        name: 'fs.list_dir', description: 'l', inputSchema: { type: 'object' },
        async execute() { return { ok: true, data: ['a'] }; },
      });
      return r;
    })(), onEvent: (e) => recorder.onEvent(e) });
    await agent.run('列出文件');
    void run;

    const trace = {
      meta: { type: 'trace.meta' as const, v: 1, id: recorder.id, startedAt: recorder.startedAt, input: '列出文件', provider: 'mock', model: 'm' },
      events: recorder.eventsCopy,
    };
    const md = renderTraceReport(trace);
    expect(md).toContain('# 链路报告');
    expect(md).toContain('fs.list_dir');
    expect(md).toContain('状态: ok');
    expect(md).toContain('工具调用序列');
  });
});
