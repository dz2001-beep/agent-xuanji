/**
 * ChatProvider — the single seam between the Agent Loop and any LLM backend.
 *
 * The loop only ever talks to this interface; providers translate our
 * provider-neutral `Message`/`Tool` types to their wire format.
 */

import type { Message, TokenUsage, ToolCall } from '../types.js';
import type { Tool } from '../tools/tool.js';

export interface ChatRequest {
  messages: Message[];
  /** Tools the model may call this turn. */
  tools?: Tool[];
  /** Stream deltas when true (providers may also deliver deltas in non-stream mode). */
  stream?: boolean;
  temperature?: number;
  /** Cap on completion tokens (diagnostics / cost control). */
  maxTokens?: number;
  /** Streaming text callback — the loop forwards it as `llm.delta` events. */
  onDelta?: (delta: { text: string }) => void;
  /** Cancellation. Providers should abort in-flight requests when aborted. */
  signal?: AbortSignal;
}

export interface AssistantMessage {
  content: string | null;
  toolCalls: ToolCall[];
}

export interface ChatResponse {
  message: AssistantMessage;
  usage?: TokenUsage;
}

export interface ChatProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** Merge two provider configs to keep the interface uniform. */
export interface ProviderConfig {
  type: 'openai' | 'mock';
  model: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  maxRetries?: number;
}
