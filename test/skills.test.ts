/**
 * Skill system tests: frontmatter parsing, loading, matching, rendering.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillFile, SkillParseError } from '../src/skills/frontmatter.js';
import { loadSkills } from '../src/skills/loader.js';
import { rankSkills, scoreSkill, tokenize } from '../src/skills/match.js';
import { renderSkills, type Skill } from '../src/skills/skill.js';
import { SkillRegistry } from '../src/skills/registry.js';

describe('tokenize', () => {
  it('extracts words and CJK bigrams', () => {
    const tokens = tokenize('review 审阅代码 commit-message');
    expect(tokens).toContain('review');
    expect(tokens).toContain('commit');
    expect(tokens).toContain('message');
    expect(tokens).toContain('审阅');
    expect(tokens).toContain('阅代');
    expect(tokens).toContain('代码');
  });
});

describe('parseSkillFile', () => {
  it('parses frontmatter + body', () => {
    const raw = `---
name: demo
description: A demo skill
tags: [a, b]
---
Do the thing.

Step by step.
`;
    const { meta, body } = parseSkillFile(raw, 'SKILL.md');
    expect(meta.name).toBe('demo');
    expect(meta.description).toBe('A demo skill');
    expect(meta.tags).toEqual(['a', 'b']);
    expect(body).toContain('Do the thing');
  });

  it('throws on missing frontmatter', () => {
    expect(() => parseSkillFile('no frontmatter here', 'x/SKILL.md')).toThrow(SkillParseError);
  });

  it('throws on unterminated frontmatter', () => {
    expect(() => parseSkillFile('---\nname: x\n', 'x/SKILL.md')).toThrow(/unterminated/);
  });

  it('throws on invalid YAML', () => {
    expect(() => parseSkillFile('---\nname: [unclosed\n---\nbody', 'x/SKILL.md')).toThrow(/invalid YAML/);
  });

  it('throws when name/description are missing', () => {
    expect(() => parseSkillFile('---\ndescription: no name\n---\nbody', 'x/SKILL.md')).toThrow(/name/);
    expect(() => parseSkillFile('---\nname: no desc\n---\nbody', 'x/SKILL.md')).toThrow(/description/);
  });

  it('throws on empty body', () => {
    expect(() => parseSkillFile('---\nname: x\ndescription: y\n---\n   ', 'x/SKILL.md')).toThrow(/no instructions/);
  });
});

describe('loadSkills', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-kit-skills-'));
    // two valid skills
    await fs.mkdir(path.join(root, 'alpha'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: The alpha skill\n---\nDo alpha.',
    );
    await fs.writeFile(path.join(root, 'alpha', 'helper.txt'), 'helper content');
    await fs.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.mkdir(path.join(root, 'nested', 'beta'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'nested', 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: The beta skill\n---\nDo beta.',
    );
    // one broken skill (should be skipped, not fatal)
    await fs.mkdir(path.join(root, 'broken'), { recursive: true });
    await fs.writeFile(path.join(root, 'broken', 'SKILL.md'), 'not a skill file');
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('discovers skills recursively, skipping broken ones', async () => {
    const skills = await loadSkills(root);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('lists resources relative to the skill dir', async () => {
    const skills = await loadSkills(root);
    const alpha = skills.find((s) => s.name === 'alpha')!;
    expect(alpha.resources).toEqual(['helper.txt']);
  });
});

describe('matching', () => {
  const skill = (name: string, description: string): Skill => ({
    name,
    description,
    path: `/skills/${name}/SKILL.md`,
    dir: `/skills/${name}`,
    instructions: '...',
    resources: [],
    metadata: {},
  });

  const library = [
    skill('code-review', '审阅 TypeScript/JavaScript 代码，定位 bug、安全隐患、性能与风格问题，输出结构化评审意见。'),
    skill('commit-message', '根据代码变更生成遵循 Conventional Commits 规范的提交信息。'),
    skill('sqlite-query', '编写与优化 SQLite SQL 查询，解释执行计划。'),
  ];

  it('ranks the right skill first for English queries', () => {
    const ranked = rankSkills('write a commit message', library);
    expect(ranked[0]?.skill.name).toBe('commit-message');
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('ranks the right skill first for Chinese queries (bigram matching)', () => {
    const ranked = rankSkills('帮我审阅代码', library);
    expect(ranked[0]?.skill.name).toBe('code-review');
  });

  it('gives exact name matches a big bonus', () => {
    expect(scoreSkill('code-review', library[0]!)).toBeGreaterThan(10);
  });

  it('returns nothing for unrelated queries', () => {
    expect(rankSkills('what is the weather', library)).toHaveLength(0);
  });
});

describe('SkillRegistry', () => {
  it('selects with top/threshold limits', () => {
    const r = new SkillRegistry();
    r.add({
      name: 'a',
      description: 'alpha things and stuff',
      path: 'x',
      dir: 'x',
      instructions: 'i',
      resources: [],
      metadata: {},
    });
    r.add({
      name: 'b',
      description: 'beta things',
      path: 'x',
      dir: 'x',
      instructions: 'i',
      resources: [],
      metadata: {},
    });
    expect(r.get('a')?.name).toBe('a');
    expect(r.has('b')).toBe(true);
    expect(r.list()).toHaveLength(2);

    const selected = r.select('alpha', { top: 1 });
    expect(selected.map((s) => s.name)).toEqual(['a']);
  });
});

describe('renderSkills', () => {
  it('renders a system-prompt block containing skill names', () => {
    const s: Skill = {
      name: 'demo',
      description: 'demo desc',
      path: 'x',
      dir: 'x',
      instructions: 'Do demo things.',
      resources: [],
      metadata: {},
    };
    const out = renderSkills([s]);
    expect(out).toContain('<skill name="demo"');
    expect(out).toContain('Do demo things.');
  });

  it('returns empty string for no skills', () => {
    expect(renderSkills([])).toBe('');
  });
});
