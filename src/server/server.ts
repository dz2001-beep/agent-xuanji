/**
 * UiServer — local HTTP server for the xuanji web client.
 *
 * Binds to 127.0.0.1 only (local tooling; no auth by design). Serves the
 * static web UI from `public/` and exposes a small JSON/SSE API:
 *
 *   GET  /api/health        liveness probe
 *   GET  /api/state         session state (cwd, tools, skills, running…)
 *   POST /api/chat          {message} → SSE stream of ChatFrames
 *   POST /api/abort         cancel the in-flight run
 *   POST /api/cwd           {path} switch session working directory
 *   GET  /api/dirs?path=…   list directories for the folder browser
 *   POST /api/clear         reset conversation history
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Harness } from '../harness/harness.js';
import { ChatSession } from './session.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

export type UiLogLevel = 'info' | 'warn' | 'error';
export type UiLogger = (level: UiLogLevel, message: string) => void;

export interface UiServerOptions {
  harness: Harness;
  port?: number;
  host?: string;
  cwd?: string;
  /** Log sink; defaults to no-op. Wire it to console from the CLI. */
  logger?: UiLogger;
}

export class UiServer {
  readonly session: ChatSession;
  private readonly harness: Harness;
  private readonly port: number;
  private readonly host: string;
  private readonly logger: UiLogger;
  private server: http.Server | null = null;

  constructor(opts: UiServerOptions) {
    this.harness = opts.harness;
    this.port = opts.port ?? 8787;
    this.host = opts.host ?? '127.0.0.1';
    this.logger = opts.logger ?? (() => {});
    this.session = new ChatSession(opts.harness, opts.cwd ?? process.cwd());
  }

  private log(level: UiLogLevel, message: string): void {
    this.logger(level, message);
  }

  get url(): string {
    const port = (this.server?.address() as { port: number } | null)?.port ?? this.port;
    return `http://${this.host}:${port}`;
  }

  async start(): Promise<{ url: string; port: number }> {
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        this.log('error', `route error ${req.method} ${req.url ?? ''}: ${(err as Error).message}`);
        if (!res.headersSent) {
          sendJson(res, 500, { error: (err as Error).message });
        } else {
          res.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });
    const port = (this.server!.address() as { port: number }).port;
    return { url: this.url, port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /* ------------------------------------------------------------ */

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
    if (method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, this.session.state);

    if (method === 'POST' && url.pathname === '/api/chat') return this.handleChat(req, res);
    if (method === 'POST' && url.pathname === '/api/abort') {
      this.session.abort();
      this.log('info', 'abort requested');
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/cwd') {
      const { path: p } = await readJsonBody(req);
      await this.session.setCwd(String(p));
      this.log('info', `cwd → ${this.session.cwd}`);
      return sendJson(res, 200, { ok: true, cwd: this.session.cwd });
    }
    if (method === 'POST' && url.pathname === '/api/model') {
      const { model } = await readJsonBody(req);
      await this.session.setModel(String(model));
      this.log('info', `model → ${this.harness.config.provider.model}`);
      return sendJson(res, 200, { ok: true, model: this.harness.config.provider.model });
    }
    if (method === 'POST' && url.pathname === '/api/city') {
      const { city } = await readJsonBody(req);
      await this.session.setMyCity(String(city));
      this.log('info', `my city → ${city}`);
      return sendJson(res, 200, { ok: true, city: String(city) });
    }
    if (method === 'POST' && url.pathname === '/api/approval') {
      const { id, decision } = await readJsonBody(req);
      const approved = decision === 'allow';
      const resolved = this.session.resolveApproval(String(id), approved);
      if (!resolved) return sendJson(res, 404, { error: '审批请求不存在或已超时' });
      this.log('info', `approval ${id} → ${approved ? '允许' : '拒绝'}`);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET' && url.pathname === '/api/dirs') {
      const dir = await listDir(url.searchParams.get('path') ?? this.session.cwd);
      return sendJson(res, 200, dir);
    }
    if (method === 'POST' && url.pathname === '/api/clear') {
      this.session.clearHistory();
      this.log('info', 'history cleared');
      return sendJson(res, 200, { ok: true });
    }

    return this.serveStatic(url.pathname, res);
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { message } = await readJsonBody(req);
    if (typeof message !== 'string' || !message.trim()) {
      return sendJson(res, 400, { error: 'message is required' });
    }
    this.log('info', `chat start: ${String(message).slice(0, 80)}${String(message).length > 80 ? '…' : ''}`);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const emit = (frame: unknown): void => {
      if ((frame as { type?: string }).type === 'done') {
        const done = frame as { status: string; error?: string };
        if (done.status !== 'ok') {
          this.log('error', `run ended with status "${done.status}"${done.error ? `: ${done.error}` : ''}`);
        } else {
          this.log('info', `run ok (${(frame as { toolCalls?: number }).toolCalls ?? 0} tool calls)`);
        }
      }
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };

    try {
      await this.session.chat(message, emit);
      this.log('info', 'chat finished');
    } catch (err) {
      const e = err as Error;
      this.log('error', `chat failed: ${e.message}`);
      emit({ type: 'error', message: e.message });
    }
    res.end();
  }

  private async serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    // Path-traversal guard: the resolved path must stay inside PUBLIC_DIR.
    if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });

    const data = await fs.readFile(file).catch(() => null);
    if (data === null) return sendJson(res, 404, { error: 'not found' });

    res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-cache' });
    res.end(data);
  }
}

/* ------------------------------------------------------------ */

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('invalid JSON body');
  }
}

interface DirListing {
  path: string;
  parent: string;
  dirs: string[];
  files: string[];
}

async function listDir(p: string): Promise<DirListing> {
  const resolved = path.resolve(p);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`目录不存在: ${resolved}`);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  return {
    path: resolved,
    parent: path.dirname(resolved),
    dirs,
    files: files.slice(0, 500),
  };
}
