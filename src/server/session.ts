/**
 * ChatSession — one interactive conversation against a Harness.
 *
 * Owns the multi-turn history, the session working directory and the
 * running/cancel lifecycle used by the web UI. Each `chat()` runs the Agent
 * Loop with the accumulated history and streams typed frames to a callback.
 */

import { promises as fs } from 'node:fs';
import type { AgentEvent } from '../loop/events.js';
import type { Message } from '../types.js';
import type { Harness } from '../harness/harness.js';

/** Cap on how many history messages are replayed into the model. */
const MAX_HISTORY = 60;

/** Approval requests time out after this long (ms) and fail closed. */
const APPROVAL_TIMEOUT_MS = 120_000;

export type ChatFrame =
  | { type: 'meta'; selectedSkills: string[]; provider: string; model: string }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'approval.request'; request: import('../loop/agent.js').ApprovalRequest }
  | { type: 'done'; runId: string; status: string; iterations: number; toolCalls: number; tokens: number; error?: string }
  | { type: 'error'; message: string };

/** One recorded run: its full event chain (链路), kept in-memory for the UI. */
export interface RunRecord {
  id: string;
  input: string;
  startedAt: string;
  status: string;
  iterations: number;
  toolCalls: number;
  tokens: number;
  events: AgentEvent[];
}

const MAX_RUNS = 20;

export class ChatSession {
  cwd: string;
  history: Message[] = [];
  private readonly harness: Harness;
  private busy = false;
  private abortController: AbortController | null = null;
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  /** Full event chains of recent runs (链路数据，供 UI 查看). */
  private readonly runs: RunRecord[] = [];

  constructor(harness: Harness, cwd = process.cwd()) {
    this.harness = harness;
    this.cwd = cwd;
  }

  /** Run summaries for the UI (id / input / status / metrics). */
  get runList(): Array<Omit<RunRecord, 'events'>> {
    return this.runs.map(({ events: _events, ...rest }) => rest);
  }

  /** Full event chain of one run (链路详情). */
  getRun(id: string): RunRecord | undefined {
    return this.runs.find((r) => r.id === id);
  }

  /** Most recent eval report (效果评估). */
  private lastEvalReport: import('../eval.js').EvalReport | null = null;

  get evalReport(): import('../eval.js').EvalReport | null {
    return this.lastEvalReport;
  }

  setEvalReport(report: import('../eval.js').EvalReport): void {
    this.lastEvalReport = report;
  }

  /** Resolve a pending approval from the UI (POST /api/approval). */
  resolveApproval(id: string, approved: boolean): boolean {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return false;
    resolve(approved);
    return true;
  }

  get running(): boolean {
    return this.busy;
  }

  get state() {
    return {
      cwd: this.cwd,
      provider: this.harness.provider.name,
      model: this.harness.config.provider.model,
      models: this.harness.config.models,
      tools: this.harness.tools.names(),
      skills: this.harness.skills.list().map((s) => ({ name: s.name, description: s.description })),
      mcpServers: this.harness.mcp.handlesList().map((h) => ({ id: h.id, tools: h.tools.map((t) => t.name) })),
      running: this.busy,
    };
  }

  /** Switch the active model (validated against the configured model list). */
  async setModel(model: string): Promise<void> {
    const list = this.harness.config.models;
    if (list.length > 0 && !list.includes(model)) {
      throw new Error(`未知模型 "${model}"（可用: ${list.join(', ')}；可在配置文件的 "models" 字段中添加）`);
    }
    this.harness.setModel(model);
  }

  /**
   * Persist the user's city ("我的城市") to the weather MCP server so
   * `weather.current` uses it instead of the (often wrong) IP location.
   */
  async setMyCity(city: string): Promise<void> {
    if (!city.trim()) throw new Error('城市名不能为空');
    const res = await this.harness.mcp.callTool('weather.geo.my_city', { city: city.trim() });
    if (!res.ok) {
      throw new Error(`设置城市失败（需要配置 weather MCP server）: ${(res as { error: string }).error}`);
    }
  }

  /** Switch the session working directory (must exist and be a directory). */
  async setCwd(p: string): Promise<void> {
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) throw new Error(`目录不存在: ${p}`);
    if (!stat.isDirectory()) throw new Error(`不是目录: ${p}`);
    this.cwd = p;
  }

  /** Cancel the in-flight run. */
  abort(): void {
    this.abortController?.abort();
  }

  clearHistory(): void {
    this.history = [];
  }

  async chat(message: string, emit: (frame: ChatFrame) => void): Promise<void> {
    if (this.busy) throw new Error('session is already running');
    this.busy = true;
    this.abortController = new AbortController();
    this.history.push({ role: 'user', content: message });
    const runId = `run_${Date.now().toString(36)}`;
    const runEvents: AgentEvent[] = [];

    try {
      const selected = this.harness.skills.select(message, {
        top: this.harness.config.skills.maxSelected,
        threshold: this.harness.config.skills.threshold,
      });
      emit({
        type: 'meta',
        selectedSkills: selected.map((s) => s.name),
        provider: this.harness.provider.name,
        model: this.harness.config.provider.model,
      });

      const agent = this.harness.buildAgent({
        stream: true,
        onEvent: (e) => {
          runEvents.push(e); // 链路数据：完整事件链
          emit({ type: 'agent', event: e });
        },
        onApproval: (req) =>
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              this.pendingApprovals.delete(req.id);
              resolve(false); // fail closed on timeout
            }, APPROVAL_TIMEOUT_MS);
            this.pendingApprovals.set(req.id, (approved) => {
              clearTimeout(timer);
              this.pendingApprovals.delete(req.id);
              resolve(approved);
            });
            emit({ type: 'approval.request', request: req });
          }),
      });

      const result = await this.harness.run([...this.history], {
        agent,
        cwd: this.cwd,
        sessionId: 'ui-session',
        signal: this.abortController.signal,
      });

      // Append the assistant side of this turn to the conversation history.
      const assistantMsgs = result.messages.filter((m) => m.role !== 'system');
      this.history.push(...assistantMsgs);
      if (this.history.length > MAX_HISTORY) {
        this.history = this.history.slice(-MAX_HISTORY);
      }

      // Surface run-level failures (status !== 'ok') with their reason, so the
      // UI shows *why* instead of a bare "error" line.
      const runError = result.status !== 'ok' ? (result.error?.message ?? `run ended with status "${result.status}"`) : undefined;
      if (runError) {
        console.warn(`[xuanji] [session] run failed (${result.status}): ${runError}`);
      }

      this.runs.push({
        id: runId,
        input: message,
        startedAt: new Date().toISOString(),
        status: result.status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        tokens: result.usage.totalTokens,
        events: runEvents,
      });
      if (this.runs.length > MAX_RUNS) this.runs.shift();

      emit({
        type: 'done',
        runId,
        status: result.status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        tokens: result.usage.totalTokens,
        ...(runError ? { error: runError } : {}),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const message = name === 'AbortError' ? '已停止' : (err as Error).message;
      console.warn(`[xuanji] [session] chat error: ${message}`);
      emit({ type: 'error', message });
    } finally {
      // Reject any outstanding approvals (fail closed) before clearing state.
      for (const resolve of this.pendingApprovals.values()) resolve(false);
      this.pendingApprovals.clear();
      this.busy = false;
      this.abortController = null;
    }
  }
}
