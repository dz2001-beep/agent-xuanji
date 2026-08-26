/**
 * Typed event stream for the Agent Loop.
 *
 * Every step of a run is observable: turn boundaries, LLM streaming deltas,
 * tool invocations and their outcomes, and the final result. Consumers can
 * render a live UI (the CLI does), persist traces, or drive approval flows.
 */

import type { Message, TokenUsage } from '../types.js';
import type { ToolResult } from '../tools/tool.js';
import type { AgentResult } from './agent.js';

export type AgentEvent =
  | { type: 'agent.start'; input: string | Message[] }
  | { type: 'turn.start'; iteration: number }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.turn'; message: Message; usage?: TokenUsage }
  | { type: 'tool.call'; name: string; args: unknown; callId: string }
  | { type: 'tool.result'; name: string; callId: string; result: ToolResult; durationMs: number }
  | { type: 'tool.error'; name: string; callId: string; error: Error }
  | { type: 'agent.done'; result: AgentResult };

export type AgentEventHandler = (event: AgentEvent) => void;

export interface EventEmitter {
  on(handler: AgentEventHandler): void;
  emit(event: AgentEvent): void;
}

export function createEmitter(): EventEmitter {
  const handlers = new Set<AgentEventHandler>();
  return {
    on(handler) {
      handlers.add(handler);
    },
    emit(event) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          // An observer must never break the loop.
          console.warn(`[harness-kit] event handler threw:`, err);
        }
      }
    },
  };
}
