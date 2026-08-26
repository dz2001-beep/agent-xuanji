/**
 * Diagnostics for `harness-kit doctor` — answers the "why doesn't the model
 * call work?" question in one command:
 *   1. where the API key comes from (and whether it looks valid);
 *   2. whether a minimal model call succeeds (key valid? model name valid?
 *      network reachable?) — errors surface the raw API message;
 *   3. whether every registered tool name survives the wire-name pattern
 *      (the 400 trap: dots are not allowed in OpenAI-compatible tool names).
 */

import { OpenAICompatibleProvider } from './llm/openai.js';
import { toWireToolName } from './llm/openai.js';
import type { HarnessConfig } from './harness/config.js';

export interface KeyInfo {
  found: boolean;
  source: string;
  masked: string;
}

/** Mask a key for display: sk-a1b2…wxyz. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function detectKey(config: HarnessConfig): KeyInfo {
  const envOpenAI = process.env.OPENAI_API_KEY?.trim();
  const envDeepSeek = process.env.DEEPSEEK_API_KEY?.trim();
  const cfgKey = config.provider.apiKey?.trim();
  if (envOpenAI) return { found: true, source: '环境变量 OPENAI_API_KEY', masked: maskKey(envOpenAI) };
  if (envDeepSeek) return { found: true, source: '环境变量 DEEPSEEK_API_KEY', masked: maskKey(envDeepSeek) };
  if (cfgKey) return { found: true, source: '配置文件 provider.apiKey', masked: maskKey(cfgKey) };
  return { found: false, source: '未找到（.env / 环境变量 / 配置均无）', masked: '' };
}

export interface ModelCallResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Fire a minimal chat completion to verify key + model + network. */
export async function testModelCall(opts: {
  model: string;
  apiKey: string;
  baseURL?: string;
  maxRetries?: number;
}): Promise<ModelCallResult> {
  const provider = new OpenAICompatibleProvider({
    model: opts.model,
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: opts.maxRetries ?? 0,
  });
  const started = Date.now();
  try {
    await provider.chat({
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      maxTokens: 4,
    });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

/** Tool wire-name audit: every name must match ^[a-zA-Z0-9_-]+$ on the wire. */
export function auditToolWireNames(toolNames: string[]): { ok: boolean; invalid: string[] } {
  const pattern = /^[a-zA-Z0-9_-]+$/;
  const invalid: string[] = [];
  for (const name of toolNames) {
    if (!pattern.test(toWireToolName(name))) invalid.push(name);
  }
  return { ok: invalid.length === 0, invalid };
}

/** Decide the effective baseURL the same way Harness.buildProvider does. */
export function resolveBaseURL(config: HarnessConfig): string | undefined {
  if (config.provider.baseURL) return config.provider.baseURL;
  const openAIKey = process.env.OPENAI_API_KEY?.trim();
  const deepSeekKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!openAIKey && deepSeekKey) return 'https://api.deepseek.com';
  return undefined;
}
