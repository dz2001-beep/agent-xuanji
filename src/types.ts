/**
 * Shared, provider-agnostic message and usage types.
 *
 * The harness speaks ONE internal message dialect (below) and each
 * `ChatProvider` is responsible for translating to/from its wire format.
 * This is what keeps the Agent Loop decoupled from any particular vendor.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A tool invocation requested by the model. `arguments` is a parsed JSON object. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** One message in the conversation transcript. */
export interface Message {
  role: Role;
  /** Text content. May be null when the message only carries tool calls. */
  content: string | null;
  /** Required when role === 'tool': links the result back to the original call. */
  toolCallId?: string;
  /** Required when role === 'assistant' and the model requested tools. */
  toolCalls?: ToolCall[];
}

/** Aggregated token accounting for a run (or a single LLM turn). */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addUsage(a: TokenUsage, b?: TokenUsage): TokenUsage {
  if (!b) return a;
  a.promptTokens += b.promptTokens;
  a.completionTokens += b.completionTokens;
  a.totalTokens += b.totalTokens;
  return a;
}
