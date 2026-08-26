/**
 * Agent — the core reasoning-acting loop ("Agent Loop").
 *
 * Loop semantics:
 *
 *   1. Build messages: [system?] + history + new user input.
 *   2. Ask the provider for a turn (streaming, cancellable, retried on
 *      transient errors with backoff).
 *   3. If the model requested tool calls:
 *        - validate arguments against the tool schema (cheap, no dependency);
 *        - execute each tool with a timeout;
 *        - append the results as `tool` messages and loop back to step 2.
 *   4. Otherwise the turn is final — return the answer.
 *
 * Termination is guaranteed by `maxIterations`; callers may additionally
 * provide `stopWhen` for custom stopping rules and an `AbortSignal` for
 * cancellation. Every transition is published through the typed event stream.
 */

import type { ChatProvider, ChatResponse } from '../llm/provider.js';
import type { Message, TokenUsage, ToolCall } from '../types.js';
import type { Tool, ToolResult, ToolRegistry } from '../tools/tool.js';
import { validateArgs, formatIssues } from '../tools/schema.js';
import { ToolError } from '../tools/tool.js';
import { addUsage, emptyUsage } from '../types.js';
import { abortError, isAbortError, sleep, stringify, withTimeout } from '../utils.js';
import { createEmitter, type AgentEvent, type EventEmitter } from './events.js';

export interface AgentOptions {
  provider: ChatProvider;
  tools?: ToolRegistry;
  /** Base system prompt. Can be overridden per run via RunOptions.system. */
  system?: string;
  maxIterations?: number;
  toolTimeoutMs?: number;
  /** Retries for transient LLM/provider failures. */
  maxRetries?: number;
  retryDelayMs?: number;
  stream?: boolean;
  temperature?: number;
  /** Custom stopping predicate evaluated after each executed turn. */
  stopWhen?: (state: LoopState) => boolean;
  onEvent?: (event: AgentEvent) => void;
}

export interface LoopState {
  messages: Message[];
  iterations: number;
  toolCalls: number;
}

export type AgentStatus = 'ok' | 'max-iterations' | 'stopped' | 'aborted' | 'error';

export interface AgentResult {
  status: AgentStatus;
  /** Final assistant text (best effort for non-ok statuses). */
  output: string;
  /** Full transcript, including tool messages. */
  messages: Message[];
  iterations: number;
  toolCalls: number;
  usage: TokenUsage;
  error?: Error;
}

export interface RunOptions {
  /** Replaces (does not append to) the agent's base system prompt for this run. */
  system?: string;
  signal?: AbortSignal;
  sessionId?: string;
  /** Session working directory — passed to tools so relative paths resolve against it. */
  cwd?: string;
}

const DEFAULTS = {
  maxIterations: 20,
  toolTimeoutMs: 60_000,
  maxRetries: 2,
  retryDelayMs: 1_000,
  stream: true,
} as const;

export class Agent {
  private readonly opts: AgentOptions;

  constructor(opts: AgentOptions) {
    if (!opts.provider) throw new Error('Agent requires a provider');
    // Merge defaults, ignoring explicitly-undefined options (callers often
    // pass partial configs where absent budget fields are undefined).
    const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as AgentOptions;
    this.opts = { ...DEFAULTS, ...defined };
  }

