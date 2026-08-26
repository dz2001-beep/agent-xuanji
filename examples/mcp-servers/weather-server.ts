/**
 * Demo MCP server: weather + time tools.
 *
 * Runs standalone over stdio (spawned by the harness config) and also
 * exports `createDemoServer()` so tests can link it in-memory.
 *
 * NOTE: never log to stdout here — stdio is the MCP wire protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const CITIES: Record<string, { temp: number; condition: string; humidity: number }> = {
  北京: { temp: 24, condition: '晴', humidity: 40 },
  'beijing': { temp: 24, condition: 'sunny', humidity: 40 },
  上海: { temp: 28, condition: '多云', humidity: 65 },
  'shanghai': { temp: 28, condition: 'cloudy', humidity: 65 },
  深圳: { temp: 31, condition: '雷阵雨', humidity: 80 },
  'shenzhen': { temp: 31, condition: 'thunderstorms', humidity: 80 },
  杭州: { temp: 26, condition: '小雨', humidity: 72 },
  'hangzhou': { temp: 26, condition: 'light rain', humidity: 72 },
};

export function createDemoServer(): Server {
  const server = new Server(
    { name: 'harness-kit-demo-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'current',
        description: 'Get the current weather for a city (temperature, condition, humidity).',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name (e.g. 北京, 上海, 深圳, 杭州 or pinyin)' } },
          required: ['city'],
        },
      },
      {
        name: 'time',
        description: 'Get the current date and time, optionally for a timezone.',
        inputSchema: {
          type: 'object',
          properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Shanghai (default: local)' } },
          required: [],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case 'current': {
          const city = String((args as { city?: unknown })?.city ?? '');
          const data = CITIES[city] ?? CITIES[city.toLowerCase()];
          if (!data) {
            return { content: [{ type: 'text' as const, text: `unknown city: ${city}` }], isError: true };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ city, ...data, unit: 'celsius', source: 'demo-server' }),
              },
            ],
            isError: false,
          };
        }
        case 'time': {
          const { timezone } = (args ?? {}) as { timezone?: string };
          const now = new Date();
          const text = timezone
            ? new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }).format(now)
            : now.toISOString();
          return { content: [{ type: 'text' as const, text: `${timezone ?? 'UTC'}: ${text}` }], isError: false };
        }
        default:
          return { content: [{ type: 'text' as const, text: `unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Entry point when spawned as a subprocess.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1]!.split('/').pop() ?? '')) {
  const server = createDemoServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[demo-server] MCP server ready on stdio');
}
