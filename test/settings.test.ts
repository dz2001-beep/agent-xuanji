/**
 * Settings tests: persistence round-trip (isolated XUANJI_HOME), masking,
 * vendor guessing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings, maskKey, guessVendor, findVendor, VENDOR_PRESETS } from '../src/settings.js';

let savedHome: string | undefined;
let home: string;

beforeAll(async () => {
  savedHome = process.env.XUANJI_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'xuanji-settings-'));
  process.env.XUANJI_HOME = home;
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.XUANJI_HOME;
  else process.env.XUANJI_HOME = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe('settings persistence', () => {
  it('round-trips through ~/.xuanji/settings.json', async () => {
    expect(await loadSettings()).toBeNull();
    await saveSettings({ vendor: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat' });
    const loaded = await loadSettings();
    expect(loaded?.vendor).toBe('deepseek');
    expect(loaded?.model).toBe('deepseek-chat');
    expect(loaded?.apiKey).toBe('sk-test');
  });
});

describe('maskKey / guessVendor', () => {
  it('masks keys', () => {
    expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-abc…mnop');
    expect(maskKey('')).toBe('');
    expect(maskKey('short')).toBe('***');
  });

  it('guesses vendors from baseURL', () => {
    expect(guessVendor('https://api.deepseek.com')).toBe('deepseek');
    expect(guessVendor('https://api.openai.com/v1')).toBe('openai');
    expect(guessVendor('https://api.moonshot.cn/v1')).toBe('moonshot');
    expect(guessVendor('http://localhost:11434/v1')).toBe('ollama');
    expect(guessVendor('https://my.internal.proxy/v1')).toBe('custom');
  });

  it('has presets for every major vendor', () => {
    const ids = VENDOR_PRESETS.map((v) => v.id);
    for (const id of ['deepseek', 'openai', 'moonshot', 'ollama', 'custom']) {
      expect(ids).toContain(id);
      expect(findVendor(id)).toBeDefined();
    }
  });
});
