/**
 * Harness configuration: one JSON file that wires everything together —
 * provider, built-in tool groups, skill directories, MCP servers, and
 * loop budgets.
 */

import { promises as fs } from 'node:fs';
import type { ProviderConfig } from '../llm/provider.js';
import type { McpServerConfig } from '../mcp/config.js';

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
}

export const DEFAULT_SKILLS: SkillsConfig = {
  dirs: [],
  autoSelect: true,
  maxSelected: 2,
  threshold: 1,
};

const DEFAULTS: Partial<HarnessConfig> = {
  tools: ['fs', 'shell'],
  skills: DEFAULT_SKILLS,
  mcp: [],
  budget: {},
};

export function normalizeConfig(cfg: HarnessConfig): Required<HarnessConfig> {
  const merged = {
    provider: cfg.provider,
    system: cfg.system ?? '',
    tools: cfg.tools ?? DEFAULTS.tools!,
    skills: { ...DEFAULT_SKILLS, ...cfg.skills },
    mcp: cfg.mcp ?? [],
    budget: cfg.budget ?? {},
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
