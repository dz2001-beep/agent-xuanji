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
import { Tool, ToolContext, ToolResult, toolError, toolResult } from './tool.js';
import { checkCommandAllowed, resolveAllowedPath } from '../sandbox.js';

export type BuiltinGroup = 'fs' | 'shell' | 'web';

export const BUILTIN_GROUPS: BuiltinGroup[] = ['fs', 'shell', 'web'];

export function isBuiltinGroup(v: string): v is BuiltinGroup {
  return (BUILTIN_GROUPS as string[]).includes(v);
}

const MAX_OUTPUT = 20_000;

/** Resolve a tool-given path; sandbox-enforced when enabled. */
function resolvePath(p: string, ctx: ToolContext): string {
  if (ctx.sandbox?.enabled) {
    return resolveAllowedPath(p, ctx.cwd ?? process.cwd(), ctx.sandbox);
  }
  if (path.isAbsolute(p)) return p;
  return ctx.cwd ? path.resolve(ctx.cwd, p) : path.resolve(p);
}


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
    async execute(input, ctx) {
      const { path: p } = input as { path: string };
      try {
        const content = await fs.readFile(resolvePath(p, ctx), 'utf8');
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
    async execute(input, ctx) {
      const { path: p, content } = input as { path: string; content: string };
      const resolved = resolvePath(p, ctx);
      try {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, 'utf8');
        return toolResult({ written: content.length, path: resolved });
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
      properties: { path: { type: 'string', description: 'Directory path (default: cwd)' } },
      required: [],
    },
    async execute(input, ctx) {
      const { path: p = '.' } = (input ?? {}) as { path?: string };
      try {
        const entries = await fs.readdir(resolvePath(p, ctx), { withFileTypes: true });
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

function runShell(input: ShellInput, ctx: ToolContext): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    // 沙箱：命令拦截 + cwd 边界
    if (ctx.sandbox?.enabled) {
      try {
        checkCommandAllowed(input.command, ctx.sandbox);
        if (input.cwd) resolveAllowedPath(input.cwd, ctx.cwd ?? process.cwd(), ctx.sandbox);
      } catch (err) {
        resolve(toolError((err as Error).message));
        return;
      }
    }
    const timeoutMs = Math.min(input.timeoutMs ?? 30_000, 60_000);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(input.command, {
      cwd: input.cwd ?? ctx.cwd,
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
    'Run a shell command (uses the system shell). Returns {exitCode, stdout, stderr}. Default timeout 30s, max 60s. Use for building, testing, git, and any CLI task. Runs in the session working directory unless cwd is given.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command line to execute' },
      cwd: { type: 'string', description: 'Working directory (default: session cwd)' },
      timeoutMs: { type: 'integer', description: 'Timeout in ms (default 30000, max 60000)' },
    },
    required: ['command'],
  },
  execute: (input, ctx) => runShell(input as ShellInput, ctx),
};

/* ------------------------------------------------------------------ */
/* web tools                                                           */
/* ------------------------------------------------------------------ */

export interface BingResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parse Bing search-result HTML (cn.bing.com, reachable in CN networks
 * without an API key). Extracts `b_algo` blocks: title, link, snippet.
 * Deliberately regex-based (no HTML parser dependency) — best effort.
 */
export function parseBingResults(html: string, max = 8): BingResult[] {
  const out: BingResult[] = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  for (const block of blocks) {
    const h2 = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/);
    const url = h2?.[1];
    const title = stripTags(h2?.[2] ?? '');
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = stripTags(p?.[1] ?? '');
    if (title && url && url.startsWith('http')) {
      out.push({ title, url, snippet });
      if (out.length >= max) break;
    }
  }
  return out;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const BING_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function runBingSearch(query: string, maxResults: number, lang: string): Promise<ToolResult> {
  const target = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=${lang}`;
  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': BING_UA, 'Accept-Language': lang === 'en-US' ? 'en-US,en' : 'zh-CN,zh' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return toolError(`web.search 请求失败: HTTP ${res.status}`);
    const html = await res.text();
    const results = parseBingResults(html, maxResults);
    if (results.length === 0) return toolResult({ query, results: [], note: '未找到结果（页面结构或网络受限）' });
    return toolResult({ query, results });
  } catch (err) {
    return toolError(`web.search 失败（网络不可达？）: ${(err as Error).message}`);
  }
}

const webSearchTool: Tool = {
  name: 'web.search',
  description:
    '搜索互联网（基于必应中文搜索，无需 API Key）。返回前 N 条结果的标题、链接与摘要。适合查询新闻、事实、文档、最新信息。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（中文或英文）' },
      maxResults: { type: 'integer', description: '返回结果条数（默认 5，最大 10）' },
      lang: { type: 'string', enum: ['zh-CN', 'en-US'], description: '搜索语言区域（默认 zh-CN）' },
    },
    required: ['query'],
  },
  execute: async (input) => {
    const { query, maxResults = 5, lang = 'zh-CN' } = (input ?? {}) as {
      query: string;
      maxResults?: number;
      lang?: string;
    };
    return runBingSearch(query, Math.min(Math.max(maxResults, 1), 10), lang);
  },
};

/* ------------------------------------------------------------------ */

export function registerBuiltinTools(registry: { register(tool: Tool): void }, groups: string[]): void {
  const enabled = new Set(groups);
  if (enabled.has('fs')) for (const t of fsTools) registry.register(t);
  if (enabled.has('shell')) registry.register(shellTool);
  if (enabled.has('web')) registry.register(webSearchTool);
}
