/**
 * Least-privilege policy engine — parameter-level decisions on tool calls.
 *
 * A declarative rule list (JSON) decides, per tool call (tool name + its
 * arguments), whether the call is:
 *   - allow: run immediately;
 *   - deny:  rejected with a reason (no execution, error fed back to the model);
 *   - ask:   requires human approval before execution.
 *
 * Rule semantics: the FIRST matching rule wins (rules are ordered). Tool
 * names support trailing-`*` globs (`shell.*`, `*`); `when` constrains the
 * rule to argument values (equals or regex match). No match falls back to
 * `defaultAction` (default: allow).
 *
 * Example (xuanji.policy.json):
 *   { "rules": [
 *       { "tool": "shell.*", "when": { "command": { "matches": "rm -rf|git push" } }, "action": "deny", "reason": "危险命令" },
 *       { "tool": "shell.*", "action": "ask" },
 *       { "tool": "fs.write_file", "when": { "path": { "matches": "^\\.\\.?/" } }, "action": "allow" },
 *       { "tool": "fs.write_file", "action": "ask" }
 *   ] }
 */

export type PolicyDecision = 'allow' | 'deny' | 'ask';

export interface PolicyWhen {
  /** argument path (e.g. "command", "path") — value must equal this. */
  equals?: unknown;
  /** argument path — string value must match this regex. */
  matches?: string;
}

export interface PolicyRule {
  id?: string;
  /** Tool name, exact or trailing-* glob ("shell.*", "*"). */
  tool: string;
  action: PolicyDecision;
  /** All listed conditions must hold for the rule to apply. */
  when?: Record<string, PolicyWhen>;
  reason?: string;
}

export interface PolicyConfig {
  rules: PolicyRule[];
  /** Fallback when no rule matches (default: allow). */
  defaultAction?: PolicyDecision;
}

export interface PolicyDecisionResult {
  decision: PolicyDecision;
  /** The matching rule, when one applied. */
  rule?: PolicyRule;
  reason?: string;
}

function toolMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true;
  if (ruleTool.endsWith('*')) {
    return toolName.startsWith(ruleTool.slice(0, -1));
  }
  return false;
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function whenMatches(args: unknown, when: Record<string, PolicyWhen>): boolean {
  for (const [path, cond] of Object.entries(when)) {
    const value = getPath(args, path);
    if (cond.equals !== undefined) {
      if (value !== cond.equals) return false;
    }
    if (cond.matches !== undefined) {
      if (typeof value !== 'string' || !new RegExp(cond.matches).test(value)) return false;
    }
  }
  return true;
}

export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  decide(toolName: string, args: unknown): PolicyDecisionResult {
    for (const rule of this.config.rules) {
      if (!toolMatches(rule.tool, toolName)) continue;
      if (rule.when && !whenMatches(args, rule.when)) continue;
      return { decision: rule.action, rule, reason: rule.reason };
    }
    return { decision: this.config.defaultAction ?? 'allow' };
  }
}
