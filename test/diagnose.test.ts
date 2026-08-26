/**
 * diagnose tests: key detection, masking, wire-name audit.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { auditToolWireNames, detectKey, maskKey, resolveBaseURL } from '../src/diagnose.js';
import type { HarnessConfig } from '../src/harness/config.js';

const cfg = (partial: Partial<HarnessConfig>): HarnessConfig =>
  ({ provider: { type: 'openai', model: 'm' }, ...partial }) as HarnessConfig;

describe('maskKey', () => {
  it('masks long keys and short values', () => {
    expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-abc…mnop');
    expect(maskKey('short')).toBe('***');
  });
});

describe('detectKey', () => {
  const savedOpenAI = process.env.OPENAI_API_KEY;
  const savedDeepSeek = process.env.DEEPSEEK_API_KEY;

  afterEach(() => {
    if (savedOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAI;
    if (savedDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedDeepSeek;
  });

  it('prefers env over config, OpenAI over DeepSeek', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const info = detectKey(cfg({ provider: { type: 'openai', model: 'm', apiKey: 'sk-from-config' } }));
    expect(info.found).toBe(true);
    expect(info.source).toContain('配置文件');
  });

  it('finds env keys and masks them', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env-key-12345678';
    delete process.env.OPENAI_API_KEY;
    const info = detectKey(cfg({}));
    expect(info.found).toBe(true);
    expect(info.source).toContain('DEEPSEEK_API_KEY');
    expect(info.masked).not.toContain('12345678');
  });

  it('treats empty-string env keys as missing', () => {
    process.env.DEEPSEEK_API_KEY = '';
    process.env.OPENAI_API_KEY = '';
    const info = detectKey(cfg({}));
    expect(info.found).toBe(false);
  });
});

describe('auditToolWireNames', () => {
  it('passes namespaced names after encoding', () => {
    const res = auditToolWireNames(['fs.read_file', 'shell.run', 'weather.current', 'my_tool']);
    expect(res.ok).toBe(true);
    expect(res.invalid).toEqual([]);
  });
});

describe('resolveBaseURL', () => {
  it('defaults to DeepSeek when only DEEPSEEK_API_KEY is set', () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-x';
    try {
      expect(resolveBaseURL(cfg({}))).toBe('https://api.deepseek.com');
      expect(resolveBaseURL(cfg({ provider: { type: 'openai', model: 'm', baseURL: 'https://x.example' } }))).toBe(
        'https://x.example',
      );
    } finally {
      if (saved) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
    }
  });
});
