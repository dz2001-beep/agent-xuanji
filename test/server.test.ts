/**
 * UiServer tests — start a real HTTP server on a random port and exercise
 * the API over the wire (health, state, dirs, cwd, and the SSE chat stream
 * with a scripted mock provider).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from '../src/harness/harness.js';
import { MockProvider } from '../src/llm/mock.js';
import type { ChatProvider } from '../src/llm/provider.js';
import { UiServer } from '../src/server/server.js';
import type { ChatFrame } from '../src/server/session.js';

let harness: Harness;
let server: UiServer;
let base: string;

const MOCK_TURNS = [
  { toolCalls: [{ id: 'c1', name: 'echo.demo', arguments: { text: 'hi' } }] },
  { content: '完成：收到 hi。' },
];

let savedSettingsHome: string | undefined;

beforeAll(async () => {
  savedSettingsHome = process.env.XUANJI_HOME;
  process.env.XUANJI_HOME = await (await import('node:fs')).promises.mkdtemp(
    (await import('node:path')).join((await import('node:os')).tmpdir(), 'xuanji-server-'),
  );
  harness = await Harness.create({
    config: {
      provider: { type: 'mock', model: 'mock-model' },
      tools: ['fs'],
      skills: { dirs: [] },
    },
    provider: new MockProvider({ turns: MOCK_TURNS, simulateStream: true }),
  });
  harness.tools.register({
    name: 'echo.demo',
    description: 'demo echo tool',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(input) {
      const { text } = input as { text: string };
      return { ok: true, data: `echo:${text}` };
    },
  });

  server = new UiServer({ harness, port: 0 });
  const { url } = await server.start();
  base = url;
});

afterAll(async () => {
  await server.stop();
  await harness.dispose();
  if (savedSettingsHome === undefined) delete process.env.XUANJI_HOME;
  else process.env.XUANJI_HOME = savedSettingsHome;
});

describe('UiServer', () => {
  it('serves the web UI', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect((await res.text()).includes('xuanji 工作台')).toBe(true);
  });

  it('exposes health', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('reports session state', async () => {
    const res = await fetch(`${base}/api/state`);
    const state = (await res.json()) as { cwd: string; provider: string; tools: string[]; skills: unknown[] };
    expect(state.cwd).toBe(process.cwd());
    expect(state.provider).toBe('mock');
    expect(state.tools).toContain('fs.read_file');
    expect(Array.isArray(state.skills)).toBe(true);
  });

  it('lists directories for the folder browser', async () => {
    const res = await fetch(`${base}/api/dirs?path=${encodeURIComponent(process.cwd())}`);
    const data = (await res.json()) as { path: string; dirs: string[] };
    expect(data.path).toBe(process.cwd());
    expect(Array.isArray(data.dirs)).toBe(true);
    expect(data.dirs).toContain('src');
  });

  it('rejects non-existent directories', async () => {
    const res = await fetch(`${base}/api/dirs?path=/definitely/not/here-xyz`);
    expect(res.status).toBe(500);
  });

  it('switches the session working directory', async () => {
    const res = await fetch(`${base}/api/cwd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: process.cwd() }),
    });
    const body = (await res.json()) as { cwd: string };
    expect(body.cwd).toBe(process.cwd());

    const bad = await fetch(`${base}/api/cwd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/definitely/not/here-xyz' }),
    });
    expect(bad.status).toBe(500);
  });

  it('streams chat frames over SSE and replays tool events', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '跑一次 demo 流程' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames: ChatFrame[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
      }
    }

    const types = frames.map((f) => f.type);
    expect(types[0]).toBe('meta');
    expect(types).toContain('agent');
    expect(types[types.length - 1]).toBe('done');

    const events = frames.flatMap((f) => (f.type === 'agent' ? [f.event] : []));
    const toolNames = events.filter((e) => e.type === 'tool.call').map((e) => (e as { name: string }).name);
    expect(toolNames).toContain('echo.demo');

    const deltas = events
      .filter((e) => e.type === 'llm.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(deltas.length).toBeGreaterThan(0);

    const done = frames[frames.length - 1] as Extract<ChatFrame, { type: 'done' }>;
    expect(done.status).toBe('ok');
    expect(done.toolCalls).toBe(1);
  });

  it('rejects empty chat messages', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('supports aborting a run', async () => {
    const abortRes = await fetch(`${base}/api/abort`, { method: 'POST' });
    const body = (await abortRes.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('clears conversation history', async () => {
    const res = await fetch(`${base}/api/clear`, { method: 'POST' });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect(state.history).toBeUndefined(); // history stays server-side only
  });

  it('switches the model via the API and validates unknown models', async () => {
    const res = await fetch(`${base}/api/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-reasoner' }),
    });
    const body = (await res.json()) as { ok: boolean; model: string };
    expect(body.ok).toBe(true);
    expect(body.model).toBe('deepseek-reasoner');

    const state = (await (await fetch(`${base}/api/state`)).json()) as { model: string; models: string[] };
    expect(state.model).toBe('deepseek-reasoner');
    expect(Array.isArray(state.models)).toBe(true);

    const bad = await fetch(`${base}/api/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-model-xyz' }),
    });
    expect(bad.status).toBe(500);
  });

  it('rejects /api/city with a clear hint when no weather server is configured', async () => {
    const res = await fetch(`${base}/api/city`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: '长春' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('weather');
  });

  it('exposes vendor presets and current settings (masked)', async () => {
    const res = await fetch(`${base}/api/settings`);
    const data = (await res.json()) as { vendors: Array<{ id: string }>; current: { vendor: string; model: string } };
    expect(data.vendors.map((v) => v.id)).toEqual(expect.arrayContaining(['deepseek', 'openai', 'ollama', 'custom']));
    expect(data.current.model).toBeTruthy();
  });

  it('rejects settings test without a baseURL', async () => {
    const res = await fetch(`${base}/api/settings/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendor: 'custom', model: 'm' }),
    });
    expect(res.status).toBe(400);
  });

  it('records runs and serves the full event chain for the trace view', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '链路测试' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const done = text
      .split('\n\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
      .find((f) => f.type === 'done') as { runId: string; status: string };
    expect(done.runId).toBeTruthy();

    const runs = (await (await fetch(`${base}/api/runs`)).json()) as Array<{ id: string; input: string; status: string }>;
    const run = runs.find((r) => r.id === done.runId);
    expect(run).toBeTruthy();
    expect(run?.input).toBe('链路测试');

    const detail = (await (await fetch(`${base}/api/runs/${done.runId}`)).json()) as {
      events: Array<{ type: string }>;
      iterations: number;
    };
    expect(detail.events.length).toBeGreaterThan(0);
    expect(detail.events[0]?.type).toBe('agent.start');
    expect(detail.events.some((e) => e.type === 'llm.turn')).toBe(true);

    const missing = await fetch(`${base}/api/runs/does-not-exist`);
    expect(missing.status).toBe(404);
  });

  it('surfaces run-level errors (status "error") with their reason in the done frame', async () => {
    const failing: ChatProvider = {
      name: 'failing',
      async chat() {
        throw new Error('mock 402: insufficient balance');
      },
    };
    const h = await Harness.create({
      config: {
        provider: { type: 'mock', model: 'm' },
        budget: { maxRetries: 0 }, // fail fast, no backoff in tests
      },
      provider: failing,
    });
    const s = new UiServer({ harness: h, port: 0 });
    const { url } = await s.start();
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      const text = await res.text();
      const frames = text
        .split('\n\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6)));
      const done = frames.find((f) => f.type === 'done') as { status: string; error?: string };
      expect(done.status).toBe('error');
      expect(done.error).toContain('402');
    } finally {
      await s.stop();
      await h.dispose();
    }
  });
  it('saves settings and hot-swaps the provider', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendor: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'sk-test-123', model: 'deepseek-chat' }),
    });
    const body = (await res.json()) as { ok: boolean; model: string };
    expect(body.ok).toBe(true);
    expect(body.model).toBe('deepseek-chat');

    // hot-swapped provider reflects the new model
    const state = (await (await fetch(`${base}/api/state`)).json()) as { model: string };
    expect(state.model).toBe('deepseek-chat');

    // invalid: empty model rejected
    const bad = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendor: 'deepseek', model: '  ' }),
    });
    expect(bad.status).toBe(400);
  });

  it('manages multiple isolated workspaces', async () => {
    // list: default workspace exists
    const list0 = (await (await fetch(`${base}/api/workspaces`)).json()) as { workspaces: Array<{ id: string; name: string; active: boolean }> };
    expect(list0.workspaces.length).toBeGreaterThan(0);
    expect(list0.workspaces.some((w) => w.active)).toBe(true);

    // create + auto-activate a new workspace
    const created = (await (
      await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '项目A', path: process.cwd() }),
      })
    ).json()) as { ok: boolean; workspace: { id: string; name: string } };
    expect(created.ok).toBe(true);
    expect(created.workspace.name).toBe('项目A');

    // activate a workspace by id
    const firstId = list0.workspaces[0]!.id;
    const activated = (await (
      await fetch(`${base}/api/workspaces/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: firstId }),
      })
    ).json()) as { ok: boolean; cwd: string };
    expect(activated.ok).toBe(true);
    expect(activated.cwd).toBe(process.cwd());

    // state reflects workspace list
    const state = (await (await fetch(`${base}/api/state`)).json()) as { workspaces: Array<{ id: string; active: boolean }> };
    expect(state.workspaces.length).toBe(2);

    // invalid workspace path rejected
    const bad = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad', path: '/definitely/not/here-xyz' }),
    });
    expect(bad.status).toBe(500);

    // delete non-active workspace (keep at least one)
    const del = await fetch(`${base}/api/workspaces/${created.workspace.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = (await (await fetch(`${base}/api/workspaces`)).json()) as { workspaces: unknown[] };
    expect(after.workspaces.length).toBe(1);
  });

});
