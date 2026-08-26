/**
 * Agent Evaluation — scenario-based eval cases, metrics report, and
 * version regression (eval diff).
 *
 * Mirrors the "Agent 效果评估" responsibility: design scenario cases with
 * assertions (tool sequence / output keywords / iteration & token budgets),
 * run them through the harness, and produce a quantifiable, traceable
 * metrics report (pass rate, token cost, tool efficiency). Diffing two
 * reports (before/after, or label A/B) quantifies iteration impact.
 *
 * Every case result links to its run — metrics are traceable.
 */

import type { Message } from './types.js';
import type { AgentResult } from './loop/agent.js';
import { stringify } from './utils.js';

export interface EvalExpect {
  /** Required tool call sequence (subset match, in order). */
  toolSequence?: string[];
  /** Output must contain all of these substrings. */
  outputContains?: string[];
  maxIterations?: number;
  maxTokens?: number;
  /** Whether the run must end with status "ok" (default true). */
  success?: boolean;
}

export interface EvalCase {
  id: string;
  prompt: string;
  expect?: EvalExpect;
}

export interface EvalCaseResult {
  id: string;
  prompt: string;
  status: string;
  iterations: number;
  toolCalls: number;
  tokens: number;
  durationMs: number;
  passed: boolean;
  /** Human-readable assertion failures (empty when passed). */
  failures: string[];
}

export interface EvalReport {
  label: string;
  startedAt: string;
  summary: {
    total: number;
    passed: number;
    passRate: number; // 0..1
    totalTokens: number;
    avgTokens: number;
    totalToolCalls: number;
    avgToolCalls: number;
    totalDurationMs: number;
  };
  cases: EvalCaseResult[];
}

export type EvalRunner = (prompt: string) => Promise<AgentResult>;

/** Run one case through the harness and assert its expectations. */
export async function evaluateCase(case_: EvalCase, run: EvalRunner): Promise<EvalCaseResult> {
  const started = Date.now();
  let result: AgentResult;
  try {
    result = await run(case_.prompt);
  } catch (err) {
    return {
      id: case_.id,
      prompt: case_.prompt,
      status: 'error',
      iterations: 0,
      toolCalls: 0,
      tokens: 0,
      durationMs: Date.now() - started,
      passed: false,
      failures: [`执行异常: ${(err as Error).message}`],
    };
  }
  const durationMs = Date.now() - started;

  const expect = case_.expect ?? {};
  const failures: string[] = [];
  const wantSuccess = expect.success !== false;
  if (wantSuccess && result.status !== 'ok') {
    failures.push(`期望成功（ok），实际 ${result.status}${result.error ? `：${result.error.message}` : ''}`);
  }
  const sequence = extractToolSequence(result.messages);
  for (const tool of expect.toolSequence ?? []) {
    if (!sequence.includes(tool)) failures.push(`工具序列中未找到 ${tool}（实际: ${sequence.join(', ') || '无'}）`);
  }
  for (const kw of expect.outputContains ?? []) {
    if (!result.output.includes(kw)) failures.push(`输出中未包含 "${kw}"`);
  }
  if (expect.maxIterations !== undefined && result.iterations > expect.maxIterations) {
    failures.push(`轮次 ${result.iterations} 超过上限 ${expect.maxIterations}`);
  }
  if (expect.maxTokens !== undefined && result.usage.totalTokens > expect.maxTokens) {
    failures.push(`token ${result.usage.totalTokens} 超过上限 ${expect.maxTokens}`);
  }

  return {
    id: case_.id,
    prompt: case_.prompt,
    status: result.status,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    tokens: result.usage.totalTokens,
    durationMs,
    passed: failures.length === 0,
    failures,
  };
}

