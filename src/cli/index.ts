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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Harness } from '../harness/harness.js';
import { loadConfigFile, type HarnessConfig } from '../harness/config.js';
import { summarizeSkill } from '../skills/skill.js';

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

    const harness = await Harness.create({ config: cfg, forceMock: opts.mock });
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

/* ------------------------------ helpers ---------------------------- */

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
