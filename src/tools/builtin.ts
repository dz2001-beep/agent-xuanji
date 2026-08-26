/**
 * Built-in tools that ship with the harness: filesystem access and a
 * (capped, timeout-guarded) shell.
 *
 * Security note: these are DEMO-grade tools. A production harness wraps
 * capabilities behind a permission/approval system (path allow-lists,
 * command denylists, human-in-the-loop approval). See docs/ARCHITECTURE.md
 * for the extension points.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Tool, ToolResult, toolError, toolResult } from './tool.js';

export type BuiltinGroup = 'fs' | 'shell';

export const BUILTIN_GROUPS: BuiltinGroup[] = ['fs', 'shell'];

export function isBuiltinGroup(v: string): v is BuiltinGroup {
  return (BUILTIN_GROUPS as string[]).includes(v);
}

const MAX_OUTPUT = 20_000;

/* ------------------------------------------------------------------ */
/* fs tools                                                            */
/* ------------------------------------------------------------------ */

const fsTools: Tool[] = [
  {
    name: 'fs.read_file',
    description: 'Read a UTF-8 text file. Returns the full content (truncated at 20k chars).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute or cwd-relative file path' } },
      required: ['path'],
    },
    async execute(input) {
      const { path: p } = input as { path: string };
      try {
        const content = await fs.readFile(p, 'utf8');
        return toolResult(content.length > MAX_OUTPUT ? content.slice(0, MAX_OUTPUT) : content);
      } catch (err) {
        return toolError(`fs.read_file failed: ${(err as Error).message}`);
      }
    },
  },
  {
    name: 'fs.write_file',
    description: 'Write a UTF-8 text file (creates parent directories). Overwrites existing content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or cwd-relative file path' },
        content: { type: 'string', description: 'Full text content to write' },
      },
      required: ['path', 'content'],
    },
    async execute(input) {
      const { path: p, content } = input as { path: string; content: string };
      try {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, content, 'utf8');
        return toolResult({ written: content.length, path: p });
      } catch (err) {
        return toolError(`fs.write_file failed: ${(err as Error).message}`);
      }
    },
  },
  {
    name: 'fs.list_dir',
    description: 'List entries of a directory. Returns [{name, type: "file"|"dir"|"other"}] sorted by name.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default ".")' } },
      required: [],
    },
    async execute(input) {
      const { path: p = '.' } = (input ?? {}) as { path?: string };
      try {
        const entries = await fs.readdir(p, { withFileTypes: true });
        const list = entries
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return toolResult(list);
      } catch (err) {
        return toolError(`fs.list_dir failed: ${(err as Error).message}`);
      }
    },
  },
];

/* ------------------------------------------------------------------ */
/* shell tool                                                          */
/* ------------------------------------------------------------------ */

interface ShellInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

function runShell(input: ShellInput): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const timeoutMs = Math.min(input.timeoutMs ?? 30_000, 60_000);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(toolError(`shell.run failed to start: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(toolError(`shell.run timed out after ${timeoutMs}ms (command killed)`));
        return;
      }
      resolve(
        toolResult({
          exitCode: code,
          stdout,
          stderr,
          timedOut: false,
        }),
      );
    });
  });
}

const shellTool: Tool = {
  name: 'shell.run',
  description:
    'Run a shell command (uses the system shell). Returns {exitCode, stdout, stderr}. Default timeout 30s, max 60s. Use for building, testing, git, and any CLI task.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command line to execute' },
      cwd: { type: 'string', description: 'Working directory (default: harness cwd)' },
      timeoutMs: { type: 'integer', description: 'Timeout in ms (default 30000, max 60000)' },
    },
    required: ['command'],
  },
  execute: (input) => runShell(input as ShellInput),
};

/* ------------------------------------------------------------------ */

export function registerBuiltinTools(registry: { register(tool: Tool): void }, groups: string[]): void {
  const enabled = new Set(groups);
  if (enabled.has('fs')) for (const t of fsTools) registry.register(t);
  if (enabled.has('shell')) registry.register(shellTool);
}
