/**
 * SkillRegistry — holds the loaded skill library and answers selection queries.
 */

import { loadSkills } from './loader.js';
import { rankSkills, type SkillMatch } from './match.js';
import type { Skill } from './skill.js';

export interface SkillSelectOptions {
  /** Max number of skills to return. */
  top?: number;
  /** Minimum relevance score. */
  threshold?: number;
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  /** Load a directory (recursive) and add its skills. Returns count added. */
  async loadDir(dir: string): Promise<number> {
    const found = await loadSkills(dir);
    let added = 0;
    for (const skill of found) {
      if (this.skills.has(skill.name)) {
        console.warn(`[harness-kit] skill "${skill.name}" already registered — keeping existing`);
        continue;
      }
      this.skills.set(skill.name, skill);
      added++;
    }
    return added;
  }

  add(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get size(): number {
    return this.skills.size;
  }

  /** Relevance-ranked skills for a query (empty when nothing clears the threshold). */
  match(query: string, opts: SkillSelectOptions = {}): SkillMatch[] {
    const { top = 5, threshold = 1 } = opts;
    return rankSkills(query, this.list()).filter((m) => m.score >= threshold).slice(0, top);
  }

  /** Convenience: the skills to inject for a user request. */
  select(query: string, opts: SkillSelectOptions = {}): Skill[] {
    return this.match(query, opts).map((m) => m.skill);
  }
}
