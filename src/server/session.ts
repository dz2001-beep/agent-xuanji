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

export type ChatFrame =
  | { type: 'meta'; selectedSkills: string[]; provider: string; model: string }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'done'; status: string; iterations: number; toolCalls: number; tokens: number }
  | { type: 'error'; message: string };

export class ChatSession {
  cwd: string;
  history: Message[] = [];
  private readonly harness: Harness;
  private busy = false;
  private abortController: AbortController | null = null;

  constructor(harness: Harness, cwd = process.cwd()) {
    this.harness = harness;
    this.cwd = cwd;
  }

  get running(): boolean {
    return this.busy;
  }

  get state() {
    return {
      cwd: this.cwd,
      provider: this.harness.provider.name,
      model: this.harness.config.provider.model,
      tools: this.harness.tools.names(),
      skills: this.harness.skills.list().map((s) => ({ name: s.name, description: s.description })),
      mcpServers: this.harness.mcp.handlesList().map((h) => ({ id: h.id, tools: h.tools.map((t) => t.name) })),
      running: this.busy,
    };
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
        onEvent: (e) => emit({ type: 'agent', event: e }),
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

      emit({
        type: 'done',
        status: result.status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        tokens: result.usage.totalTokens,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      emit({
        type: 'error',
        message: name === 'AbortError' ? '已停止' : (err as Error).message,
      });
    } finally {
      this.busy = false;
      this.abortController = null;
    }
  }
}
