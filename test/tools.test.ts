/**
 * Tool layer tests: registry, schema validation, built-ins (fs/shell).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, ToolError, type ToolResult } from '../src/tools/tool.js';
import { validateArgs } from '../src/tools/schema.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';

describe('ToolRegistry', () => {
  it('registers and looks up tools', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'a',
      description: 'a',
      inputSchema: { type: 'object' },
      async execute(): Promise<ToolResult> {
        return { ok: true, data: null };
      },
    });
    expect(r.has('a')).toBe(true);
    expect(r.names()).toEqual(['a']);
    expect(r.list()).toHaveLength(1);
  });

  it('throws on name collisions (fail fast)', () => {
    const r = new ToolRegistry();
    const tool = {
      name: 'dup',
      description: 'x',
      inputSchema: { type: 'object' },
      async execute(): Promise<ToolResult> {
        return { ok: true, data: null };
      },
    };
    r.register(tool);
    expect(() => r.register(tool)).toThrow(/collision/);
  });
});

describe('validateArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['name'],
  };

  it('accepts valid arguments', () => {
    expect(validateArgs(schema, { name: 'x', count: 2, tags: ['a'] })).toHaveLength(0);
  });

  it('flags missing required properties', () => {
    const issues = validateArgs(schema, { count: 1 });
    expect(issues.some((i) => i.path === 'name' && i.message.includes('missing'))).toBe(true);
  });

  it('flags wrong primitive types', () => {
    const issues = validateArgs(schema, { name: 42 });
    expect(issues.some((i) => i.message.includes('expected string'))).toBe(true);
  });

  it('flags wrong array item types', () => {
    const issues = validateArgs(schema, { name: 'x', tags: [1] });
    expect(issues.some((i) => i.path === 'tags[0]')).toBe(true);
  });

  it('rejects non-object arguments', () => {
    expect(validateArgs(schema, 'nope').length).toBeGreaterThan(0);
  });
});

describe('built-in tools', () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, ['fs', 'shell']);

  let tmp: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-kit-tools-'));
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('registers fs and shell groups', () => {
    expect(registry.names().sort()).toEqual(['fs.list_dir', 'fs.read_file', 'fs.write_file', 'shell.run']);
  });

  it('fs.write_file → fs.read_file round-trip', async () => {
    const p = path.join(tmp, 'hello.txt');
    const write = await registry.get('fs.write_file')!.execute({ path: p, content: 'hi' }, { callId: 't1' });
    expect(write.ok).toBe(true);

    const read = await registry.get('fs.read_file')!.execute({ path: p }, { callId: 't2' });
    expect(read.ok && read.data).toBe('hi');
  });

  it('fs.read_file on a missing file returns ok:false', async () => {
    const read = await registry.get('fs.read_file')!.execute({ path: path.join(tmp, 'nope.txt') }, { callId: 't3' });
    expect(read.ok).toBe(false);
  });

  it('fs.list_dir lists entries with types', async () => {
    const list = await registry.get('fs.list_dir')!.execute({ path: tmp }, { callId: 't4' });
    expect(list.ok).toBe(true);
    const entries = (list as { ok: true; data: Array<{ name: string; type: string }> }).data;
    expect(entries.some((e) => e.name === 'hello.txt' && e.type === 'file')).toBe(true);
  });

  it('shell.run captures stdout/stderr and exit code', async () => {
    const okRun = await registry.get('shell.run')!.execute(
      { command: 'echo out && echo err >&2 && exit 3' },
      { callId: 't5' },
    );
    expect(okRun.ok).toBe(true);
    const data = (okRun as { ok: true; data: { exitCode: number | null; stdout: string; stderr: string } }).data;
    expect(data.exitCode).toBe(3);
    expect(data.stdout.trim()).toBe('out');
    expect(data.stderr.trim()).toBe('err');
  });

  it('shell.run kills commands that exceed the timeout', async () => {
    const slowRun = await registry.get('shell.run')!.execute(
      { command: 'sleep 5', timeoutMs: 300 },
      { callId: 't6' },
    );
    expect(slowRun.ok).toBe(false);
    expect((slowRun as { ok: false; error: string }).error).toContain('timed out');
  });

  it('ToolError is an Error subclass', () => {
    const e = new ToolError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ToolError');
  });
});