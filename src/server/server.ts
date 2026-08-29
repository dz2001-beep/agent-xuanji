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

    // 链路（全链路观测）：运行列表 / 单次运行完整事件链
    if (method === 'GET' && url.pathname === '/api/runs') {
      return sendJson(res, 200, this.session.runList);
    }
    if (method === 'GET' && url.pathname.startsWith('/api/runs/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/runs/'.length));
      const run = this.session.getRun(id);
      if (!run) return sendJson(res, 404, { error: `run ${id} 不存在` });
      return sendJson(res, 200, run);
    }

    // 效果评估：最近报告 / 运行评测集
    if (method === 'GET' && url.pathname === '/api/eval') {
      return sendJson(res, 200, { report: this.session.evalReport });
    }
    if (method === 'POST' && url.pathname === '/api/eval/run') {
      return this.handleEvalRun(req, res);
    }

    // 会话导出（markdown）
    if (method === 'GET' && url.pathname === '/api/export') {
      const md = this.session.exportMarkdown();
      const name = `xuanji-session-${new Date().toISOString().slice(0, 10)}.md`;
      return sendJson(res, 200, { name, content: md });
    }

    // 后台设置：查询（脱敏）/ 保存（热切换）/ 测试连接
    if (method === 'GET' && url.pathname === '/api/settings') {
      const { loadSettings, VENDOR_PRESETS, maskKey, guessVendor } = await import('../settings.js');
      const saved = await loadSettings();
      const current = this.harness.config.provider;
      return sendJson(res, 200, {
        vendors: VENDOR_PRESETS,
        current: {
          vendor: saved?.vendor ?? (current.type === 'mock' ? 'mock' : guessVendor(current.baseURL ?? '')),
          baseURL: current.baseURL ?? saved?.baseURL ?? '',
          model: current.model,
          keySet: !!(current.type !== 'mock' && (saved?.apiKey || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY)),
          keyMasked: saved?.apiKey ? maskKey(saved.apiKey) : '',
          mock: current.type === 'mock',
          system: this.harness.config.system ?? '',
        },
      });
    }
    if (method === 'POST' && url.pathname === '/api/settings') {
      return this.handleSaveSettings(req, res);
    }
    if (method === 'POST' && url.pathname === '/api/settings/test') {
      return this.handleTestSettings(req, res);
    }

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

    // 多工作区管理：列表 / 新建 / 激活 / 删除
    if (method === 'GET' && url.pathname === '/api/workspaces') {
      return sendJson(res, 200, { workspaces: this.session.workspaceList });
    }
    if (method === 'POST' && url.pathname === '/api/workspaces') {
      const { name, path } = await readJsonBody(req);
      const ws = await this.session.createWorkspace(String(name), String(path));
      await this.session.activateWorkspace(ws.id);
      this.log('info', `workspace created + activated: ${ws.name} → ${ws.path}`);
      return sendJson(res, 200, { ok: true, workspace: ws });
    }
    if (method === 'POST' && url.pathname === '/api/workspaces/activate') {
      const { id } = await readJsonBody(req);
      await this.session.activateWorkspace(String(id));
      this.log('info', `workspace activated: ${id} → ${this.session.cwd}`);
      return sendJson(res, 200, { ok: true, cwd: this.session.cwd });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/workspaces/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/workspaces/'.length));
      await this.session.removeWorkspace(id);
      this.log('info', `workspace removed: ${id}`);
      return sendJson(res, 200, { ok: true, workspaces: this.session.workspaceList });
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

  /** Run an eval dataset (mock or the session's real harness) and keep the report. */
  private async handleEvalRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { runEval } = await import('../eval.js');
    const { dataset, label, mock } = await readJsonBody(req);
    const datasetPath = path.resolve(String(dataset ?? path.join(process.cwd(), 'examples/eval/demo-cases.json')));
    const raw = await fs.readFile(datasetPath, 'utf8').catch(() => null);
    if (!raw) return sendJson(res, 400, { error: `评测集不存在: ${datasetPath}` });
    const cases = (JSON.parse(raw) as { cases: Array<{ id: string; prompt: string }> }).cases;

    this.log('info', `eval run start: ${datasetPath} (mock=${mock ? 'yes' : 'no'})`);
    const tempHarnesses: import('../harness/harness.js').Harness[] = [];
    try {
      const run = async (prompt: string) => {
        if (mock) {
          // independent offline harness — no network, fast, deterministic
          const { Harness: H } = await import('../harness/harness.js');
          const h = await H.create({
            config: { provider: { type: 'mock', model: 'mock-model' }, tools: ['fs', 'shell', 'web'] },
            forceMock: true,
          });
          tempHarnesses.push(h);
          return h.run(prompt);
        }
        return this.harness.run(prompt);
      };
      const report = await runEval(cases, run, { label: String(label ?? 'workspace') });
      this.session.setEvalReport(report);
      this.log('info', `eval done: ${report.summary.passed}/${report.summary.total} passed`);
      return sendJson(res, 200, { report });
    } finally {
      for (const h of tempHarnesses) await h.dispose();
    }
  }

  /** Save settings: hot-swap provider, persist to ~/.xuanji/settings.json. */
  private async handleSaveSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { saveSettings, findVendor } = await import('../settings.js');
    const body = await readJsonBody(req);
    const vendor = String(body.vendor ?? '');
    const model = String(body.model ?? '').trim();
    const baseURL = String(body.baseURL ?? '').trim() || undefined;
    const apiKey = String(body.apiKey ?? '').trim() || undefined;
    const system = String(body.system ?? '').trim();
    if (!model) return sendJson(res, 400, { error: 'model 不能为空' });

    const preset = findVendor(vendor);
    const effectiveBaseURL = baseURL ?? preset?.baseURL ?? '';
    const settings = { vendor, baseURL: effectiveBaseURL, apiKey, model, ...(system ? { system } : {}) };

    // 自定义 system prompt 立即生效
    if (system) this.harness.config.system = system;

    try {
      // Hot-swap: mock（无 baseURL 且无 key 时兜底 mock）→ 真实 provider
      if (vendor === 'mock' || (!effectiveBaseURL && !apiKey)) {
        this.harness.setProvider({ type: 'mock', model });
        await saveSettings({ ...settings, apiKey: undefined });
      } else {
        this.harness.setProvider({ type: 'openai', model, apiKey, baseURL: effectiveBaseURL || undefined });
        await saveSettings(settings);
      }
      this.log('info', `settings saved: vendor=${vendor} model=${model} baseURL=${effectiveBaseURL || '(mock)'}`);
      return sendJson(res, 200, { ok: true, model, baseURL: effectiveBaseURL || '(mock)' });
    } catch (err) {
      return sendJson(res, 500, { error: `保存失败: ${(err as Error).message}` });
    }
  }

  /** Test a candidate vendor/key/model without saving. */
  private async handleTestSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { testModelCall } = await import('../diagnose.js');
    const { findVendor } = await import('../settings.js');
    const body = await readJsonBody(req);
    const model = String(body.model ?? '').trim();
    const apiKey = String(body.apiKey ?? '').trim() || undefined;
    const baseURL = String(body.baseURL ?? '').trim() || findVendor(String(body.vendor ?? ''))?.baseURL || '';
    if (!model) return sendJson(res, 400, { error: 'model 不能为空' });
    if (!baseURL) return sendJson(res, 400, { error: 'baseURL 不能为空（自定义厂商需填写端点）' });

    this.log('info', `settings test: ${baseURL} model=${model}`);
    const result = await testModelCall({ model, apiKey: apiKey ?? 'missing', baseURL, maxRetries: 0 });
    return sendJson(res, 200, result);
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
