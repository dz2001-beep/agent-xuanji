/**
 * Skill Learning — distill successful traces into reusable SKILL.md skills.
 *
 * The "experience loop": run an agent successfully → record a trace → distill
 * the trace into a reusable skill → the next time a similar task arrives, the
 * skill is auto-injected. (Industry precedent: Voyager's skill library,
 * Anthropic's Agent Skills ecosystem.)
 *
 * What we extract from a trace:
 *  - the ordered tool-call path (name + argument summary + success);
 *  - the final answer (as reference output);
 *  - metadata (trace ids, iteration/token stats).
 *
 * Multiple traces of the SAME task kind can be merged: steps are deduplicated
 * and counted, so steps adopted by MOST runs carry higher weight ("3/3 runs"
 * vs "1/3 runs") — this is the "high-frequency" signal.
 *
 * Honest caveat (documented in the generated file): the distilled output is
 * an execution-path REFERENCE, not final instructions — review/adjust before
 * heavy reuse.
 */

import type { LoadedTrace } from './trace.js';
import { summarizeEvents } from './replay.js';
import type { AgentEvent } from './loop/events.js';
import { stringify } from './utils.js';

export interface ToolStep {
  name: string;
  /** Short summary of the arguments (truncated). */
  args: string;
  ok: boolean;
  /** How many of the merged traces used this exact step. */
  count: number;
}

export interface LearnedSkill {
  name: string;
  description: string;
  /** The SKILL.md body (instructions section). */
  body: string;
  traceIds: string[];
  steps: ToolStep[];
  totalRuns: number;
  /** Overall stats across the merged traces. */
  totalTokens: number;
  totalToolCalls: number;
}

/** Extract the ordered tool-call path from a trace's events. */
export function extractSteps(events: AgentEvent[]): ToolStep[] {
  const steps: ToolStep[] = [];
  const okByCall = new Map<string, boolean>();
  for (const e of events) {
    if (e.type === 'tool.call') {
      steps.push({ name: e.name, args: summarizeArgs(e.args), ok: true, count: 1 });
      okByCall.set(e.callId, true);
    } else if (e.type === 'tool.result' || e.type === 'tool.error') {
      okByCall.set(e.callId, e.type === 'tool.result' && e.result.ok);
    }
  }
  // mark failures using the recorded outcome
  let i = 0;
  for (const e of events) {
    if (e.type === 'tool.call') {
      const s = steps[i];
      if (s) s.ok = okByCall.get(e.callId) ?? false;
      i++;
    }
  }
  return steps;
}

function summarizeArgs(args: unknown, max = 60): string {
  if (args === undefined) return '';
  const s = stringify(args, max);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Merge several traces of the same task kind into one distilled skill. */
export function mergeTraces(
  traces: LoadedTrace[],
  opts: { name: string; description?: string },
): LearnedSkill | null {
  const runs = traces.filter((t) => {
    const s = summarizeEvents(t.events);
    return s.status === 'ok'; // only successful runs carry reusable paths
  });
  if (runs.length === 0) return null;

  // Ordered dedup + frequency counting: same tool name + same arg summary.
  const seen = new Map<string, ToolStep>();
  const order: string[] = [];
  for (const run of runs) {
    for (const step of extractSteps(run.events)) {
      const key = `${step.name}\u0000${step.args}`;
      const existing = seen.get(key);
      if (existing) {
        existing.count++;
        existing.ok = existing.ok && step.ok;
      } else {
        seen.set(key, { ...step, count: 1 });
        order.push(key);
      }
    }
  }
  const steps = order.map((k) => seen.get(k)!).sort((a, b) => b.count - a.count || order.indexOf(`${a.name}\u0000${a.args}`) - order.indexOf(`${b.name}\u0000${b.args}`));

  // Overall stats
  let totalTokens = 0;
  let totalToolCalls = 0;
  for (const run of runs) {
    const s = summarizeEvents(run.events);
    totalTokens += s.tokens.totalTokens;
    totalToolCalls += s.toolCalls;
  }

  const body = buildBody(runs, steps, opts);
  return {
    name: opts.name,
    description: opts.description ?? `由 ${runs.length} 次成功运行提炼的执行路径（自动生成）。`,
    body,
    traceIds: runs.map((r) => r.meta.id),
    steps,
    totalRuns: runs.length,
    totalTokens,
    totalToolCalls,
  };
}

function buildBody(
  runs: LoadedTrace[],
  steps: ToolStep[],
  opts: { name: string; description?: string },
): string {
  const lines: string[] = [];
  lines.push(`# ${opts.name} — 执行路径（自动提炼）`);
  lines.push('');
  lines.push(`> 本技能由 ${runs.length} 次成功运行的轨迹提炼生成（trace: ${runs.map((r) => r.meta.id).join(', ')}）。`);
  lines.push(`> 这是**执行路径参考**：包含被验证过的工具调用序列，请根据当前任务动态调整，勿机械照搬。`);
  lines.push('');

  if (steps.length > 0) {
    lines.push('## 推荐执行路径');
    lines.push('');
    steps.forEach((s, idx) => {
      const freq = runs.length > 0 ? `（${s.count}/${runs.length} 次运行采用${s.ok ? '' : '，该步曾失败'}）` : '';
      const args = s.args ? ` — 参数示例: \`${s.args}\`` : '';
      lines.push(`${idx + 1}. \`${s.name}\`${freq}${args}`);
    });
    lines.push('');
  }

  // Reference outputs (final answers of the successful runs).
  const outputs = runs
    .map((r) => lastAssistantOutput(r.events))
    .filter((o): o is string => !!o)
    .slice(0, 2);
  if (outputs.length > 0) {
    lines.push('## 参考输出');
    lines.push('');
    outputs.forEach((o, i) => {
      lines.push(`> 示例 ${i + 1}：${o.slice(0, 300)}${o.length > 300 ? '…' : ''}`);
    });
    lines.push('');
  }

  lines.push('## 注意事项');
  lines.push('- 本技能为自动提炼的执行路径，建议人工复核后用于正式技能库。');
  lines.push('- 工具参数是示例值，实际调用时需根据任务替换。');
  return lines.join('\n');
}

function lastAssistantOutput(events: AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'llm.turn' && e.message.content) return e.message.content;
    if (e?.type === 'agent.done' && e.result.output) return e.result.output;
  }
  return null;
}

/** Render a learned skill as a full SKILL.md document. */
export function renderSkillMd(skill: LearnedSkill): string {
  const fm = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description.replace(/\n/g, ' ')}`,
    '---',
    '',
  ].join('\n');
  return `${fm}${skill.body}\n`;
}

/** Load every trace file under a directory (best effort). */
export async function loadTracesFromDir(dir: string, loader: (f: string) => Promise<LoadedTrace>): Promise<LoadedTrace[]> {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const out: LoadedTrace[] = [];
  const entries = await fs.readdir(dir).catch(() => []);
  for (const name of entries.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      out.push(await loader(path.join(dir, name)));
    } catch (err) {
      console.warn(`[xuanji] 跳过无法解析的轨迹 ${name}: ${(err as Error).message}`);
    }
  }
  return out;
}
