/**
 * MCP integration tests — link the demo server in-memory (no subprocess),
 * exercising the real protocol client code path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { createDemoServer } from '../examples/mcp-servers/weather-server.js';

describe('McpRegistry (in-memory link)', () => {
  let registry: McpRegistry;
  let serverTransport: InMemoryTransport;

  beforeAll(async () => {
    const server = createDemoServer();
    const [clientTransport, serverTransportPair] = InMemoryTransport.createLinkedPair();
    serverTransport = serverTransportPair;
    await server.connect(serverTransport);

    registry = new McpRegistry();
    await registry.attach('weather', clientTransport);
  });

  afterAll(async () => {
    await registry.disconnectAll();
    await serverTransport.close();
  });

  it('lists tools from the server', () => {
    const handle = registry.get('weather')!;
    expect(handle.serverInfo).toContain('harness-kit-demo-server');
    const names = handle.tools.map((t) => t.name).sort();
    expect(names).toEqual(['current', 'time']);
  });

  it('adapts MCP tools with namespaced harness names', () => {
    const tools = registry.toTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['weather.current', 'weather.time']);
    const current = tools.find((t) => t.name === 'weather.current')!;
    expect(current.description).toContain('weather');
    expect(current.inputSchema.required).toEqual(['city']);
  });

  it('calls a tool by namespaced name and maps text content', async () => {
    const res = await registry.callTool('weather.current', { city: '北京' });
    expect(res.ok).toBe(true);
    expect(JSON.parse((res as { ok: true; data: string }).data)).toMatchObject({ city: '北京', temp: 24 });
  });

  it('executes an adapted Tool (execute → server round-trip)', async () => {
    const tools = registry.toTools();
    const timeTool = tools.find((t) => t.name === 'weather.time')!;
    const res = await timeTool.execute({ timezone: 'Asia/Shanghai' }, { callId: 't1' });
    expect(res.ok).toBe(true);
    expect((res as { ok: true; data: string }).data).toContain('Asia/Shanghai');
  });

  it('maps server errors to ok:false ToolResults', async () => {
    const res = await registry.callTool('weather.current', { city: 'atlantis' });
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain('unknown city');
  });

  it('reports unknown servers / unknown namespaced names', async () => {
    const res = await registry.callTool('nope.whatever', {});
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain('no connected MCP server "nope"');
  });

  it('refresh() re-lists tools without dropping the connection', async () => {
    await expect(registry.refresh()).resolves.toBeUndefined();
    expect(registry.get('weather')!.tools).toHaveLength(2);
  });

  it('attach() rejects duplicate server ids', async () => {
    const [clientTransport] = InMemoryTransport.createLinkedPair();
    await expect(registry.attach('weather', clientTransport)).rejects.toThrow(/already connected/);
  });
});
