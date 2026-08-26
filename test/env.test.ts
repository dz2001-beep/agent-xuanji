/**
 * .env loader tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDotEnv } from '../src/env.js';

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  saved.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
});

describe('loadDotEnv', () => {
  it('loads KEY=VALUE pairs, skips comments and blanks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-dotenv-'));
    await fs.writeFile(
      path.join(dir, '.env'),
      ['# comment', '', 'DEEPSEEK_API_KEY=sk-from-dotenv', 'MODEL_NAME="deepseek-chat"', ''].join('\n'),
    );
    try {
      loadDotEnv('.env', dir);
      expect(process.env.DEEPSEEK_API_KEY).toBe('sk-from-dotenv');
      expect(process.env.MODEL_NAME).toBe('deepseek-chat');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.MODEL_NAME;
    }
  });

  it('does not override an existing non-empty environment variable', () => {
    const dir = os.tmpdir();
    process.env.HARNESS_KIT_DOTENV_TEST = 'from-env';
    loadDotEnvFrom(dir, 'HARNESS_KIT_DOTENV_TEST=from-file');
    expect(process.env.HARNESS_KIT_DOTENV_TEST).toBe('from-env');
    delete process.env.HARNESS_KIT_DOTENV_TEST;
  });

  it('overrides an empty-string environment variable (treated as unset)', () => {
    const dir = os.tmpdir();
    process.env.HARNESS_KIT_DOTENV_TEST = '';
    loadDotEnvFrom(dir, 'HARNESS_KIT_DOTENV_TEST=from-file');
    expect(process.env.HARNESS_KIT_DOTENV_TEST).toBe('from-file');
    delete process.env.HARNESS_KIT_DOTENV_TEST;
  });

  it('is a no-op when the file does not exist', () => {
    expect(() => loadDotEnv('.env', '/definitely/not/here')).not.toThrow();
  });
});

function loadDotEnvFrom(dir: string, content: string): void {
  const file = path.join(dir, `harness-dotenv-${Date.now()}.env`);
  writeFileSync(file, content);
  loadDotEnv(path.basename(file), dir);
}
