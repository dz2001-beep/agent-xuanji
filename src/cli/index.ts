#!/usr/bin/env node
/**
 * harness-kit CLI
 *
 *   harness-kit run "prompt..."      run an agent (config or flags)
 *   harness-kit mcp list             connect configured MCP servers and list tools
 *   harness-kit skills list          list skills from configured directories
 *   harness-kit skills show <name>   show one skill's instructions
 *   harness-kit demo                 run the bundled end-to-end demo
 */

import { Command } from 'commander';
import { promises as fs, appendFileSync } from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from '../env.js';
import { Harness } from '../harness/harness.js';
import { loadConfigFile, type HarnessConfig } from '../harness/config.js';
import { summarizeSkill } from '../skills/skill.js';
import type { UiLogger } from '../server/server.js';

// Load .env before anything reads process.env (API keys, config resolution…).
loadDotEnv();

const DEFAULT_CONFIG = 'harness.config.json';

interface CliOptions {
  config?: string;
  model?: string;
  mock?: boolean;
  stream?: boolean;
  verbose?: boolean;
  maxIterations?: number;
}

async function resolveConfig(opts: CliOptions): Promise<HarnessConfig> {
  const configPath = opts.config ?? DEFAULT_CONFIG;
  let cfg: HarnessConfig;
  if (opts.mock) {
    cfg = { provider: { type: 'mock', model: 'mock-model' } };
  } else if (await fs.access(configPath).then(() => true).catch(() => false)) {
    cfg = await loadConfigFile(configPath);
  } else {
    cfg = { provider: { type: 'openai', model: 'deepseek-chat' } };
  }
  if (opts.model) cfg.provider.model = opts.model;
  return cfg;
}

const program = new Command();
program
  .name('harness-kit')
  .description('A lightweight agent harness: Agent Loop + MCP + Skills')
  .version('0.1.0');

/* ------------------------------- run ------------------------------- */

program
  .command('run')
  .description('Run an agent with the given prompt (reads stdin when no prompt is given)')
  .argument('[prompt...]', 'the user request')
  .option('-c, --config <path>', `config file (default ${DEFAULT_CONFIG})`)
  .option('-m, --model <model>', 'override the model')
  .option('--mock', 'use the deterministic mock provider (no API key needed)')
  .option('--no-stream', 'disable streaming output')
  .option('--verbose', 'print the full event timeline and transcript')
  .option('-i, --max-iterations <n>', 'cap loop iterations', parseInt)
  .action(async (promptWords: string[], opts: CliOptions & { maxIterations?: number }) => {
    let prompt = promptWords.join(' ');
    if (!prompt && process.stdin.isTTY) {
      console.error('harness-kit: no prompt given; pass one or pipe text via stdin');
      process.exit(1);
    }
    if (!prompt) {
      prompt = (await readStdin()).trim();
    }

    const cfg = await resolveConfig(opts);
    if (opts.maxIterations) cfg.budget = { ...cfg.budget, maxIterations: opts.maxIterations };

    const harness = await Harness.create({ config: cfg, forceMock: opts.mock }).catch((err: Error) => {
      console.error(`[harness-kit] 启动失败: ${err.message}`);
      if (err.message.includes('API key')) {
        console.error('  提示: 设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重试；离线体验可加 --mock');
      }
      process.exit(1);
    });
    if (!harness) process.exit(1);
    try {
      let streamed = false;
      const agent = harness.buildAgent({
        stream: opts.stream,
        onEvent: (e) => {
          if (e.type === 'llm.delta') {
            streamed = true;
            process.stdout.write(e.text);
          } else if (opts.verbose) {
            printVerboseEvent(e);
          }
        },
      });

      process.stdout.write('\n');
      const result = await agent.run(prompt);
      // Providers that deliver the final answer without deltas still need it printed.
      if (!streamed && result.output) {
        process.stdout.write(result.output);
      }

      process.stdout.write('\n\n');
      if (result.status !== 'ok') {
        console.error(`[harness-kit] run finished with status "${result.status}"`);
        if (result.error) console.error(`[harness-kit] error: ${result.error.message}`);
      }
      console.log(
        `[harness-kit] iterations=${result.iterations} toolCalls=${result.toolCalls} ` +
          `tokens=${result.usage.totalTokens} status=${result.status}`,
      );
    } finally {
      await harness.dispose();
    }
  });

/* ------------------------------- mcp ------------------------------- */

