/**
 * MockProvider — a scripted, fully deterministic ChatProvider.
 *
 * Used by the test-suite (no network, reproducible assertions) and by the
 * offline demo when no API key is present. Each `chat()` call pops the next
 * scripted turn; when the script is exhausted a default final answer is
 * returned, which terminates the loop.
 */

import type { ChatProvider, ChatRequest, ChatResponse } from './provider.js';
import type { ToolCall } from '../types.js';

export interface MockTurn {
  content?: string | null;
  toolCalls?: ToolCall[];
}

export interface MockProviderOptions {
  /** Scripted turns, consumed in order. */
  turns?: MockTurn[];
  /** Fallback final turn when the script is exhausted. */
  defaultFinal?: string;
  /** Emit content in chunks through req.onDelta to exercise streaming paths. */
  simulateStream?: boolean;
}

export class MockProvider implements ChatProvider {
  readonly name = 'mock';
  private readonly turns: MockTurn[];
  private readonly defaultFinal: string;
  private readonly simulateStream: boolean;
  /** Every request the provider received (for assertions). */
  readonly calls: ChatRequest[] = [];

  constructor(opts: MockProviderOptions = {}) {
    this.turns = [...(opts.turns ?? [])];
    this.defaultFinal = opts.defaultFinal ?? '（mock provider 的最终回复：任务完成。）';
    this.simulateStream = opts.simulateStream ?? false;
  }

  get remainingTurns(): number {
    return this.turns.length;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const turn = this.turns.shift();

    if (req.stream && this.simulateStream && turn?.content) {
      // Chunk by code points (Array.from) so surrogate pairs — emoji — are
      // never split mid-character by the slice.
      const chars = Array.from(turn.content);
      for (let i = 0; i < chars.length; i += 3) {
        req.onDelta?.({ text: chars.slice(i, i + 3).join('') });
      }
    }

    if (!turn) {
      return { message: { content: this.defaultFinal, toolCalls: [] } };
    }
    return {
      message: { content: turn.content ?? null, toolCalls: turn.toolCalls ?? [] },
    };
  }
}

/** Convenience: a provider that always asks for one tool call, then answers. */
export function scriptedToolTurn(toolCall: ToolCall, finalContent = 'done'): MockTurn[] {
  return [{ toolCalls: [toolCall] }, { content: finalContent }];
}
