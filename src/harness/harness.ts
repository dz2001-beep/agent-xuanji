/**
 * Harness — the composition root.
 *
 * Takes a `HarnessConfig` and wires every subsystem together:
 *
 *   provider (openai-compatible | mock)
 *        + ToolRegistry (built-ins + MCP-adapted tools)
 *        + SkillRegistry (loaded from disk, auto-selected per request)
 *
 * `Harness.run()` is the one-call entry point: it selects relevant skills,
 * composes the system prompt, runs the Agent Loop and returns the result.
 */

import type { ChatProvider } from '../llm/provider.js';
import { OpenAICompatibleProvider } from '../llm/openai.js';
import { MockProvider } from '../llm/mock.js';
import { ToolRegistry } from '../tools/tool.js';
import { isBuiltinGroup, registerBuiltinTools } from '../tools/builtin.js';
import { McpRegistry } from '../mcp/registry.js';
import { SkillRegistry } from '../skills/registry.js';
import { renderSkills } from '../skills/skill.js';
import type { Message } from '../types.js';
import { Agent, type AgentOptions, type AgentResult, type RunOptions } from '../loop/agent.js';
import { normalizeConfig, type HarnessConfig } from './config.js';
import { DEFAULT_SYSTEM } from './system.js';

/** Extract the last user text from an input (used for skill selection). */
function queryText(input: string | Message[]): string {
  if (typeof input === 'string') return input;
  for (let i = input.length - 1; i >= 0; i--) {
    const m = input[i];
    if (m?.role === 'user' && m.content) return m.content;
  }
  return '';
}

export interface HarnessCreateOptions {
  config: HarnessConfig;
  /** API key override (falls back to config, then env). */
  apiKey?: string;
  /** Force the mock provider regardless of config (offline demos, CI). */
  forceMock?: boolean;
  /** Inject a fully custom provider (overrides config.provider). */
  provider?: ChatProvider;
}

export class Harness {
  readonly provider: ChatProvider;
  readonly tools: ToolRegistry;
  readonly mcp: McpRegistry;
  readonly skills: SkillRegistry;
  readonly config: Required<HarnessConfig>;

  private constructor(cfg: Required<HarnessConfig>, provider: ChatProvider) {
    this.config = cfg;
    this.provider = provider;
    this.tools = new ToolRegistry();
    this.mcp = new McpRegistry();
    this.skills = new SkillRegistry();
  }

  static async create(opts: HarnessCreateOptions): Promise<Harness> {
    const cfg = normalizeConfig(opts.config);
    const provider = opts.provider ?? buildProvider(cfg.provider, opts);
    const harness = new Harness(cfg, provider);

    // Built-in tools
    const groups = cfg.tools.filter((t) => isBuiltinGroup(t));
    const unknown = cfg.tools.filter((t) => !isBuiltinGroup(t));
    for (const g of unknown) console.warn(`[harness-kit] unknown builtin tool group "${g}" (known: fs, shell)`);
    registerBuiltinTools(harness.tools, groups);

    // MCP servers → adapted, namespaced tools
    for (const server of cfg.mcp) {
      try {
        const handle = await harness.mcp.connect(server);
        harness.tools.registerMany(harness.mcp.toTools().filter((t) => t.name.startsWith(`${handle.id}.`)));
        console.log(`[harness-kit] MCP connected: ${handle.id} (${handle.serverInfo}, ${handle.tools.length} tools)`);
      } catch (err) {
        console.error(`[harness-kit] failed to connect MCP server "${server.id}": ${(err as Error).message}`);
      }
    }

    // Skills
    for (const dir of cfg.skills.dirs) {
      const n = await harness.skills.loadDir(dir);
      console.log(`[harness-kit] skills loaded from ${dir}: ${n}`);
    }

    return harness;
  }

  /** Create an Agent bound to this harness. */
  buildAgent(opts: Partial<AgentOptions> = {}): Agent {
    return new Agent({
      provider: this.provider,
      tools: this.tools,
      system: this.config.system || DEFAULT_SYSTEM,
      maxIterations: this.config.budget.maxIterations,
      toolTimeoutMs: this.config.budget.toolTimeoutMs,
      maxRetries: this.config.budget.maxRetries,
      retryDelayMs: this.config.budget.retryDelayMs,
      ...opts,
    });
  }

  /**
   * One-call entry point: auto-select skills for `input`, compose the system
   * prompt, run the loop. `input` may be a plain string or a message list
   * (multi-turn history); skill selection uses the last user text.
   */
  async run(
    input: string | Message[],
    opts: RunOptions & { agent?: Agent } = {},
  ): Promise<AgentResult> {
    const agent = opts.agent ?? this.buildAgent();

    let system = this.config.system || DEFAULT_SYSTEM;
    const skillsCfg = this.config.skills;
    if (skillsCfg.autoSelect && this.skills.size > 0) {
      const selected = this.skills.select(queryText(input), {
        top: skillsCfg.maxSelected,
        threshold: skillsCfg.threshold,
      });
      if (selected.length > 0) {
        system += renderSkills(selected);
      }
    }

    return agent.run(input, { ...opts, system });
  }

  /** Tear down MCP connections. */
  async dispose(): Promise<void> {
    await this.mcp.disconnectAll();
  }
}

function buildProvider(provider: HarnessConfig['provider'], opts: HarnessCreateOptions): ChatProvider {
  if (opts.forceMock || provider.type === 'mock') {
    return new MockProvider();
  }
  if (provider.type !== 'openai') {
    throw new Error(`unknown provider type "${provider.type}"`);
  }
  // Empty-string env keys (e.g. `export DEEPSEEK_API_KEY=""`) are treated as
  // unset: pick the first non-empty candidate instead of the first defined one.
  const candidates = [opts.apiKey, provider.apiKey, process.env.OPENAI_API_KEY, process.env.DEEPSEEK_API_KEY];
  const apiKey = candidates.find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (!apiKey) {
    throw new Error(
      'no API key found: set config.provider.apiKey, OPENAI_API_KEY or DEEPSEEK_API_KEY ' +
        '(note: an empty value like DEEPSEEK_API_KEY="" counts as unset; pass --mock for an offline demo)',
    );
  }
  const openAIKey = process.env.OPENAI_API_KEY?.trim();
  const deepSeekKey = process.env.DEEPSEEK_API_KEY?.trim();
  const usingDeepSeekKey = !openAIKey && !!deepSeekKey;
  return new OpenAICompatibleProvider({
    model: provider.model,
    apiKey,
    baseURL: provider.baseURL ?? (usingDeepSeekKey ? 'https://api.deepseek.com' : undefined),
    temperature: provider.temperature,
    maxRetries: provider.maxRetries,
  });
}
