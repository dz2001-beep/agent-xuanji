/**
 * Skill model + rendering.
 *
 * A Skill is a reusable, task-specific instruction pack (the SKILL.md
 * convention popularized by agent ecosystems, and the same concept DeepSeek
 * Harness exposes). Skills are injected into the system prompt when relevant.
 */

export interface Skill {
  /** Unique skill name (from frontmatter). */
  name: string;
  /** One-paragraph description used for relevance matching. */
  description: string;
  /** Absolute path of the SKILL.md file. */
  path: string;
  /** Absolute path of the skill directory. */
  dir: string;
  /** The instructions body (everything after frontmatter). */
  instructions: string;
  /** Relative paths of additional files shipped with the skill. */
  resources: string[];
  /** Extra frontmatter fields, preserved for tooling/extensions. */
  metadata: Record<string, unknown>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render skills as an injectable system-prompt block. */
export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const blocks = skills.map(
    (s) =>
      `<skill name="${escapeHtml(s.name)}" description="${escapeHtml(s.description)}">\n${s.instructions}\n</skill>`,
  );
  return `\n\n# 可用技能（skills）\n以下技能与当前任务相关，请严格遵循其指令：\n${blocks.join('\n\n')}\n`;
}

/** One-line summary for CLI listings. */
export function summarizeSkill(s: Skill): string {
  const desc = s.description.replace(/\s+/g, ' ').trim();
  return `${s.name.padEnd(22)} ${desc}`;
}
