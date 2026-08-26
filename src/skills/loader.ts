/**
 * SkillLoader — discover skills on disk.
 *
 * Convention: a directory is a skill iff it contains a `SKILL.md`. Loading a
 * root directory walks it recursively, collecting every skill directory.
 * Additional files inside a skill directory are listed as `resources`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseSkillFile } from './frontmatter.js';
import type { Skill } from './skill.js';

export const SKILL_FILE = 'SKILL.md';

/** Load every skill under `dir` (recursive). Never throws on individual bad skills. */
export async function loadSkills(dir: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  await walk(dir, dir, skills);
  return skills;
}

async function walk(root: string, current: string, out: Skill[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (err) {
    console.warn(`[xuanji] cannot read skill directory ${current}: ${(err as Error).message}`);
    return;
  }

  const skillFile = entries.find((e) => e.isFile() && e.name === SKILL_FILE);
  if (skillFile) {
    const skill = await readSkill(root, current);
    if (skill) out.push(skill);
    return; // a skill's subdirectory is its own concern — don't nest-scan
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('node_modules')) continue;
    await walk(root, path.join(current, entry.name), out);
  }
}

async function readSkill(root: string, skillDir: string): Promise<Skill | null> {
  const file = path.join(skillDir, SKILL_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const { meta, body } = parseSkillFile(raw, file);
    const resources = await listResources(skillDir);
    return {
      name: meta.name,
      description: meta.description,
      path: file,
      dir: skillDir,
      instructions: body,
      resources,
      metadata: meta,
    };
  } catch (err) {
    console.warn(`[xuanji] skipping broken skill at ${file}: ${(err as Error).message}`);
    return null;
  }
}

/** List resource files (relative to skill dir), excluding SKILL.md itself. */
async function listResources(skillDir: string): Promise<string[]> {
  const walkDir = async (dir: string, prefix: string): Promise<string[]> => {
    const out: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === SKILL_FILE || e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await walkDir(path.join(dir, e.name), rel)));
      else out.push(rel);
    }
    return out;
  };
  return walkDir(skillDir, '').catch(() => []);
}
