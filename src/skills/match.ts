/**
 * Keyword relevance matching for skill selection.
 *
 * Query and skill text are tokenized into:
 *  - ASCII word tokens (`code`, `review`);
 *  - CJK character bigrams (`审阅代码` → `审阅`, `阅代`, `代码`).
 *
 * Score = 4 × name-token hits + 1 × description-token hits (+10 exact-name
 * bonus). This is a deliberately dependency-free, explainable matcher: good
 * enough for selection in a small skill library, and swappable for an
 * embedding-based retriever via the same `match` API.
 */

import type { Skill } from './skill.js';

export function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  // ASCII words (hyphens split: "commit-message" → commit, message)
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) tokens.add(word);
  }
  // CJK runs → character bigrams ("审阅代码" → 审阅, 阅代, 代码)
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.add(run.slice(i, i + 2));
      }
    }
  }
  return [...tokens];
}

export interface SkillMatch {
  skill: Skill;
  score: number;
}

export function scoreSkill(query: string, skill: Pick<Skill, 'name' | 'description'>): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const nameTokens = new Set(tokenize(skill.name));
  const descTokens = new Set(tokenize(skill.description));

  let score = 0;
  for (const q of queryTokens) {
    if (nameTokens.has(q)) score += 4;
    else if (descTokens.has(q)) score += 1;
  }
  if (skill.name.toLowerCase() === query.trim().toLowerCase()) score += 10;
  return score;
}

export function rankSkills(query: string, skills: Skill[]): SkillMatch[] {
  return skills
    .map((skill) => ({ skill, score: scoreSkill(query, skill) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
}
