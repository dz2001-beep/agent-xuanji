/**
 * Trace & Replay — record every Agent run as a replayable JSONL trace.
 *
 * Agent runs are non-deterministic and therefore hard to test in production.
 * This module fixes that: a run's full typed event stream (LLM turns, tool
 * calls and their outcomes, token accounting, final status) is serialized to
 * a JSONL file. The replay module can then re-run that trace OFFLINE (no
 * model calls), validate event ordering, compute statistics, and diff two
 * traces (golden vs actual) for regression testing.
 */

import { promises as fs } from 'node:fs';
import type { AgentEvent } from './loop/events.js';
import type { Message } from './types.js';

export const TRACE_VERSION = 1;

export interface TraceMeta {
  type: 'trace.meta';
  v: number;
  id: string;
  startedAt: string;
  /** The user input that started the run. */
  input: string;
  provider?: string;
  model?: string;
}

export interface LoadedTrace {
  meta: TraceMeta;
  events: AgentEvent[];
}

function randomId(): string {
  return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Collects the event stream of one run and serializes it to JSONL. */
export class TraceRecorder {
  readonly id: string;
  readonly startedAt: string;
  private readonly events: AgentEvent[] = [];
  private input = '';
  private provider: string | undefined;
  private model: string | undefined;

  constructor() {
    this.id = randomId();
    this.startedAt = new Date().toISOString();
  }

  /** Context captured from the run (input text + harness info). */
  setContext(ctx: { input: string | Message[]; provider?: string; model?: string }): void {
    this.input = typeof ctx.input === 'string' ? ctx.input : lastUserText(ctx.input);
    this.provider = ctx.provider;
    this.model = ctx.model;
  }

  /** Feed every AgentEvent here (wire as `onEvent`). */
  onEvent(event: AgentEvent): void {
    this.events.push(event);
  }

  get eventCount(): number {
    return this.events.length;
  }

  get eventsCopy(): AgentEvent[] {
    return [...this.events];
  }

  toJSONL(): string {
    const meta: TraceMeta = {
      type: 'trace.meta',
      v: TRACE_VERSION,
      id: this.id,
      startedAt: this.startedAt,
      input: this.input,
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.model ? { model: this.model } : {}),
    };
    return [JSON.stringify(meta), ...this.events.map((e) => JSON.stringify(e))].join('\n');
  }

  async save(file: string): Promise<void> {
    await fs.writeFile(file, this.toJSONL(), 'utf8');
  }

  /** Parse a JSONL trace (meta line first, then one event per line). */
  static parse(text: string): LoadedTrace {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) throw new Error('轨迹为空');
    const meta = JSON.parse(lines[0]!) as TraceMeta;
    if (meta.type !== 'trace.meta') {
      throw new Error('非法轨迹文件：首行必须是 trace.meta');
    }
    if (meta.v !== TRACE_VERSION) {
      throw new Error(`轨迹版本不兼容: 文件 v${meta.v}，当前 v${TRACE_VERSION}`);
    }
    const events = lines.slice(1).map((l) => JSON.parse(l) as AgentEvent);
    return { meta, events };
  }

  static async load(file: string): Promise<LoadedTrace> {
    return TraceRecorder.parse(await fs.readFile(file, 'utf8'));
  }
}

function lastUserText(input: Message[]): string {
  for (let i = input.length - 1; i >= 0; i--) {
    const m = input[i];
    if (m?.role === 'user' && m.content) return m.content;
  }
  return '';
}
