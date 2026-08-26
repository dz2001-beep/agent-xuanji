/**
 * SKILL.md frontmatter parsing.
 *
 * A skill is a directory containing a `SKILL.md` file:
 *
 *   ---
 *   name: code-review
 *   description: 审阅代码……
 *   ---
 *   （正文：使用该技能的完整指令）
 *
 * The frontmatter block is YAML between two `---` lines; the rest of the
 * file is the skill's instructions.
 */

import { load as loadYaml } from 'js-yaml';

export interface SkillMeta {
  name: string;
  description: string;
  [key: string]: unknown;
}

export class SkillParseError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'SkillParseError';
  }
}

/** Split a raw file into { meta, body }. Throws SkillParseError on malformed files. */
export function parseSkillFile(raw: string, file: string): { meta: SkillMeta; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new SkillParseError(file, 'SKILL.md must start with a "---" frontmatter block');
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new SkillParseError(file, 'unterminated frontmatter block (missing closing "---")');
  }

  const yamlText = lines.slice(1, end).join('\n');
  let parsed: unknown;
  try {
    parsed = loadYaml(yamlText) ?? {};
  } catch (err) {
    throw new SkillParseError(file, `invalid YAML frontmatter: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SkillParseError(file, 'frontmatter must be a YAML mapping');
  }
  const meta = parsed as Record<string, unknown>;

  if (typeof meta.name !== 'string' || !meta.name.trim()) {
    throw new SkillParseError(file, 'frontmatter requires a non-empty string "name"');
  }
  if (typeof meta.description !== 'string' || !meta.description.trim()) {
    throw new SkillParseError(file, 'frontmatter requires a non-empty string "description"');
  }

  const body = lines.slice(end + 1).join('\n').trim();
  if (!body) {
    throw new SkillParseError(file, 'SKILL.md has no instructions after the frontmatter');
  }

  return { meta: meta as SkillMeta, body };
}
