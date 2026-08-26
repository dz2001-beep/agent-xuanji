/**
 * End-to-end demo for xuanji.
 *
 * Runs an agent that:
 *  1. auto-selects relevant skills for the request (skill system);
 *  2. calls a real MCP server over stdio (weather + time tools);
 *  3. reads a local file with a built-in tool (fs.read_file);
 *  4. produces a final answer through the Agent Loop.
 *
 * Provider selection:
 *  - With OPENAI_API_KEY / DEEPSEEK_API_KEY set → real model (openai-compatible).
 *  - Without keys → deterministic MockProvider (fully offline, CI-safe),
 *    scripted to exercise the same MCP + fs path.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadDotEnv } from '../src/env.js';
import { Harness } from '../src/harness/harness.js';
import { MockProvider } from '../src/llm/mock.js';
import type { AgentEvent } from '../src/loop/events.js';

loadDotEnv();

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a demo asset path that works both from source (`examples/…`,
 * when run via tsx) and from the compiled output (`dist/examples/…`,
 * when run after `npm run build`).
 */
function resolveDemoPath(rel: string): string {
  const candidates = [path.join(here, rel), path.join(here, '../../examples', rel)];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

const SKILLS_DIR = resolveDemoPath('skills');
const BUGGY_FILE = resolveDemoPath('sample/buggy.ts');

const PROMPT = '帮我 review 一下 examples/sample/buggy.ts 的代码有什么问题，并告诉我北京现在的天气怎么样。';

export async function runDemo(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  const mock = !apiKey;
  const usingDeepSeek = !process.env.OPENAI_API_KEY && !!process.env.DEEPSEEK_API_KEY;

  const provider = mock
    ? new MockProvider({
        turns: [
          {
            toolCalls: [{ id: 'call_1', name: 'weather.current', arguments: { city: '北京' } }],
          },
          {
            toolCalls: [{ id: 'call_2', name: 'fs.read_file', arguments: { path: BUGGY_FILE } }],
          },
          {
            content:
              '### 代码评审结论（Mock 演示模式）\n\n代码整体可读，但存在 3 处明显问题：\n\n' +
              '- 🔴 `sumTo` 中 `i <= n` 是 off-by-one（多算一次），且 `return sum / 0` 会产生 Infinity\n' +
              '- 🔴 `divide` 未处理 `b === 0`，会抛出异常\n' +
              '- 🟢 `format` 中残留 `console.log` 调试语句，变量名 `x` 语义不明\n\n' +
              '另外：北京当前 24°C，晴，湿度 40%（数据来自 MCP demo server）。',
          },
        ],
        simulateStream: true,
      })
    : undefined;

  const harness = await Harness.create({
    config: {
      provider: mock
        ? { type: 'mock', model: 'mock-model' }
        : {
            type: 'openai',
            model: process.env.HARNESS_DEMO_MODEL ?? (usingDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini'),
          },
      tools: ['fs', 'shell'],
      skills: { dirs: [SKILLS_DIR], autoSelect: true, maxSelected: 2 },
      mcp: [
        {
          id: 'weather',
          transport: 'stdio',
          command: 'node',
          args: [path.join(here, 'mcp-servers/weather-server.js')],
        },
      ],
      budget: { maxIterations: 10, toolTimeoutMs: 15_000 },
    },
    provider,
  });

  try {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  璇玑（xuanji）demo');
    console.log(`  provider : ${mock ? 'mock（离线演示，设 OPENAI_API_KEY/DEEPSEEK_API_KEY 体验真实模型）' : `openai-compatible (${provider?.name ?? 'custom'})`}`);
    const selected = harness.skills.select(PROMPT, { top: 2 });
    if (selected.length > 0) {
      console.log(`  skills   : 自动选中 ${selected.map((s) => `"${s.name}"`).join(', ')}（已注入 system prompt）`);
    }
    console.log(`  mcp      : ${harness.mcp.handlesList().map((h) => `${h.id} (${h.tools.map((t) => t.name).join(', ')})`).join(' | ')}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`\n用户请求: ${PROMPT}\n`);

    const agent = harness.buildAgent({
      stream: true,
      onEvent: (e) => printEvent(e),
    });

    const result = await agent.run(PROMPT);

    console.log('\n\n───── 最终回答 ─────\n');
    console.log(result.output);
    console.log('\n─────────────────────');
    console.log(
      `status=${result.status}  iterations=${result.iterations}  toolCalls=${result.toolCalls}  tokens=${result.usage.totalTokens}`,
    );
  } finally {
    await harness.dispose();
  }
}

function printEvent(e: AgentEvent): void {
  switch (e.type) {
    case 'turn.start':
      console.log(`\n── turn ${e.iteration} ──`);
      break;
    case 'llm.delta':
      process.stdout.write(e.text);
      break;
    case 'tool.call':
      console.log(`\n🔧 调用工具: ${e.name}(${JSON.stringify(e.args)})`);
      break;
    case 'tool.result':
      console.log(`✔ 工具返回 (${e.durationMs}ms)`);
      break;
    case 'tool.error':
      console.log(`✖ 工具错误: ${e.error.message}`);
      break;
    default:
      break;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1]!.split('/').pop() ?? '')) {
  await runDemo();
}
