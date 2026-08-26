/**
 * Agent Loop tests — all with the deterministic MockProvider, no network.
 */

import { describe, expect, it } from 'vitest';
import { Agent } from '../src/loop/agent.js';
import { MockProvider } from '../src/llm/mock.js';
import { ToolRegistry } from '../src/tools/tool.js';
import type { AgentEvent } from '../src/loop/events.js';

function echoRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async execute(input) {
      const { text } = input as { text: string };
      return { ok: true, data: text };
    },
  });
  return registry;
}

describe('Agent Loop', () => {
  it('returns the final answer on a no-tool-call turn', async () => {
    const provider = new MockProvider({ turns: [{ content: 'hello world' }] });
    const agent = new Agent({ provider });
    const res = await agent.run('hi');

    expect(res.status).toBe('ok');
    expect(res.output).toBe('hello world');
    expect(res.iterations).toBe(1);
    expect(res.toolCalls).toBe(0);
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('executes tool calls, feeds results back, and finishes on the next turn', async () => {
    const provider = new MockProvider({
      turns: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'ping' } }] },
        { content: 'pong' },
      ],
    });
    const agent = new Agent({ provider, tools: echoRegistry() });
    const res = await agent.run('go');

    expect(res.status).toBe('ok');
    expect(res.toolCalls).toBe(1);
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('ping');
    expect(toolMsg?.toolCallId).toBe('c1');
    expect(res.output).toBe('pong');
    // transcript order: user → assistant(tool call) → tool → assistant(final)
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('stops at maxIterations when the model never finishes', async () => {
    const provider = new MockProvider({
      turns: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'a' } }] },
        { toolCalls: [{ id: 'c2', name: 'echo', arguments: { text: 'b' } }] },
      ],
    });
    const agent = new Agent({ provider, tools: echoRegistry(), maxIterations: 2 });
    const res = await agent.run('go');

    expect(res.status).toBe('max-iterations');
    expect(res.iterations).toBe(2);
  });

  it('aborts immediately when the caller signal is already aborted', async () => {
    const provider = new MockProvider({ turns: [{ content: 'should never be used' }] });
    const agent = new Agent({ provider });
    const controller = new AbortController();
    controller.abort();

    const res = await agent.run('go', { signal: controller.signal });
    expect(res.status).toBe('aborted');
    expect(res.iterations).toBe(0);
  });

  it('recovers from an unknown tool call and finishes', async () => {
    const provider = new MockProvider({
      turns: [{ toolCalls: [{ id: 'c1', name: 'does_not_exist', arguments: {} }] }, { content: 'recovered' }],
    });
    const agent = new Agent({ provider, tools: echoRegistry() });
    const res = await agent.run('go');

    expect(res.status).toBe('ok');
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('unknown tool "does_not_exist"');
    expect(res.output).toBe('recovered');
  });

  it('reports a throwing tool as a recoverable tool error', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'boom',
      description: 'always throws',
      inputSchema: { type: 'object' },
      async execute() {
        throw new Error('kaboom');
      },
    });

    const events: AgentEvent[] = [];
    const provider = new MockProvider({
      turns: [{ toolCalls: [{ id: 'c1', name: 'boom', arguments: {} }] }, { content: 'still fine' }],
    });
    const agent = new Agent({ provider, tools: registry, onEvent: (e) => events.push(e) });
    const res = await agent.run('go');

    expect(res.status).toBe('ok');
    expect(res.messages.find((m) => m.role === 'tool')?.content).toContain('kaboom');
    expect(events.some((e) => e.type === 'tool.error')).toBe(true);
  });

  it('honours stopWhen after a tool turn', async () => {
    const provider = new MockProvider({
      turns: [{ toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'x' } }] }, { content: 'ignored' }],
    });
    const agent = new Agent({ provider, tools: echoRegistry(), stopWhen: () => true });
    const res = await agent.run('go');

    expect(res.status).toBe('stopped');
    expect(res.iterations).toBe(1);
  });

  it('rejects invalid tool arguments before execution', async () => {
    const provider = new MockProvider({
      turns: [{ toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] }, { content: 'done' }],
    });
    const agent = new Agent({ provider, tools: echoRegistry() });
    const res = await agent.run('go');

    expect(res.status).toBe('ok');
    expect(res.messages.find((m) => m.role === 'tool')?.content).toContain('missing required property "text"');
  });

  it('emits a well-ordered event stream', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockProvider({
      turns: [{ toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'x' } }] }, { content: 'final' }],
    });
    const agent = new Agent({ provider, tools: echoRegistry(), onEvent: (e) => events.push(e) });
    await agent.run('go');

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('agent.start');
    expect(types[1]).toBe('turn.start');
    expect(types).toContain('llm.turn');
    expect(types).toContain('tool.call');
    expect(types).toContain('tool.result');
    expect(types[types.length - 1]).toBe('agent.done');
  });

  it('forwards streaming deltas as llm.delta events', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockProvider({ turns: [{ content: 'streamed-answer' }], simulateStream: true });
    const agent = new Agent({ provider, stream: true, onEvent: (e) => events.push(e) });
    const res = await agent.run('go');

    const deltas = events.filter((e) => e.type === 'llm.delta').map((e) => (e as { text: string }).text);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('streamed-answer');
    expect(res.output).toBe('streamed-answer');
  });

  it('retries transient provider failures up to maxRetries', async () => {
    const provider = new MockProvider({ turns: [{ content: 'ok' }] });
    // A failing-once provider wrapper
    let failures = 1;
    const flaky = {
      name: 'flaky',
      async chat(req: Parameters<typeof provider.chat>[0]) {
        if (failures > 0) {
          failures--;
          throw new Error('transient 503');
        }
        return provider.chat(req);
      },
    };
    const agent = new Agent({ provider: flaky, maxRetries: 2, retryDelayMs: 5 });
    const res = await agent.run('go');
    expect(res.status).toBe('ok');
    expect(res.output).toBe('ok');
  });
});
