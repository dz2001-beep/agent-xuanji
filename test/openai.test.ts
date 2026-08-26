/**
 * Wire-name translation tests: namespaced harness tool names (fs.read_file,
 * weather.current) must survive the round-trip through the OpenAI wire
 * format, whose tool-name pattern is ^[a-zA-Z0-9_-]+$ (no dots).
 */

import { describe, expect, it } from 'vitest';
import type { Fetch } from 'openai/core';
import { fromWireToolName, OpenAICompatibleProvider, toWireToolName } from '../src/llm/openai.js';
import type { Tool } from '../src/tools/tool.js';

describe('tool wire-name translation', () => {
  it('encodes dots as __ (valid on the wire)', () => {
    expect(toWireToolName('fs.read_file')).toBe('fs__read_file');
    expect(toWireToolName('shell.run')).toBe('shell__run');
    expect(toWireToolName('weather.current')).toBe('weather__current');
  });

  it('never produces a dot on the wire', () => {
    for (const name of ['fs.read_file', 'weather.current', 'shell.run', 'a.b.c']) {
      expect(toWireToolName(name)).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('decodes __ back to dots', () => {
    expect(fromWireToolName('fs__read_file')).toBe('fs.read_file');
    expect(fromWireToolName('weather__current')).toBe('weather.current');
  });

  it('round-trips exactly', () => {
    for (const name of ['fs.read_file', 'fs.write_file', 'fs.list_dir', 'shell.run', 'weather.current', 'weather.time']) {
      expect(fromWireToolName(toWireToolName(name))).toBe(name);
    }
  });

  it('leaves single underscores untouched (only __ is a code point)', () => {
    expect(toWireToolName('my_tool')).toBe('my_tool');
    expect(fromWireToolName('my_tool')).toBe('my_tool');
    // a name that already contains __ decodes ambiguously — document the tradeoff
    expect(fromWireToolName('fs__read__file')).toBe('fs.read.file');
  });
});

describe('OpenAICompatibleProvider wire round-trip (fake fetch)', () => {
  const tool: Tool = {
    name: 'fs.read_file',
    description: 'read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async execute() {
      return { ok: true, data: null };
    },
  };

  it('forwards maxTokens as max_tokens', async () => {
    let sentBody: { max_tokens?: number } = {};
    const fakeFetch = async (url: unknown, init: { body?: string }): Promise<Response> => {
      sentBody = JSON.parse(String(init?.body)) as { max_tokens?: number };
      const payload = {
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const provider = new OpenAICompatibleProvider({
      model: 'm',
      apiKey: 'k',
      baseURL: 'http://fake.local',
      maxRetries: 0,
      fetch: fakeFetch as unknown as Fetch,
    });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], stream: false, maxTokens: 4 });
    expect(sentBody.max_tokens).toBe(4);
  });

  it('sends dot-free tool names and decodes returned tool calls', async () => {
    let sentTools: Array<{ function?: { name?: string } }> = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeFetch = async (url: any, init: any): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }> };
      sentTools = body.tools ?? [];
      const payload = {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'fs__read_file', arguments: '{"path":"a.txt"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const provider = new OpenAICompatibleProvider({
      model: 'test-model',
      apiKey: 'sk-test',
      baseURL: 'http://fake.local',
      maxRetries: 0,
      fetch: fakeFetch as unknown as Fetch,
    });

    const res = await provider.chat({
      messages: [{ role: 'user', content: 'read a.txt' }],
      tools: [tool],
      stream: false,
    });

    // tools sent to the API must be dot-free (the 400 the API rejected before)
    for (const t of sentTools) {
      expect(t.function?.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    expect(sentTools[0]?.function?.name).toBe('fs__read_file');

    // returned tool call name decoded back to the harness namespace
    expect(res.message.toolCalls[0]?.name).toBe('fs.read_file');
    expect(res.message.toolCalls[0]?.arguments).toEqual({ path: 'a.txt' });
  });
});