  async run(input: string | Message[], runOpts: RunOptions = {}): Promise<AgentResult> {
    const emitter = createEmitter();
    if (this.opts.onEvent) emitter.on(this.opts.onEvent);
    emitter.emit({ type: 'agent.start', input });

    const messages: Message[] = [];
    const system = runOpts.system ?? this.opts.system;
    if (system) messages.push({ role: 'system', content: system });
    if (typeof input === 'string') messages.push({ role: 'user', content: input });
    else messages.push(...input);

    const state: LoopState = { messages, iterations: 0, toolCalls: 0 };
    const usage = emptyUsage();

    try {
      while (true) {
        this.checkAbort(runOpts.signal);

        if (state.iterations >= this.opts.maxIterations!) {
          return this.finalize(emitter, 'max-iterations', state, usage);
        }
        state.iterations++;
        emitter.emit({ type: 'turn.start', iteration: state.iterations });

        const response = await this.askModel(messages, emitter, runOpts, usage);
        state.messages.push({ role: 'assistant', content: response.message.content, toolCalls: response.message.toolCalls });

        if (response.message.toolCalls.length === 0) {
          return this.finalize(emitter, 'ok', state, usage);
        }

        await this.executeToolCalls(response.message.toolCalls, emitter, state, runOpts);

        if (this.opts.stopWhen?.(state)) {
          return this.finalize(emitter, 'stopped', state, usage);
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        return this.finalize(emitter, 'aborted', state, usage, err);
      }
      return this.finalize(emitter, 'error', state, usage, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /* ---------------------------------------------------------------- */

  private checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError('Run aborted by caller');
  }

  /** Ask the model, retrying transient failures with linear backoff. */
  private async askModel(
    messages: Message[],
    emitter: EventEmitter,
    runOpts: RunOptions,
    usage: TokenUsage,
  ): Promise<ChatResponse> {
    const maxRetries = this.opts.maxRetries!;
    const delay = this.opts.retryDelayMs!;
    const tools = this.opts.tools?.list();

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(delay * attempt);
        this.checkAbort(runOpts.signal);
      }
      try {
        const response = await this.opts.provider.chat({
          messages,
          tools,
          stream: this.opts.stream,
          temperature: this.opts.temperature,
          signal: runOpts.signal,
          onDelta: (d) => emitter.emit({ type: 'llm.delta', text: d.text }),
        });
        addUsage(usage, response.usage);
        emitter.emit({ type: 'llm.turn', message: { role: 'assistant', content: response.message.content, toolCalls: response.message.toolCalls }, usage: response.usage });
        return response;
      } catch (err) {
        this.checkAbort(runOpts.signal); // if aborted mid-call, surface abort, not retry
        lastError = err;
      }
    }
    throw lastError;
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    emitter: EventEmitter,
    state: LoopState,
    runOpts: RunOptions,
  ): Promise<void> {
    for (const call of toolCalls) {
      state.toolCalls++;
      emitter.emit({ type: 'tool.call', name: call.name, args: call.arguments, callId: call.id });

      const started = Date.now();
      let result: ToolResult;
      const tool = this.opts.tools?.get(call.name);

      if (!tool) {
        result = { ok: false, error: `unknown tool "${call.name}" — available tools: ${this.opts.tools?.names().join(', ') ?? 'none'}` };
      } else {
        const issues = validateArgs(tool.inputSchema, call.arguments);
        if (issues.length > 0) {
          result = { ok: false, error: `invalid arguments for "${call.name}": ${formatIssues(issues)}` };
        } else {
          try {
            result = await withTimeout(
              tool.execute(call.arguments, {
                callId: call.id,
                sessionId: runOpts.sessionId,
                signal: runOpts.signal,
                cwd: runOpts.cwd,
              }),
              this.opts.toolTimeoutMs!,
              `tool "${call.name}"`,
            );
          } catch (err) {
            if (isAbortError(err)) throw err;
            const error = err instanceof ToolError ? err : new Error(`tool "${call.name}" threw: ${(err as Error).message}`);
            emitter.emit({ type: 'tool.error', name: call.name, callId: call.id, error });
            result = { ok: false, error: error.message };
          }
        }
      }

      const durationMs = Date.now() - started;
      if (result.ok) emitter.emit({ type: 'tool.result', name: call.name, callId: call.id, result, durationMs });
      else emitter.emit({ type: 'tool.error', name: call.name, callId: call.id, error: new Error(result.error) });

      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: stringify(result.ok ? result.data : `[tool error] ${result.error}`),
      });
    }
  }

  private finalize(
    emitter: EventEmitter,
    status: AgentStatus,
    state: LoopState,
    usage: TokenUsage,
    error?: Error,
  ): AgentResult {
    // Best-effort output: last non-empty assistant text in the transcript.
    let output = '';
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (!m) continue;
      if (m.role === 'assistant' && m.content) {
        output = m.content;
        break;
      }
    }

    const result: AgentResult = {
      status,
      output,
      messages: state.messages,
      iterations: state.iterations,
      toolCalls: state.toolCalls,
      usage,
      ...(error ? { error } : {}),
    };
    emitter.emit({ type: 'agent.done', result });
    return result;
  }
}
