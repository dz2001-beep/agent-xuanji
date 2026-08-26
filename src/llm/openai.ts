/**
 * OpenAI-compatible chat provider.
 *
 * Works against ANY endpoint that speaks the OpenAI Chat Completions wire
 * protocol — OpenAI, DeepSeek, Moonshot, Ollama's OpenAI shim, vLLM, etc.
 * Streaming support accumulates content and tool-call deltas, and reports
 * token usage via `stream_options.include_usage`.
 */

import OpenAI from 'openai';
import type { Fetch } from 'openai/core';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import type { ChatProvider, ChatRequest, ChatResponse } from './provider.js';
import type { Message, ToolCall } from '../types.js';
import type { Tool } from '../tools/tool.js';
import { emptyUsage } from '../types.js';

export interface OpenAIProviderOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  maxRetries?: number;
  /** Custom fetch impl (tests, proxies). Typed to the SDK's own Fetch. */
  fetch?: Fetch;
}

function toWireMessage(m: Message): ChatCompletionMessageParam {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content ?? '' };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content ?? '',
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: toWireToolName(tc.name), arguments: JSON.stringify(tc.arguments) },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content ?? '' };
  }
}

/**
 * Wire-name translation for tools.
 *
 * harness tool names use namespacing dots (`fs.read_file`, `weather.current`),
 * but OpenAI-compatible APIs only allow `^[a-zA-Z0-9_-]+$` in tool names and
 * reject dots with a 400. We therefore encode dots as `__` on the wire and
 * decode them back when parsing the model's tool calls. Underscores already
 * present in a name are left untouched (only `__` is a code point).
 */
const WIRE_SEP = '__';

export function toWireToolName(name: string): string {
  return name.replace(/\./g, WIRE_SEP);
}

export function fromWireToolName(name: string): string {
  return name.replace(/__/g, '.');
}

function toWireTool(t: Tool) {
  return {
    type: 'function' as const,
    function: { name: toWireToolName(t.name), description: t.description, parameters: t.inputSchema },
  };
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly name = 'openai-compatible';
  /** Current model — mutable so the web UI can switch models at runtime. */
  model: string;
  private client: OpenAI;
  private readonly temperature?: number;

  constructor(opts: OpenAIProviderOptions) {
    this.model = opts.model;
    this.temperature = opts.temperature;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? 'missing-api-key',
      baseURL: opts.baseURL,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: this.model,
      messages: req.messages.map(toWireMessage),
      stream: req.stream ?? false,
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools.map(toWireTool) } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(req.stream ? { stream_options: { include_usage: true } } : {}),
    };

    if (req.stream) {
      const streamParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        ...params,
        stream: true,
        stream_options: { include_usage: true },
      };
      return this.chatStream(streamParams, req);
    }
    return this.chatOnce(params, req);
  }

  private async chatOnce(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParams,
    req: ChatRequest,
  ): Promise<ChatResponse> {
    const res = await this.client.chat.completions.create(
      params as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { signal: req.signal },
    );
    const msg = res.choices[0]?.message;
    return {
      message: {
        content: msg?.content ?? null,
        toolCalls: parseToolCalls(msg?.tool_calls),
      },
      usage: res.usage
        ? {
            promptTokens: res.usage.prompt_tokens,
            completionTokens: res.usage.completion_tokens,
            totalTokens: res.usage.total_tokens,
          }
        : emptyUsage(),
    };
  }

  private async chatStream(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    req: ChatRequest,
  ): Promise<ChatResponse> {
    const stream = await this.client.chat.completions.create(params, { signal: req.signal });

    let content = '';
    const toolCalls = new Map<number, { id?: string; name?: string; arguments?: string }>();
    let usage = emptyUsage();

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        req.onDelta?.({ text: delta.content });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const acc = toolCalls.get(tc.index) ?? {};
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments = (acc.arguments ?? '') + tc.function.arguments;
          toolCalls.set(tc.index, acc);
        }
      }
    }

    const parsed: ToolCall[] = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({
        id: acc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: fromWireToolName(acc.name ?? 'unknown'),
        arguments: parseArguments(acc.arguments ?? ''),
      }));

    return { message: { content: content || null, toolCalls: parsed }, usage };
  }
}

function parseToolCalls(toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined): ToolCall[] {
  if (!toolCalls) return [];
  return toolCalls.map((tc) => ({
    id: tc.id,
    name: fromWireToolName(tc.function.name),
    arguments: parseArguments(tc.function.arguments),
  }));
}

function parseArguments(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Truncated/streamed arguments that fail to parse are kept as raw text;
    // the model sees the parse failure via the tool result and can retry.
    return raw;
  }
}