program
  .command('mcp')
  .description('Inspect MCP servers configured in the config file')
  .argument('[action]', 'action: list (default)')
  .option('-c, --config <path>', `config file (default ${DEFAULT_CONFIG})`)
  .action(async (action: string | undefined, opts: { config?: string }) => {
    const cfg = await resolveConfig(opts as CliOptions);
    // Introspection only — the provider itself is irrelevant here, so never
    // fail on a missing API key.
    const harness = await Harness.create({ config: cfg, forceMock: true });
    try {
      const handles = harness.mcp.handlesList();
      if (handles.length === 0) {
        console.log('no MCP servers configured');
        return;
      }
      for (const handle of handles) {
        console.log(`\nserver: ${handle.id} (${handle.serverInfo})`);
        for (const tool of handle.tools) {
          console.log(`  - ${handle.id}.${tool.name}${tool.description ? `: ${oneLine(tool.description)}` : ''}`);
        }
      }
    } finally {
      await harness.dispose();
    }
  });

/* ------------------------------ skills ----------------------------- */

program
  .command('skills')
  .description('Inspect skills from configured directories')
  .argument('[action]', 'action: list | show <name>')
  .argument('[name]', 'skill name for "show"')
  .option('-c, --config <path>', `config file (default ${DEFAULT_CONFIG})`)
  .action(async (action: string | undefined, name: string | undefined, opts: { config?: string }) => {
    const cfg = await resolveConfig(opts as CliOptions);
    // Introspection only — the provider itself is irrelevant here, so never
    // fail on a missing API key.
    const harness = await Harness.create({ config: cfg, forceMock: true });
    try {
      const skills = harness.skills.list();
      if (action === 'show') {
        const skill = harness.skills.get(name ?? '');
        if (!skill) {
          console.error(`skill "${name}" not found (available: ${skills.map((s) => s.name).join(', ') || 'none'})`);
          process.exitCode = 1;
          return;
        }
        console.log(`# ${skill.name}\n${skill.description}\n`);
        console.log(skill.instructions);
        if (skill.resources.length > 0) {
          console.log(`\nresources: ${skill.resources.join(', ')}`);
        }
      } else {
        if (skills.length === 0) {
          console.log('no skills loaded (configure skills.dirs in the config file)');
          return;
        }
        for (const s of skills) console.log(summarizeSkill(s));
      }
    } finally {
      await harness.dispose();
    }
  });

/* ------------------------------- demo ------------------------------ */

program
  .command('demo')
  .description('Run the bundled end-to-end demo (MCP weather server + skills; mock provider without an API key)')
  .action(async () => {
    const { runDemo } = await import('../../examples/demo.js');
    await runDemo();
  });

/* -------------------------------- ui ------------------------------- */

