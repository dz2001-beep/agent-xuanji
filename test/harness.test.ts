/**
 * Harness composition tests: config loading, provider resolution, skill
 * auto-injection, and the one-call `Harness.run()` path (mock provider).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness/harness.js';
import { loadConfigFile, normalizeConfig } from '../src/harness/config.js';
import { MockProvider } from '../src/llm/mock.js';

describe('config', () => {
  it('normalizes defaults', () => {
    const cfg = normalizeConfig({ provider: { type: 'mock', model: 'm' } });
    expect(cfg.tools).toEqual(['fs', 'shell']);
    expect(cfg.skills.autoSelect).toBe(true);
    expect(cfg.skills.maxSelected).toBe(2);
    expect(cfg.mcp).toEqual([]);
  });

  it('requires a provider model', () => {
    expect(() => normalizeConfig({ provider: { type: 'mock', model: '' } })).toThrow(/model/);
  });

  it('loads a JSON config file', async () => {
    const file = path.join(os.tmpdir(), `harness-kit-config-${Date.now()}.json`);
    await fs.writeFile(file, JSON.stringify({ provider: { type: 'mock', model: 'm' }, tools: ['fs'] }));
    try {
      const cfg = await loadConfigFile(file);
      expect(cfg.provider.model).toBe('m');
      expect(cfg.tools).toEqual(['fs']);
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});

describe('Harness', () => {
  let skillsDir: string;
  beforeAll(async () => {
    skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-kit-harness-'));
    const dir = path.join(skillsDir, 'code-review');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: code-review\ndescription: 审阅代码，定位 bug 与安全问题。\n---\nReview carefully.',
    );
  });
  afterAll(async () => {
    await fs.rm(skillsDir, { recursive: true, force: true });
  });

  it('registers built-ins and skills from config', async () => {
    const harness = await Harness.create({
      config: {
        provider: { type: 'mock', model: 'm' },
        tools: ['fs'],
        skills: { dirs: [skillsDir] },
      },
    });
    try {
      expect(harness.tools.names().sort()).toEqual(['fs.list_dir', 'fs.read_file', 'fs.write_file']);
      expect(harness.skills.size).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it('auto-injects the relevant skill into the system prompt', async () => {
    const harness = await Harness.create({
      config: { provider: { type: 'mock', model: 'm' }, skills: { dirs: [skillsDir] } },
    });
    try {
      const res = await harness.run('帮我 review 一下代码');
      expect(res.status).toBe('ok');
      const systemMsg = res.messages.find((m) => m.role === 'system')!;
      expect(systemMsg.content).toContain('<skill name="code-review"');
    } finally {
      await harness.dispose();
    }
  });

  it('does not inject skills when autoSelect is disabled', async () => {
    const harness = await Harness.create({
      config: {
        provider: { type: 'mock', model: 'm' },
        skills: { dirs: [skillsDir], autoSelect: false },
      },
    });
    try {
      const res = await harness.run('帮我 review 一下代码');
      expect(res.messages.find((m) => m.role === 'system')!.content).not.toContain('<skill');
    } finally {
      await harness.dispose();
    }
  });

  it('accepts a custom injected provider', async () => {
    const calls: string[] = [];
    const provider = new MockProvider({
      turns: [{ content: 'custom!' }],
    });
    const harness = await Harness.create({
      config: { provider: { type: 'openai', model: 'ignored' } },
      provider,
    });
    try {
      const res = await harness.run('hello');
      expect(res.output).toBe('custom!');
      expect(harness.provider.name).toBe('mock');
      void calls;
    } finally {
      await harness.dispose();
    }
  });

  it('throws a helpful error when no API key is available', async () => {
    const savedOpenAI = process.env.OPENAI_API_KEY;
    const savedDeepSeek = process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      await expect(
        Harness.create({ config: { provider: { type: 'openai', model: 'm' } } }),
      ).rejects.toThrow(/API key/);
    } finally {
      if (savedOpenAI) process.env.OPENAI_API_KEY = savedOpenAI;
      if (savedDeepSeek) process.env.DEEPSEEK_API_KEY = savedDeepSeek;
    }
  });
});
