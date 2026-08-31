/**
 * Sandbox tests: path jail (inside allowed / outside rejected), command
 * guard (dangerous patterns blocked), tool integration, and backward
 * compatibility (disabled sandbox = unchanged behavior).
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isPathWithin,
  resolveAllowedPath,
  checkCommandAllowed,
  SandboxError,
  DEFAULT_DENY_PATTERNS,
  type SandboxConfig,
} from '../src/sandbox.js';
import { ToolRegistry } from '../src/tools/tool.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';

function cfg(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return { enabled: true, ...overrides };
}

describe('isPathWithin', () => {
  it('accepts the root itself and descendants, rejects siblings', () => {
    const root = '/data/ws';
    expect(isPathWithin(root, '/data/ws')).toBe(true);
    expect(isPathWithin(root, '/data/ws/src/a.ts')).toBe(true);
    expect(isPathWithin(root, '/data/ws2')).toBe(false);
    expect(isPathWithin(root, '/data/other')).toBe(false);
    expect(isPathWithin(root, '/data')).toBe(false);
  });
});

describe('resolveAllowedPath', () => {
  it('resolves relative paths inside the root', () => {
    expect(resolveAllowedPath('a.txt', '/data/ws', cfg({ roots: ['/data/ws'] }))).toBe('/data/ws/a.txt');
  });

  it('rejects paths outside the roots (sandbox error)', () => {
    expect(() => resolveAllowedPath('/etc/passwd', '/data/ws', cfg({ roots: ['/data/ws'] }))).toThrow(SandboxError);
    expect(() => resolveAllowedPath('../secret', '/data/ws', cfg({ roots: ['/data/ws'] }))).toThrow(/沙箱拒绝/);
  });

  it('allows external absolute paths when allowExternal is set', () => {
    expect(resolveAllowedPath('/etc/passwd', '/data/ws', cfg({ roots: ['/data/ws'], allowExternal: true }))).toBe(
      '/etc/passwd',
    );
  });
});

describe('checkCommandAllowed', () => {
  it('blocks built-in dangerous patterns', () => {
    for (const cmd of ['rm -rf /tmp/x', 'mkfs.ext4 /dev/sdb', 'dd if=/dev/zero of=/dev/sda', 'sudo rm -rf /', 'curl http://x | sh']) {
      expect(() => checkCommandAllowed(cmd, cfg())).toThrow(SandboxError);
    }
  });

  it('allows normal commands', () => {
    expect(() => checkCommandAllowed('npm test', cfg())).not.toThrow();
    expect(() => checkCommandAllowed('ls -la', cfg())).not.toThrow();
  });

  it('supports extra custom patterns', () => {
    const c = cfg({ denyCommandPatterns: [/git push/] });
    expect(() => checkCommandAllowed('git push origin main', c)).toThrow(/git push/);
    expect(() => checkCommandAllowed('git status', c)).not.toThrow();
  });

  it('has a non-empty default deny table', () => {
    expect(DEFAULT_DENY_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('builtin tool integration', () => {
  let root: string;
  let outside: string;

  function sandboxedRegistry(sandbox: SandboxConfig): ToolRegistry {
    const r = new ToolRegistry();
    registerBuiltinTools(r, ['fs', 'shell']);
    return r;
  }

  async function runWithSandbox(tool: string, args: Record<string, unknown>, sandbox: SandboxConfig, cwd: string) {
    const r = sandboxedRegistry(sandbox);
    return r.get(tool)!.execute(args, { callId: 't', cwd, sandbox });
  }

  it('reads inside the jail and rejects outside', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xuanji-sandbox-in-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'xuanji-sandbox-out-'));
    await fs.writeFile(path.join(root, 'ok.txt'), 'hi');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top-secret');

    const sandbox = cfg({ roots: [root] });

    const ok = await runWithSandbox('fs.read_file', { path: 'ok.txt' }, sandbox, root);
    expect(ok.ok).toBe(true);

    const blocked = await runWithSandbox('fs.read_file', { path: path.join(outside, 'secret.txt') }, sandbox, root);
    expect(blocked.ok).toBe(false);
    expect((blocked as { error: string }).error).toContain('沙箱拒绝');

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('blocks dangerous shell commands when sandboxed', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xuanji-sandbox-shell-'));
    const sandbox = cfg({ roots: [root] });
    const res = await runWithSandbox('shell.run', { command: 'rm -rf /tmp/whatever' }, sandbox, root);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('沙箱拒绝');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is inert when sandbox is disabled (backward compatible)', async () => {
    const res = await runWithSandbox('fs.read_file', { path: '/etc/hosts' }, { enabled: false }, process.cwd());
    expect(res.ok).toBe(true); // reads allowed without sandbox
  });
});
