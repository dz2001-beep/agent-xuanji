/**
 * App settings — API key / vendor / model configuration for the settings page.
 *
 * Persisted to <XUANJI_HOME | ~>/.xuanji/settings.json (local tooling; the
 * key is stored in plaintext on the user's own machine — documented).
 * Vendor presets make it trivial to target any OpenAI-compatible provider.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface VendorPreset {
  id: string;
  name: string;
  baseURL: string;
  defaultModel: string;
  /** Whether this vendor requires an API key (Ollama does not). */
  needsKey: boolean;
  description: string;
}

export const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    needsKey: true,
    description: '国产，性价比高，OpenAI 兼容',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
    description: '官方 API',
  },
  {
    id: 'moonshot',
    name: 'Moonshot（月之暗面 Kimi）',
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    needsKey: true,
    description: 'Kimi 大模型，OpenAI 兼容',
  },
  {
    id: 'ollama',
    name: 'Ollama（本地模型）',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    needsKey: false,
    description: '本地部署，无需 API Key',
  },
  {
    id: 'custom',
    name: '自定义（任意 OpenAI 兼容端点）',
    baseURL: '',
    defaultModel: '',
    needsKey: true,
    description: 'vLLM / 代理 / 内网模型服务等',
  },
];

export interface AppSettings {
  vendor: string;
  baseURL?: string;
  apiKey?: string;
  model: string;
  /** Extra models offered in the UI model picker. */
  models?: string[];
}

function settingsFile(): string {
  return path.join(process.env.XUANJI_HOME ?? os.homedir(), '.xuanji', 'settings.json');
}

export async function loadSettings(): Promise<AppSettings | null> {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    return JSON.parse(raw) as AppSettings;
  } catch {
    return null;
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const file = settingsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2), 'utf8');
}

/** Mask a key for display: sk-a1b2…wxyz. */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function findVendor(id: string): VendorPreset | undefined {
  return VENDOR_PRESETS.find((v) => v.id === id);
}

/** Guess a vendor id from a baseURL (used when no saved settings exist). */
export function guessVendor(baseURL: string): string {
  if (baseURL.includes('deepseek')) return 'deepseek';
  if (baseURL.includes('openai')) return 'openai';
  if (baseURL.includes('moonshot')) return 'moonshot';
  if (baseURL.includes('11434')) return 'ollama';
  return 'custom';
}