program
  .command('ui')
  .description('Start the local web client (browser chat UI with a working-directory picker)')
  .option('-p, --port <port>', 'port to listen on (default 8787)', parseInt)
  .option('-c, --config <path>', `config file (default ${DEFAULT_CONFIG})`)
  .option('--mock', 'force the deterministic mock provider (no API key needed)')
  .option('--no-open', 'do not auto-open the browser')
  .option('--cwd <path>', 'initial working directory (default: process cwd)')
  .option('--log-file <path>', 'also append server logs to this file (e.g. /tmp/harness-ui.log)')
  .action(
    async (opts: {
      port?: number;
      config?: string;
      mock?: boolean;
      open?: boolean;
      cwd?: string;
      logFile?: string;
    }) => {
      const envOpenAI = process.env.OPENAI_API_KEY;
      const envDeepSeek = process.env.DEEPSEEK_API_KEY;
      const openAIEmpty = typeof envOpenAI === 'string' && envOpenAI.trim() === '';
      const deepSeekEmpty = typeof envDeepSeek === 'string' && envDeepSeek.trim() === '';
      const cfg = await resolveConfig(opts as CliOptions);

      // 空字符串 Key 是最常见的"以为设置了其实没有"的坑，给醒目标记。
      if (!opts.mock && (openAIEmpty || deepSeekEmpty)) {
        console.warn('');
        console.warn(`  ⚠ 检测到 ${openAIEmpty ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY'} 已设置但值是空字符串（export XXX=""）。`);
        console.warn(`    空值会被视为"未设置"。正确设置：export DEEPSEEK_API_KEY=sk-你的key 后重新运行。`);
        console.warn('');
      }

      // UI 是交互工具：没有有效 Key 时自动降级为 mock 并继续启动（界面照常打开，
      // banner 与前端都会明确提示原因），而不是直接失败。
      const hasValidKey = !!(cfg.provider.apiKey?.trim() || envOpenAI?.trim() || envDeepSeek?.trim());
      const effectiveMock = opts.mock || !hasValidKey;
      if (effectiveMock && !opts.mock) {
        console.warn('  ⚠ 未检测到有效 API Key，本次以 mock（离线演示）模式启动。');
        console.warn('    设置 DEEPSEEK_API_KEY 后重新运行本命令即可使用真实模型。');
        console.warn('');
      }

      const harness = await Harness.create({ config: cfg, forceMock: effectiveMock }).catch((err: Error) => {
        console.error(`[harness-kit] 启动失败: ${err.message}`);
        if (err.message.includes('API key')) {
          console.error('  提示: 设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重试；离线体验可加 --mock');
        }
        process.exit(1);
      });
      if (!harness) process.exit(1);

      const { UiServer } = await import('../server/server.js');
      const logger: UiLogger = createUiLogger(opts.logFile);
      const server = new UiServer({
        harness,
        port: opts.port ?? 8787,
        cwd: opts.cwd,
        logger,
      });

      const { url } = await server.start().catch((err: Error & { code?: string }) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[harness-kit] 端口 ${opts.port ?? 8787} 已被占用，换一个端口：--port 9000`);
        } else {
          console.error(`[harness-kit] 服务启动失败: ${err.message}`);
        }
        void harness.dispose();
        process.exit(1);
      });

      const keyLabel = opts.mock
        ? 'mock（--mock 强制）'
        : effectiveMock
          ? '✗ 未检测到有效 Key → 已降级 mock（离线）'
          : envOpenAI?.trim()
            ? '✓ OPENAI_API_KEY'
            : '✓ DEEPSEEK_API_KEY';

      console.log('');
      console.log('  ╭──────────────────────────────────────────╮');
      console.log('  │   harness-kit 工作台已启动                │');
      console.log('  ╰──────────────────────────────────────────╯');
      console.log(`  浏览器访问 : ${url}`);
      console.log(`  工作目录   : ${server.session.cwd}`);
      console.log(`  API Key    : ${keyLabel}`);
      console.log(`  provider   : ${harness.provider.name}`);
      console.log(`  model      : ${harness.config.provider.model}`);
      console.log(`  MCP servers: ${harness.mcp.handlesList().map((h) => h.id).join(', ') || '无'}`);
      console.log(`  skills     : ${harness.skills.list().map((s) => s.name).join(', ') || '无'}`);
      console.log(`  工具数量   : ${harness.tools.names().length}`);
      if (opts.logFile) console.log(`  日志文件   : ${opts.logFile}`);
      console.log('  运行日志见下方，Ctrl+C 退出');
      console.log('');

      if (opts.open !== false) {
        const { spawn } = await import('node:child_process');
        spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      }

      const shutdown = async () => {
        await server.stop();
        await harness.dispose();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    },
  );

/* ------------------------------ helpers ---------------------------- */

/** Timestamped log sink: console + optional file, used by the ui server. */
function createUiLogger(logFile?: string): UiLogger {
  return (level, message) => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    console.log(`  ${line}`);
    if (logFile) {
      try {
        appendFileSync(logFile, `${line}\n`);
      } catch (err) {
        console.warn(`  [harness-kit] 无法写入日志文件 ${logFile}: ${(err as Error).message}`);
      }
    }
  };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function printVerboseEvent(e: import('../loop/events.js').AgentEvent): void {
  switch (e.type) {
    case 'agent.start':
      console.log('\n[agent.start]');
      break;
    case 'turn.start':
      console.log(`\n[turn ${e.iteration}]`);
      break;
    case 'llm.turn':
      console.log(`[llm] ${oneLine(e.message.content ?? '(tool call)')}${e.usage ? ` (tokens: ${e.usage.totalTokens})` : ''}`);
      break;
    case 'tool.call':
      console.log(`[tool.call] ${e.name} ${JSON.stringify(e.args)}`);
      break;
    case 'tool.result':
      console.log(`[tool.result] ${e.name} (${e.durationMs}ms)`);
      break;
    case 'tool.error':
      console.log(`[tool.error] ${e.name}: ${e.error.message}`);
      break;
    case 'agent.done':
      console.log(`[agent.done] status=${e.result.status} iterations=${e.result.iterations} toolCalls=${e.result.toolCalls}`);
      break;
    default:
      break;
  }
}

// Lazy default help when no subcommand is given
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

await program.parseAsync(process.argv);
