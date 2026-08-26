/**
 * Weather MCP server: REAL weather + IP-based city location (no API keys).
 *
 *  - weather.current(city?): real weather via open-meteo (geocoding + forecast);
 *    when `city` is omitted the city is auto-detected from the caller's IP
 *    (ip-api.com). Falls back to bundled demo data when the network fails.
 *  - geo.city: IP-based city detection (ip-api.com, zh-CN).
 *  - time: current time for a timezone.
 *
 * Runs standalone over stdio (spawned by the harness config) and also
 * exports `createWeatherServer()` so tests can link it in-memory.
 *
 * NOTE: never log to stdout here — stdio is the MCP wire protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const FETCH_TIMEOUT_MS = 6_000;

/** Bundled fallback data (used when the network is unreachable). */
const DEMO_CITIES: Record<string, { temp: number; condition: string; humidity: number }> = {
  北京: { temp: 24, condition: '晴', humidity: 40 },
  'beijing': { temp: 24, condition: 'sunny', humidity: 40 },
  上海: { temp: 28, condition: '多云', humidity: 65 },
  'shanghai': { temp: 28, condition: 'cloudy', humidity: 65 },
  深圳: { temp: 31, condition: '雷阵雨', humidity: 80 },
  'shenzhen': { temp: 31, condition: 'thunderstorms', humidity: 80 },
  杭州: { temp: 26, condition: '小雨', humidity: 72 },
  'hangzhou': { temp: 26, condition: 'light rain', humidity: 72 },
};

/** WMO weather codes → Chinese description. */
const WMO: Record<number, string> = {
  0: '晴',
  1: '基本晴',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷暴',
};

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Detect the caller's city from the public IP (ip-api.com, no key needed). */
async function detectCity(): Promise<{ city: string; region: string; country: string; lat: number; lon: number }> {
  const data = (await fetchJson('http://ip-api.com/json/?lang=zh-CN')) as {
    status: string;
    city?: string;
    regionName?: string;
    country?: string;
    lat?: number;
    lon?: number;
  };
  if (data.status !== 'success' || !data.city) throw new Error('IP 定位失败');
  return {
    city: data.city,
    region: data.regionName ?? '',
    country: data.country ?? '',
    lat: data.lat ?? 0,
    lon: data.lon ?? 0,
  };
}

/** Geocode a city name to coordinates (open-meteo geocoding API). */
async function geocodeCity(name: string): Promise<{ name: string; lat: number; lon: number }> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`;
  const data = (await fetchJson(url)) as { results?: Array<{ name: string; latitude: number; longitude: number }> };
  const first = data.results?.[0];
  if (!first) throw new Error(`找不到城市: ${name}`);
  return { name: first.name, lat: first.latitude, lon: first.longitude };
}

/** Real current weather via open-meteo forecast API. */
async function fetchWeather(lat: number, lon: number): Promise<{ temp: number; condition: string; humidity: number; wind: number }> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current_weather=true&hourly=relativehumidity_2m,weathercode&forecast_days=1&timezone=auto`;
  const data = (await fetchJson(url)) as {
    current_weather?: { temperature?: number; weathercode?: number; windspeed?: number };
    hourly?: { relativehumidity_2m?: number[]; weathercode?: number[] };
  };
  const cur = data.current_weather ?? {};
  const humidity = data.hourly?.relativehumidity_2m?.[0] ?? 0;
  const code = cur.weathercode ?? data.hourly?.weathercode?.[0] ?? 0;
  return {
    temp: Math.round(cur.temperature ?? 0),
    condition: WMO[code] ?? `码${code}`,
    humidity: Math.round(humidity),
    wind: Math.round(cur.windspeed ?? 0),
  };
}

export function createWeatherServer(): Server {
  const server = new Server(
    { name: 'xuanji-demo-server', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'current',
        description:
          '查询某城市的实时天气（温度/天气状况/湿度/风速）。不传 city 时自动用 IP 定位你的城市 —— 问"天气怎么样"即可知道你在哪。',
        inputSchema: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: '城市名（如 北京、沈阳、上海；缺省 = 自动 IP 定位）',
            },
          },
          required: [],
        },
      },
      {
        name: 'geo.city',
        description: '通过 IP 定位当前所在城市（返回城市/省份/国家/经纬度）。',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'time',
        description: '获取当前日期与时间，可按 IANA 时区。',
        inputSchema: {
          type: 'object',
          properties: { timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai（默认本地）' } },
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
          const cityArg = String((args as { city?: unknown })?.city ?? '').trim();
          const started = Date.now();
          try {
            let city: string;
            let lat: number;
            let lon: number;
            if (cityArg) {
              const geo = await geocodeCity(cityArg);
              city = geo.name;
              lat = geo.lat;
              lon = geo.lon;
            } else {
              const loc = await detectCity();
              city = loc.city;
              lat = loc.lat;
              lon = loc.lon;
            }
            const weather = await fetchWeather(lat, lon);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    city,
                    ...weather,
                    unit: 'celsius',
                    source: 'open-meteo',
                    latencyMs: Date.now() - started,
                  }),
                },
              ],
              isError: false,
            };
          } catch (err) {
            // Network fallback: bundled demo data keeps the agent moving.
            const city = cityArg || '未知';
            const demo = DEMO_CITIES[city] ?? DEMO_CITIES[city.toLowerCase()] ?? DEMO_CITIES['北京']!;
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    city,
                    ...demo,
                    unit: 'celsius',
                    source: 'demo-fallback（网络不可达）',
                    error: (err as Error).message,
                  }),
                },
              ],
              isError: false,
            };
          }
        }
        case 'geo.city': {
          const data = await detectCity();
          return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], isError: false };
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
  const server = createWeatherServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[weather-server] MCP server ready on stdio');
}
