/**
 * Harness configuration: one JSON file that wires everything together —
 * provider, built-in tool groups, skill directories, MCP servers, and
 * loop budgets.
 */

import { promises as fs } from 'node:fs';
import type { ProviderConfig } from '../llm/provider.js';
import type { McpServerConfig } from '../mcp/config.js';
import type { PolicyConfig } from '../policy.js';

export interface SkillsConfig {
  /** Directories to scan for SKILL.md packs (recursive). */
  dirs: string[];
  /** Auto-inject the top matching skills into the system prompt per request. */
  autoSelect?: boolean;
  /** Max skills auto-selected per request. */
  maxSelected?: number;
  /** Minimum relevance score for auto-selection. */
  threshold?: number;
}

export interface BudgetConfig {
  maxIterations?: number;
  toolTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  /** Context budget in estimated tokens; exceeding it triggers compaction. */
  maxContextTokens?: number;
  /** Trim oversized tool results when compacting (default true). */
  trimToolResults?: boolean;
  /** Tool results longer than this many chars get trimmed. */
  maxToolResultChars?: number;
}

export interface HarnessConfig {
  provider: ProviderConfig;
  /** Base system prompt (skills are appended by the harness at run time). */
  system?: string;
  /** Built-in tool groups to enable: "fs", "shell". Default: both. */
  tools?: string[];
  skills?: SkillsConfig;
  /** MCP servers to connect at startup. */
  mcp?: McpServerConfig[];
  budget?: BudgetConfig;
  /** Least-privilege policy rules (allow/deny/ask per tool call + args). */
  policy?: PolicyConfig;
  /** Sandbox enforcement for fs/shell tools (path jail + command guard). */
  sandbox?: import('../sandbox.js').SandboxConfig;
  /**
   * Models offered in the web UI's model picker. Defaults to
   * [deepseek-chat, deepseek-reasoner] with the configured model guaranteed
   * to be included.
   */
  models?: string[];
}

export const DEFAULT_SKILLS: SkillsConfig = {
  dirs: [],
  autoSelect: true,
  maxSelected: 2,
  threshold: 1,
};

const DEFAULTS: Partial<HarnessConfig> = {
  tools: ['fs', 'shell', 'web'],
  skills: DEFAULT_SKILLS,
  mcp: [],
  budget: {},
};

export const DEFAULT_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

export function normalizeConfig(cfg: HarnessConfig): Required<HarnessConfig> {
  const models = [...(cfg.models ?? DEFAULT_MODELS)];
  const current = cfg.provider.model;
  if (current && !models.includes(current)) models.unshift(current);
  const merged = {
    provider: cfg.provider,
    system: cfg.system ?? '',
    tools: cfg.tools ?? DEFAULTS.tools!,
    skills: { ...DEFAULT_SKILLS, ...cfg.skills },
    mcp: cfg.mcp ?? [],
    budget: cfg.budget ?? {},
    models,
  };
  if (!merged.provider?.model) {
    throw new Error('config.provider.model is required');
  }
  return merged as Required<HarnessConfig>;
}

/** Load and normalize a config JSON file. */
export async function loadConfigFile(path: string): Promise<HarnessConfig> {
  const raw = await fs.readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config file "${path}" is not valid JSON: ${(err as Error).message}`);
  }
  return parsed as HarnessConfig;
}
