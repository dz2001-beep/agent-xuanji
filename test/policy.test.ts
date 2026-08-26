/**
 * Policy engine tests: rule matching (exact/glob/when), decision matrix,
 * and Agent integration (deny / ask with approval callback / fail-closed).
 */

import { describe, expect, it } from 'vitest';
import { Agent } from '../src/loop/agent.js';
import { MockProvider } from '../src/llm/mock.js';
import { PolicyEngine, type PolicyConfig } from '../src/policy.js';
import { ToolRegistry } from '../src/tools/tool.js';
import type { ApprovalRequest } from '../src/loop/agent.js';

const CFG: PolicyConfig = {
  rules: [
    { id: 'deny-rm', tool: 'shell.*', when: { command: { matches: 'rm -rf' } }, action: 'deny', reason: '危险命令' },
    { id: 'ask-shell', tool: 'shell.*', action: 'ask' },
    { id: 'allow-read', tool: 'fs.read_file', action: 'allow' },
    { id: 'ask-write', tool: 'fs.write_file', when: { path: { matches: '^/etc/' } }, action: 'ask' },
  ],
  defaultAction: 'allow',
};

function engine(cfg: PolicyConfig = CFG): PolicyEngine {
  return new PolicyEngine(cfg);
}

describe('PolicyEngine', () => {
  it('denies with a parameter condition (dangerous shell)', () => {
    const r = engine().decide('shell.run', { command: 'rm -rf /tmp/x' });
    expect(r.decision).toBe('deny');
    expect(r.rule?.id).toBe('deny-rm');
  });

  it('asks for any other shell command (rule order: first match wins)', () => {
    expect(engine().decide('shell.run', { command: 'npm test' }).decision).toBe('ask');
  });

  it('allows explicit rules and falls back to defaultAction', () => {
    expect(engine().decide('fs.read_file', { path: 'a.txt' }).decision).toBe('allow');
    expect(engine().decide('web.search', { query: 'x' }).decision).toBe('allow'); // default
    expect(engine().decide('fs.write_file', { path: '/tmp/a.txt' }).decision).toBe('allow');
  });

  it('applies when-conditions only when they match', () => {
    expect(engine().decide('fs.write_file', { path: '/etc/hosts' }).decision).toBe('ask');
    expect(engine().decide('fs.write_file', { path: 'src/a.ts' }).decision).toBe('allow');
  });

  it('defaultAction can be deny (fail closed)', () => {
    const e = new PolicyEngine({ rules: [], defaultAction: 'deny' });
    expect(e.decide('anything', {}).decision).toBe('deny');
  });

  it('matches trailing-* globs', () => {
    expect(engine().decide('shell.run2', { command: 'echo' }).decision).toBe('ask');
  });
});

describe('Agent policy integration', () => {
  function makeTool(): ToolRegistry {
    const r = new ToolRegistry();
    r.register({
      name: 'shell.run',
      description: 'run',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      async execute(input) {
        const { command } = input as { command: string };
        return { ok: true, data: `ran: ${command}` };
      },
    });
    return r;
  }

  it('denies tool calls rejected by policy (no execution)', async () => {
    const provider = new MockProvider({
      turns: [
        { toolCalls: [{ id: 'c1', name: 'shell.run', arguments: { command: 'rm -rf /tmp/x' } }] },
        { content: '好的，不执行危险命令' },
      ],
    });
    const agent = new Agent({ provider, tools: makeTool(), policy: engine() });
    const res = await agent.run('go');
    expect(res.status).toBe('ok');
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('策略拒绝');
    expect(toolMsg?.content).toContain('危险命令');
  });

  it('asks and executes when the approval callback allows', async () => {
    const approved: ApprovalRequest[] = [];
    const provider = new MockProvider({
      turns: [
        { toolCalls: [{ id: 'c1', name: 'shell.run', arguments: { command: 'npm test' } }] },
        { content: '已执行' },
      ],
    });
    const agent = new Agent({
      provider,
      tools: makeTool(),
      policy: engine(),
      onApproval: async (req) => {
        approved.push(req);
        return true;
      },
    });
    const res = await agent.run('go');
    expect(approved).toHaveLength(1);
    expect(approved[0]?.toolName).toBe('shell.run');
    expect(res.status).toBe('ok');
    expect(res.messages.find((m) => m.role === 'tool')?.content).toContain('ran: npm test');
  });

  it('fails closed when the approval callback denies', async () => {
    const provider = new MockProvider({
      turns: [
        { toolCalls: [{ id: 'c1', name: 'shell.run', arguments: { command: 'npm test' } }] },
        { content: '尊重用户选择' },
      ],
    });
    const agent = new Agent({ provider, tools: makeTool(), policy: engine(), onApproval: async () => false });
    const res = await agent.run('go');
    expect(res.messages.find((m) => m.role === 'tool')?.content).toContain('被用户拒绝');
  });

  it('fails closed when no approval callback is provided', async () => {
    const provider = new MockProvider({
      turns: [
        { toolCalls: [{ id: 'c1', name: 'shell.run', arguments: { command: 'npm test' } }] },
        { content: 'done' },
      ],
    });
    const agent = new Agent({ provider, tools: makeTool(), policy: engine() });
    const res = await agent.run('go');
    expect(res.messages.find((m) => m.role === 'tool')?.content).toContain('需要人工确认');
  });
});