/** Run a whole dataset; every case is independent (errors become failures). */
export async function runEval(
  cases: EvalCase[],
  run: EvalRunner,
  opts: { label?: string } = {},
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    try {
      results.push(await evaluateCase(c, run));
    } catch (err) {
      results.push({
        id: c.id,
        prompt: c.prompt,
        status: 'error',
        iterations: 0,
        toolCalls: 0,
        tokens: 0,
        durationMs: 0,
        passed: false,
        failures: [`执行异常: ${(err as Error).message}`],
      });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  const totalTokens = results.reduce((a, r) => a + r.tokens, 0);
  const totalToolCalls = results.reduce((a, r) => a + r.toolCalls, 0);
  const totalDurationMs = results.reduce((a, r) => a + r.durationMs, 0);
  const n = results.length || 1;
  return {
    label: opts.label ?? 'default',
    startedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      passed,
      passRate: results.length > 0 ? passed / results.length : 0,
      totalTokens,
      avgTokens: Math.round(totalTokens / n),
      totalToolCalls,
      avgToolCalls: Math.round(totalToolCalls / n * 10) / 10,
      totalDurationMs,
    },
    cases: results,
  };
}

export interface EvalDiff {
  identical: boolean;
  lines: string[];
  summary: {
    passRateDelta: number; // after - before (0..1)
    tokensDelta: number;
    toolCallsDelta: number;
    newFailures: string[];
    fixedCases: string[];
  };
}

/** Compare two reports (version regression / A-B). */
export function compareEvalReports(before: EvalReport, after: EvalReport): EvalDiff {
  const b = before.summary;
  const a = after.summary;
  const newFailures = after.cases.filter((r) => !r.passed && !before.cases.some((x) => x.id === r.id && !x.passed)).map((r) => r.id);
  const fixed = before.cases.filter((x) => !x.passed && after.cases.some((r) => r.id === x.id && r.passed)).map((x) => x.id);

  const lines: string[] = [];
  const tokensDelta = a.totalTokens - b.totalTokens;
  lines.push(`通过率: ${(b.passRate * 100).toFixed(1)}% → ${(a.passRate * 100).toFixed(1)}% (${a.passRate - b.passRate >= 0 ? '+' : ''}${((a.passRate - b.passRate) * 100).toFixed(1)}%)`);
  lines.push(`总 token: ${b.totalTokens} → ${a.totalTokens} (${tokensDelta >= 0 ? '+' : ''}${tokensDelta})`);
  lines.push(`工具调用: ${b.totalToolCalls} → ${a.totalToolCalls}`);
  if (newFailures.length) lines.push(`新增失败: ${newFailures.join(', ')}`);
  if (fixed.length) lines.push(`已修复: ${fixed.join(', ')}`);

  return {
    identical: a.passRate === b.passRate && a.totalTokens === b.totalTokens && newFailures.length === 0,
    lines,
    summary: {
      passRateDelta: a.passRate - b.passRate,
      tokensDelta: a.totalTokens - b.totalTokens,
      toolCallsDelta: a.totalToolCalls - b.totalToolCalls,
      newFailures,
      fixedCases: fixed,
    },
  };
}

/** Tool call names in execution order, reconstructed from the transcript. */
export function extractToolSequence(messages: Message[]): string[] {
  const seq: string[] = [];
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) seq.push(tc.name);
  }
  return seq;
}

/** Compact JSON for storage/diffing. */
export function serializeReport(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatReportTable(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`评测: ${report.label}  |  通过 ${report.summary.passed}/${report.summary.total} (${(report.summary.passRate * 100).toFixed(1)}%)`);
  lines.push(`总 token: ${report.summary.totalTokens} | 平均 token: ${report.summary.avgTokens} | 平均工具调用: ${report.summary.avgToolCalls}`);
  for (const c of report.cases) {
    const mark = c.passed ? '✓' : '✗';
    lines.push(`  ${mark} ${c.id}  [${c.status}] ${c.toolCalls} 工具 / ${c.tokens} tok / ${c.durationMs}ms${c.failures.length ? '  → ' + c.failures.join('; ') : ''}`);
  }
  return lines.join('\n');
}

export function formatDiff(diff: EvalDiff): string {
  const lines = ['', '  通过率变化: ' + diff.lines[0], '  token 变化 : ' + diff.lines[1], '  工具调用   : ' + diff.lines[2]];
  for (const l of diff.lines.slice(3)) lines.push('  ' + l);
  lines.push('');
  return lines.join('\n');
}
