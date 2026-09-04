/**
 * Docker sandbox tests:
 *  - buildDockerRunArgs: pure argv construction (mount, network none,
 *    capability drop, resource limits, image, command);
 *  - hasDocker: daemon probe;
 *  - integration: runs a real container when a daemon is available (skipped
 *    otherwise), and verifies the tool-level fail-closed path without docker.
 */

import { describe, expect, it } from 'vitest';
import { buildDockerRunArgs, hasDocker, runInDocker } from '../src/sandbox_docker.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { ToolRegistry } from '../src/tools/tool.js';
import type { SandboxConfig } from '../src/sandbox.js';

function dockerCfg(overrides: Partial<SandboxConfig['docker']> = {}): SandboxConfig {
  return {
    enabled: true,
    engine: 'docker',
    roots: ['/workspace'],
    docker: { image: 'node:22-bookworm-slim', ...overrides },
  };
}

describe('buildDockerRunArgs', () => {
  it('hardens the container and mounts the workspace', () => {
    const { args, name } = buildDockerRunArgs({
      workspace: '/data/ws',
      command: 'npm test',
      image: 'node:22-bookworm-slim',
      memory: '1g',
      cpus: '1',
      hostUid: 501,
      hostGid: 20,
    });
    expect(name).toMatch(/^xj_/);
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args.join(' ')).toContain('-v /data/ws:/workspace -w /workspace');
    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
    expect(args).toContain('--user');
    expect(args).toContain('501:20');
    expect(args).toContain('--memory');
    expect(args).toContain('1g');
    expect(args).toContain('--cpus');
    expect(args).toContain('1');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('--read-only');
    expect(args).toContain('--tmpfs');
    expect(args.includes('node:22-bookworm-slim')).toBe(true);
    expect(args.includes('/bin/sh')).toBe(true);
    expect(args.includes('npm test')).toBe(true);
  });

  it('allows network when configured and skips read-only', () => {
    const { args } = buildDockerRunArgs({
      workspace: '/w',
      command: 'curl -s example.com',
      image: 'img',
      network: true,
      readOnly: false,
    });
    expect(args).not.toContain('none');
    expect(args).not.toContain('--read-only');
  });
});

describe('hasDocker', () => {
  it('probes the daemon without throwing', async () => {
    const ok = await hasDocker();
    expect(typeof ok).toBe('boolean');
  });
});

const dockerOk = await hasDocker();

describe.skipIf(!dockerOk)('docker engine integration (daemon available)', () => {
  it('runs a command inside a throwaway container', async () => {
    const res = await runInDocker('echo "in-container"', { workspace: process.cwd(), timeoutMs: 60_000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('in-container');
  });

  it('reports a non-zero exit code for failing commands', async () => {
    const res = await runInDocker('exit 3', { workspace: process.cwd(), timeoutMs: 60_000 });
    expect(res.exitCode).toBe(3);
  });
});

describe('tool-level docker engine', () => {
  it('fails closed when no docker daemon is available', async () => {
    if (dockerOk) return; // daemon present → this path not applicable
    const r = new ToolRegistry();
    registerBuiltinTools(r, ['shell']);
    const res = await r.get('shell.run')!.execute(
      { command: 'echo hi' },
      { callId: 't', cwd: process.cwd(), sandbox: dockerCfg() },
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('Docker daemon 不可用');
  });

  it('still applies the command guard before docker (defense in depth)', async () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r, ['shell']);
    const res = await r.get('shell.run')!.execute(
      { command: 'rm -rf /tmp/x' },
      { callId: 't', cwd: process.cwd(), sandbox: dockerCfg() },
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('沙箱拒绝');
  });
});
