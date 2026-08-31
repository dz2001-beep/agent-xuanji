/**
 * Sandbox — execution-environment isolation for agent tools.
 *
 * Two enforcement layers (both optional, opt-in via config):
 *
 *  1. PATH JAIL: fs tools resolve every path against the allowed roots
 *     (typically the workspace). Paths outside the roots are rejected with a
 *     SandboxError before any I/O happens.
 *  2. COMMAND GUARD: shell.run rejects commands matching dangerous patterns
 *     (defaults + configurable), and the shell cwd must stay inside the roots.
 *
 * This is a user-space sandbox (defense in depth alongside Policy approval
 * and trace auditing) — NOT an OS-level sandbox; production deployments
 * should additionally run agents in containers/VMs (see docs/SECURITY.md).
 */

import path from 'node:path';

export interface SandboxConfig {
  /** Master switch. When false the guard is inert (backward compatible). */
  enabled: boolean;
  /** Allowed directory roots. Default: [workspace cwd]. */
  roots?: string[];
  /** Allow absolute paths OUTSIDE the roots (default false). */
  allowExternal?: boolean;
  /** Extra dangerous-command regex patterns (merged with defaults). */
  denyCommandPatterns?: RegExp[];
}

/** Thrown when a sandbox rule is violated (tools surface it as a tool error). */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** Built-in dangerous shell command patterns (defense in depth). */
export const DEFAULT_DENY_PATTERNS = [
  /(^|[;&|]\s*)\s*rm\s+(-[a-z]*r[a-z]*\s+)?\//i, // rm -rf /…
  /\bmkfs/i, // mkfs / mkfs.ext4 … (filesystem creation)
  /\bdd\s+if=/, // dd if=… (disk writing)
  /:\(\)\s*\{/, // fork bomb
  /\bshutdown\b|\breboot\b|\bpoweroff\b/,
  /\bsudo\s+rm\b/,
  />\s*\/dev\/sd[a-z]/i, // raw block device writes
  /\bcurl\s+[^\s|;&]+\s*\|\s*(ba)?sh\b/i, // curl | sh
];

/** Normalize a path and check whether it lives inside `root` (or equals it). */
export function isPathWithin(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`);
}

/**
 * Resolve a tool-supplied path against the sandbox. Returns the absolute
 * path when allowed, otherwise throws SandboxError. Relative paths resolve
 * against `cwd` first.
 */
export function resolveAllowedPath(p: string, cwd: string, cfg: SandboxConfig): string {
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const roots = (cfg.roots && cfg.roots.length > 0 ? cfg.roots : [cwd]).map((r) => path.resolve(r));
  const inside = roots.some((r) => isPathWithin(r, resolved));
  if (inside) return resolved;
  if (cfg.allowExternal) return resolved;
  throw new SandboxError(
    `沙箱拒绝: 路径超出允许范围（roots: ${roots.join(', ')}）: ${resolved} — 如需访问请配置 allowExternal 或在策略中放行`,
  );
}

/** Validate a shell command line against dangerous patterns. Throws on match. */
export function checkCommandAllowed(command: string, cfg: SandboxConfig): void {
  const patterns = [...DEFAULT_DENY_PATTERNS, ...(cfg.denyCommandPatterns ?? [])];
  for (const re of patterns) {
    if (re.test(command)) {
      throw new SandboxError(`沙箱拒绝: 命令命中危险模式 ${re} — ${command.slice(0, 80)}`);
    }
  }
}
