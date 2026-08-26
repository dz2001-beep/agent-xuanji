#!/usr/bin/env node
/**
 * xuanji CLI
 *
 *   xuanji run "prompt..."      run an agent (config or flags)
 *   xuanji mcp list             connect configured MCP servers and list tools
 *   xuanji skills list          list skills from configured directories
 *   xuanji skills show <name>   show one skill's instructions
 *   xuanji demo                 run the bundled end-to-end demo
 */

import { Command } from 'commander';
import { promises as fs, appendFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
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
  .name('xuanji')
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
  .option('--trace <path>', 'save the run as a replayable JSONL trace (e.g. /tmp/run.jsonl)')
  .option('-i, --max-iterations <n>', 'cap loop iterations', parseInt)
  .action(async (promptWords: string[], opts: CliOptions & { maxIterations?: number; trace?: string }) => {
    let prompt = promptWords.join(' ');
    if (!prompt && process.stdin.isTTY) {
      console.error('xuanji: no prompt given; pass one or pipe text via stdin');
      process.exit(1);
    }
    if (!prompt) {
      prompt = (await readStdin()).trim();
    }

    const cfg = await resolveConfig(opts);
    if (opts.maxIterations) cfg.budget = { ...cfg.budget, maxIterations: opts.maxIterations };

    const harness = await Harness.create({ config: cfg, forceMock: opts.mock }).catch((err: Error) => {
      console.error(`[xuanji] 启动失败: ${err.message}`);
      if (err.message.includes('API key')) {
        console.error('  提示: 设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重试；离线体验可加 --mock');
      }
      process.exit(1);
    });
    if (!harness) process.exit(1);
    try {
      const { TraceRecorder } = await import('../trace.js');
      const recorder = opts.trace ? new TraceRecorder() : null;

      let streamed = false;
      const agent = harness.buildAgent({
        stream: opts.stream,
        onEvent: (e) => {
          recorder?.onEvent(e);
          if (e.type === 'llm.delta') {
            streamed = true;
            process.stdout.write(e.text);
          } else if (opts.verbose) {
            printVerboseEvent(e);
          }
        },
        onApproval: async (req) => {
          console.log(`\n  ⚠ 策略审批请求：调用工具 ${req.toolName}`);
          console.log(`    参数: ${JSON.stringify(req.args)}`);
          if (req.reason) console.log(`    原因: ${req.reason}`);
          if (!process.stdin.isTTY) {
            console.log('    （非交互终端，默认拒绝）');
            return false;
          }
          const answer = await askLine('    允许执行？(y=允许一次 / n=拒绝): ');
          return answer.trim().toLowerCase() === 'y';
        },
      });

      process.stdout.write('\n');
      const result = await agent.run(prompt);
      // Providers that deliver the final answer without deltas still need it printed.
      if (!streamed && result.output) {
        process.stdout.write(result.output);
      }

      if (recorder) {
        recorder.setContext({ input: prompt, provider: harness.provider.name, model: harness.config.provider.model });
        await recorder.save(opts.trace!);
        console.log(`\n[轨迹] 已保存 ${recorder.eventCount} 个事件 → ${opts.trace}`);
      }

      process.stdout.write('\n\n');
      if (result.status !== 'ok') {
        console.error(`[xuanji] run finished with status "${result.status}"`);
        if (result.error) console.error(`[xuanji] error: ${result.error.message}`);
      }
      console.log(
        `[xuanji] iterations=${result.iterations} toolCalls=${result.toolCalls} ` +
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
        console.error(`[xuanji] 启动失败: ${err.message}`);
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
          console.error(`[xuanji] 端口 ${opts.port ?? 8787} 已被占用，换一个端口：--port 9000`);
        } else {
          console.error(`[xuanji] 服务启动失败: ${err.message}`);
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
      console.log('  │   璇玑（xuanji）工作台已启动        │');
      console.log('  ╰──────────────────────────────────────────╯');
      console.log(`  浏览器访问 : ${url}`);
      console.log(`  工作区     : ${server.session.cwd}（agent 生成内容都在这里，与产品代码隔离）`);
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

/* ------------------------------ replay ----------------------------- */

program
  .command('replay')
  .description('Offline replay of a recorded trace: validate order, show stats (no model calls)')
  .argument('<trace>', 'path to a JSONL trace file (from run --trace)')
  .action(async (tracePath: string) => {
    const { TraceRecorder } = await import('../trace.js');
    const { summarizeEvents } = await import('../replay.js');
    const trace = await TraceRecorder.load(tracePath);
    const s = summarizeEvents(trace.events);

    console.log(`\n  ═══ 轨迹重放: ${trace.meta.id} ═══`);
    console.log(`  输入     : ${trace.meta.input.slice(0, 60)}`);
    console.log(`  状态     : ${s.status} | 轮次: ${s.iterations} | 工具调用: ${s.toolCalls}`);
    console.log(`  tokens   : ${s.tokens.totalTokens}（prompt ${s.tokens.promptTokens} / completion ${s.tokens.completionTokens}）`);
    console.log(`  事件数   : ${s.eventCount}`);
    console.log(`  工具序列 : ${s.toolSequence.join(' → ') || '(无)'}`);
    if (s.violations.length > 0) {
      console.log(`  ⚠ 顺序校验失败 (${s.violations.length}):`);
      for (const v of s.violations) console.log(`    - ${v}`);
      process.exitCode = 1;
    } else {
      console.log('  顺序校验 : ✅ 事件序列合法');
    }
    console.log('  ═══════════════════════════════════\n');
  });

/* --------------------------- skill learn --------------------------- */

program
  .command('skill')
  .description('Skill tooling: learn — distill successful traces into a reusable SKILL.md')
  .argument('<action>', 'action: learn')
  .argument('[trace...]', 'one or more JSONL trace files (from run --trace)')
  .option('--dir <dir>', 'instead of explicit files: load every *.jsonl under this directory')
  .option('--name <name>', 'skill name (required)')
  .option('--description <desc>', 'skill description (used for relevance matching)')
  .option('-o, --out <path>', 'write SKILL.md to this path (default: print to stdout)')
  .action(
    async (
      action: string,
      traceArgs: string[],
      opts: { dir?: string; name?: string; description?: string; out?: string },
    ) => {
      if (action !== 'learn') {
        console.error(`xuanji: 未知 action "${action}"（支持 learn）`);
        process.exit(1);
      }
      if (!opts.name?.trim()) {
        console.error('xuanji: 需要 --name 指定技能名（如 --name "code-review"）');
        process.exit(1);
      }
      const { TraceRecorder } = await import('../trace.js');
      const { mergeTraces, renderSkillMd, loadTracesFromDir } = await import('../skilllearn.js');

      let traces = [];
      if (opts.dir) {
        traces = await loadTracesFromDir(opts.dir, (f) => TraceRecorder.load(f));
        console.log(`[xuanji] 从 ${opts.dir} 加载 ${traces.length} 条轨迹`);
      } else {
        if (traceArgs.length === 0) {
          console.error('xuanji: 请提供轨迹文件（或 --dir <目录>）');
          process.exit(1);
        }
        for (const f of traceArgs) traces.push(await TraceRecorder.load(f));
      }

      const learned = mergeTraces(traces, { name: opts.name, description: opts.description });
      if (!learned) {
        console.error(`xuanji: 没有成功运行的轨迹可提炼（需 status=ok）`);
        process.exit(1);
      }

      const md = renderSkillMd(learned);
      if (opts.out) {
        const { promises: fs } = await import('node:fs');
        await fs.mkdir(opts.out.split('/').slice(0, -1).join('/'), { recursive: true });
        await fs.writeFile(opts.out, md, 'utf8');
        console.log(`[xuanji] 已提炼技能 → ${opts.out}`);
        console.log(`  步骤: ${learned.steps.map((s) => `${s.name}(${s.count}/${learned.totalRuns})`).join(', ')}`);
        console.log(`  轨迹: ${learned.traceIds.join(', ')}`);
      } else {
        console.log(md);
      }
    },
  );

/* ------------------------------- trace ----------------------------- */

program
  .command('trace')
  .description('Trace tooling: diff two traces (golden vs actual) for regression testing')
  .argument('<action>', 'action: diff')
  .argument('<golden>', 'golden trace file')
  .argument('<actual>', 'actual trace file')
  .action(async (action: string, goldenPath: string, actualPath: string) => {
    const { TraceRecorder } = await import('../trace.js');
    const { compareTraces } = await import('../replay.js');
    const golden = await TraceRecorder.load(goldenPath);
    const actual = await TraceRecorder.load(actualPath);
    const diff = compareTraces(golden.events, actual.events);

    console.log(`\n  黄金轨迹: ${goldenPath}`);
    console.log(`  实际轨迹: ${actualPath}`);
    if (diff.identical) {
      console.log('  ✅ 行为一致（状态/轮次/工具序列/token 全部匹配）');
    } else {
      console.log(`  ⚠ 行为漂移 (${diff.differences.length} 处):`);
      for (const d of diff.differences) console.log(`    - ${d}`);
      process.exitCode = 1;
    }
    console.log('');
  });

/* ------------------------------ doctor ----------------------------- */

program
  .command('doctor')
  .description('One-command self-check: API key, model connectivity, tool wire names')
  .option('-c, --config <path>', `config file (default ${DEFAULT_CONFIG})`)
  .option('-m, --model <model>', 'model to test (default: from config)')
  .action(async (opts: { config?: string; model?: string }) => {
    const { detectKey, testModelCall, auditToolWireNames, resolveBaseURL } = await import('../diagnose.js');
    const { ToolRegistry } = await import('../tools/tool.js');
    const { registerBuiltinTools } = await import('../tools/builtin.js');
    const cfg = await resolveConfig(opts as CliOptions);
    if (opts.model) cfg.provider.model = opts.model;

    console.log('\n  ═══ xuanji doctor ═══\n');

    // [1] API key
    const key = detectKey(cfg);
    if (key.found) {
      console.log(`  [1/4] API Key .......... ✅ ${key.source} (${key.masked})`);
    } else {
      console.log(`  [1/4] API Key .......... ❌ ${key.source}`);
      console.log('        → 把 Key 放进项目根目录 .env（不会提交到 git）：');
      console.log("          echo 'DEEPSEEK_API_KEY=sk-你的key' > .env");
      console.log('        → 或 export DEEPSEEK_API_KEY=sk-你的key 后重试');
      console.log('        → 或临时离线体验：加 --mock');
    }

    // [2] model connectivity
    if (!key.found) {
      console.log('  [2/4] 模型调用 .......... ⏭ 跳过（无 API Key）');
    } else {
      const baseURL = resolveBaseURL(cfg);
      console.log(`  [2/4] 模型 ${cfg.provider.model} .... ⏳ 正在请求…`);
      const res = await testModelCall({
        model: cfg.provider.model,
        apiKey: key.masked.length > 0 ? getKeyForTest(cfg) : '',
        baseURL,
        maxRetries: 0,
      });
      if (res.ok) {
        console.log(`  [2/4] 模型 ${cfg.provider.model} .... ✅ 连通（${res.latencyMs}ms）`);
      } else {
        console.log(`  [2/4] 模型 ${cfg.provider.model} .... ❌ ${res.error}`);
        console.log(explainModelError(res.error ?? ''));
      }
      if (baseURL) console.log(`        baseURL: ${baseURL}`);
    }

    // [3] tool wire names
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, cfg.tools ?? []);
    const audit = auditToolWireNames(registry.names());
    if (audit.ok) {
      console.log(`  [3/4] 工具 wire 名 ....... ✅ ${registry.names().length} 个工具名全部符合 API 约束`);
    } else {
      console.log(`  [3/4] 工具 wire 名 ....... ❌ 非法名: ${audit.invalid.join(', ')}`);
    }

    // [4] workspace
    console.log(`  [4/4] 工作区 ............ ✅ ${process.cwd()}`);
    console.log('\n  ═══════════════════════════════════\n');
  });

/* ------------------------------ helpers ---------------------------- */

function getKeyForTest(cfg: HarnessConfig): string {
  return (
    cfg.provider.apiKey?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    ''
  );
}

function explainModelError(err: string): string {
  const e = err.toLowerCase();
  if (e.includes('401') || e.includes('auth')) return '        → API Key 无效，检查是否复制完整（sk- 开头）。';
  if (e.includes('402')) return '        → 账户余额不足，请到平台充值。';
  if (e.includes('model')) return '        → 模型名无效：用 --model 换一个试试（如 deepseek-chat / deepseek-reasoner）。';
  if (e.includes('fetch failed') || e.includes('econnrefused') || e.includes('network')) {
    return '        → 网络无法到达 API，检查代理/网络连接。';
  }
  return '';
}

/** Timestamped log sink: console + optional file, used by the ui server. */
function createUiLogger(logFile?: string): UiLogger {
  return (level, message) => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    console.log(`  ${line}`);
    if (logFile) {
      try {
        appendFileSync(logFile, `${line}\n`);
      } catch (err) {
        console.warn(`  [xuanji] 无法写入日志文件 ${logFile}: ${(err as Error).message}`);
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

/** Ask one question on the terminal (TTY only). */
function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
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
