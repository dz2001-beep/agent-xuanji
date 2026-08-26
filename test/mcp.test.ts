/**
 * MCP integration tests — link the weather server in-memory (no subprocess),
 * exercising the real protocol client code path.
 *
 * The server talks to real (key-free) APIs — open-meteo / ip-api — when the
 * network allows, and falls back to bundled demo data otherwise. Assertions
 * therefore check structure (fields present, numeric values), not exact
 * values.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { createWeatherServer } from '../examples/mcp-servers/weather-server.js';

describe('McpRegistry (in-memory link)', () => {
  let registry: McpRegistry;
  let serverTransport: InMemoryTransport;

  beforeAll(async () => {
    const server = createWeatherServer();
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
    expect(handle.serverInfo).toContain('xuanji-demo-server');
    const names = handle.tools.map((t) => t.name).sort();
    expect(names).toEqual(['current', 'geo.city', 'time']);
  });

  it('adapts MCP tools with namespaced harness names', () => {
    const tools = registry.toTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['weather.current', 'weather.geo.city', 'weather.time']);
    const current = tools.find((t) => t.name === 'weather.current')!;
    expect(current.description).toContain('天气');
    // city is now optional (auto IP location)
    expect(current.inputSchema.required).toEqual([]);
  });

  it('calls weather.current with an explicit city (real or demo-fallback data)', async () => {
    const res = await registry.callTool('weather.current', { city: '北京' });
    expect(res.ok).toBe(true);
    const data = JSON.parse((res as { ok: true; data: string }).data) as {
      city: string;
      temp: number;
      condition: string;
      humidity: number;
    };
    expect(data.city).toBeTruthy();
    expect(typeof data.temp).toBe('number');
    expect(typeof data.condition).toBe('string');
  });

  it('weather.current without a city auto-detects the location (IP)', async () => {
    const res = await registry.callTool('weather.current', {});
    expect(res.ok).toBe(true);
    const data = JSON.parse((res as { ok: true; data: string }).data) as { city: string; temp: number };
    expect(data.city).toBeTruthy();
    expect(typeof data.temp).toBe('number');
  });

  it('geo.city reports a detected city when the network allows', async () => {
    const res = await registry.callTool('weather.geo.city', {});
    // Network-dependent: either a real location (ok) or an explicit failure.
    if (res.ok) {
      const data = JSON.parse((res as { ok: true; data: string }).data) as { city?: string };
      expect(data.city).toBeTruthy();
    } else {
      expect((res as { ok: false; error: string }).error).toBeTruthy();
    }
  });

  it('executes an adapted Tool (execute → server round-trip)', async () => {
    const tools = registry.toTools();
    const timeTool = tools.find((t) => t.name === 'weather.time')!;
    const res = await timeTool.execute({ timezone: 'Asia/Shanghai' }, { callId: 't1' });
    expect(res.ok).toBe(true);
    expect((res as { ok: true; data: string }).data).toContain('Asia/Shanghai');
  });

  it('maps server errors to ok:false ToolResults', async () => {
    const res = await registry.callTool('weather.time', { timezone: 'Not/AZone' });
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toBeTruthy();
  });

  it('reports unknown servers / unknown namespaced names', async () => {
    const res = await registry.callTool('nope.whatever', {});
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain('no connected MCP server "nope"');
  });

  it('refresh() re-lists tools without dropping the connection', async () => {
    await expect(registry.refresh()).resolves.toBeUndefined();
    expect(registry.get('weather')!.tools).toHaveLength(3);
  });

  it('attach() rejects duplicate server ids', async () => {
    const [clientTransport] = InMemoryTransport.createLinkedPair();
    await expect(registry.attach('weather', clientTransport)).rejects.toThrow(/already connected/);
  });
});
