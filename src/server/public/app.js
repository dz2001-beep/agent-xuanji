/* ═══════════════════════════════════════════════════════════════
   harness-kit 工作台 — 前端逻辑（零依赖原生 JS）
   - 流式 SSE 解析（fetch + ReadableStream）
   - 工具调用卡片（折叠/展开）
   - 完整目录浏览器（面包屑 + 列表 + 手动输入）
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  messages: $('messages'),
  emptyState: $('empty-state'),
  input: $('input'),
  sendBtn: $('send-btn'),
  stopBtn: $('stop-btn'),
  cwdPath: $('cwd-path'),
  kvProvider: $('kv-provider'),
  kvModel: $('kv-model'),
  toolsList: $('tools-list'),
  toolsCount: $('tools-count'),
  skillsList: $('skills-list'),
  skillsCount: $('skills-count'),
  clearBtn: $('clear-btn'),
  skillBanner: $('skill-banner'),
  // dir modal
  dirModal: $('dir-modal'),
  dirCrumbs: $('dir-crumbs'),
  dirList: $('dir-list'),
  dirInput: $('dir-input'),
  dirError: $('dir-error'),
  dirConfirm: $('dir-confirm'),
};

const state = {
  cwd: '',
  running: false,
  currentDir: '',      // directory currently shown in the modal
};

/* ───────────────────────── 初始化 ───────────────────────── */

async function init() {
  bindEvents();
  await refreshState();
  autoGrow();
}

async function refreshState() {
  try {
    const s = await fetchJson('/api/state');
    state.cwd = s.cwd;
    els.cwdPath.textContent = s.cwd;
    els.cwdPath.title = s.cwd;
    els.kvProvider.textContent = s.provider;
    els.kvModel.textContent = s.model;
    els.toolsCount.textContent = s.tools.length;
    els.skillsCount.textContent = s.skills.length;
    renderTags(els.toolsList, s.tools);
    renderTags(els.skillsList, s.skills.map((x) => x.name));
  } catch (err) {
    showBanner(`加载状态失败: ${err.message}`, true);
  }
}

function renderTags(ul, items) {
  ul.textContent = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
}

async function fetchJson(url, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/* ───────────────────────── 事件绑定 ───────────────────────── */

function bindEvents() {
  els.sendBtn.addEventListener('click', () => void send());
  els.stopBtn.addEventListener('click', () => void abortRun());
  els.clearBtn.addEventListener('click', () => void clearSession());

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  els.input.addEventListener('input', autoGrow);

  // 空状态快捷示例
  document.querySelectorAll('[data-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.input.value = btn.dataset.prompt;
      autoGrow();
      els.input.focus();
    });
  });

  // 侧边栏折叠
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const list = $(btn.dataset.toggle);
      list.classList.toggle('hidden');
      btn.textContent = list.classList.contains('hidden') ? '展开' : '收起';
    });
  });

  // 目录弹窗
  els.cwdPath.addEventListener('click', () => void openDirModal());
  $('cwd-open').addEventListener('click', () => void openDirModal());
  $('dir-close').addEventListener('click', closeDirModal);
  $('dir-cancel').addEventListener('click', closeDirModal);
  els.dirConfirm.addEventListener('click', () => void confirmDir());
  els.dirInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void navigateDir(els.dirInput.value);
    if (e.key === 'Escape') closeDirModal();
  });
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
}

/* ───────────────────────── 对话 ───────────────────────── */

let currentAssistant = null; // { body, cardsEl, contentEl }

function setRunning(running) {
  state.running = running;
  els.sendBtn.classList.toggle('hidden', running);
  els.stopBtn.classList.toggle('hidden', !running);
  els.input.disabled = running;
}

async function send() {
  const text = els.input.value.trim();
  if (!text || state.running) return;

  els.input.value = '';
  autoGrow();
  els.emptyState?.classList.add('hidden');

  appendUserMsg(text);
  const assistant = appendAssistantMsg();
  currentAssistant = assistant;

  setRunning(true);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    await consumeSse(res, handleFrame);
  } catch (err) {
    handleFrame({ type: 'error', message: err.message });
  }
}

async function consumeSse(res, onFrame) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;
      try {
        onFrame(JSON.parse(line.slice(6)));
      } catch {
        /* 忽略坏帧 */
      }
    }
  }
}

function handleFrame(frame) {
  switch (frame.type) {
    case 'meta':
      els.kvProvider.textContent = frame.provider;
      els.kvModel.textContent = frame.model;
      if (frame.provider === 'mock') {
        showBanner(
          '⚠ 当前为 Mock 离线演示模式（未检测到有效 API Key）。设置 DEEPSEEK_API_KEY 后重启 ui 即可用真实模型。',
          true,
        );
      } else if (frame.selectedSkills?.length) {
        showBanner(`✨ 已自动注入技能：${frame.selectedSkills.map((s) => `「${s}」`).join('、')}，正在执行`);
      }
      break;
    case 'agent':
      handleAgentEvent(frame.event);
      break;
    case 'done':
      finishTurn(frame);
      break;
    case 'error':
      finishTurn(null, frame.message);
      break;
  }
}

function handleAgentEvent(e) {
  switch (e.type) {
    case 'llm.delta':
      if (currentAssistant) {
        currentAssistant.contentEl.textContent += e.text;
        currentAssistant.contentEl.classList.add('streaming');
        scrollToBottom();
      }
      break;
    case 'llm.turn':
      // Non-streaming providers deliver the full turn here; append whatever
      // part was not already rendered through llm.delta.
      if (currentAssistant && e.message?.content) {
        const shown = currentAssistant.contentEl.textContent.length;
        if (e.message.content.length > shown) {
          currentAssistant.contentEl.textContent += e.message.content.slice(shown);
        }
      }
      break;
    case 'tool.call':
      addToolCard(e.name, e.args, e.callId);
      scrollToBottom();
      break;
    case 'tool.result':
      updateToolCard(e.callId, { status: 'ok', durationMs: e.durationMs, result: summarizeResult(e.result) });
      scrollToBottom();
      break;
    case 'tool.error':
      updateToolCard(e.callId, { status: 'err', error: e.error?.message ?? 'unknown error' });
      scrollToBottom();
      break;
    default:
      break;
  }
}

function summarizeResult(result) {
  if (!result) return '';
  if (typeof result.data === 'string') return result.data;
  try {
    return JSON.stringify(result.data, null, 2);
  } catch {
    return String(result.data);
  }
}

function finishTurn(frame, errorMsg) {
  if (currentAssistant) {
    currentAssistant.contentEl.classList.remove('streaming');
    const meta = document.createElement('div');
    meta.className = 'run-meta';
    if (errorMsg) {
      meta.textContent = `⚠ ${errorMsg}`;
    } else if (frame.error) {
      // run-level failure: show status AND the concrete reason (e.g. 402/401)
      meta.textContent = `⚠ ${frame.status} · ${frame.iterations} 轮 · ${frame.toolCalls} 次工具调用 · ${frame.error}`;
      meta.style.color = 'var(--danger)';
    } else {
      meta.textContent = `· ${frame.status} · ${frame.iterations} 轮 · ${frame.toolCalls} 次工具调用 · ${frame.tokens} tokens`;
    }
    currentAssistant.body.appendChild(meta);
    currentAssistant = null;
  }
  setRunning(false);
  if (errorMsg) showBanner(`⚠ ${errorMsg}`, true);
}

/* ───────────────────────── 消息渲染 ───────────────────────── */

function appendUserMsg(text) {
  const row = document.createElement('div');
  row.className = 'msg user';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = '你';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.append(avatar, bubble);
  els.messages.appendChild(row);
  scrollToBottom();
}

function appendAssistantMsg() {
  const row = document.createElement('div');
  row.className = 'msg assistant';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = '✦';

  const body = document.createElement('div');
  body.className = 'body';

  const cardsEl = document.createElement('div');
  cardsEl.className = 'tool-cards';

  const contentEl = document.createElement('div');
  contentEl.className = 'assistant-content';

  body.append(cardsEl, contentEl);
  row.append(avatar, body);
  els.messages.appendChild(row);
  scrollToBottom();
  return { body, cardsEl, contentEl };
}

/* ─────────────── 工具卡片（按 callId 关联状态） ─────────────── */

const toolCards = new Map();

function addToolCard(name, args, callId) {
  const card = document.createElement('div');
  card.className = 'tool-card';

  const head = document.createElement('div');
  head.className = 'tool-head';

  const icon = document.createElement('span');
  icon.textContent = iconFor(name);

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = name;

  const status = document.createElement('span');
  status.className = 'tool-status run';
  status.textContent = '运行中…';

  const toggle = document.createElement('span');
  toggle.className = 'tool-toggle';
  toggle.textContent = '▸';

  head.append(icon, nameEl, status, toggle);

  const detail = document.createElement('div');
  detail.className = 'tool-detail';
  const argLabel = document.createElement('div');
  argLabel.className = 'label';
  argLabel.textContent = '参数';
  const argPre = document.createElement('pre');
  argPre.textContent = safeJson(args);
  detail.append(argLabel, argPre);

  head.addEventListener('click', () => card.classList.toggle('open'));
  card.append(head, detail);
  currentAssistant.cardsEl.appendChild(card);

  toolCards.set(callId, { card, statusEl: status, detail });
}

function updateToolCard(callId, { status, durationMs, result, error }) {
  const entry = toolCards.get(callId);
  if (!entry) return;
  entry.statusEl.className = `tool-status ${status}`;
  entry.statusEl.textContent = status === 'ok' ? `✔ ${durationMs}ms` : '✖ 失败';
  entry.card.classList.toggle('err', status === 'err');

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = status === 'ok' ? '结果' : '错误';
  const pre = document.createElement('pre');
  pre.textContent = status === 'ok' ? (result ?? '(空)') : (error ?? 'unknown');
  entry.detail.append(label, pre);
  toolCards.delete(callId);
}

function iconFor(name) {
  if (name.startsWith('fs.')) return '📁';
  if (name.startsWith('shell')) return '💻';
  return '🔧';
}

function safeJson(v) {
  if (v === undefined) return 'undefined';
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/* ───────────────────────── 目录浏览器 ───────────────────────── */

async function openDirModal() {
  els.dirModal.classList.remove('hidden');
  els.dirError.classList.add('hidden');
  await navigateDir(state.cwd);
  els.dirInput.value = state.cwd;
  setTimeout(() => els.dirInput.focus(), 50);
}

function closeDirModal() {
  els.dirModal.classList.add('hidden');
}

async function navigateDir(dir) {
  try {
    const data = await fetchJson(`/api/dirs?path=${encodeURIComponent(dir)}`);
    state.currentDir = data.path;
    els.dirInput.value = data.path;
    renderDirList(data);
    renderCrumbs(data.path);
  } catch (err) {
    showDirError(err.message);
  }
}

function renderCrumbs(p) {
  els.dirCrumbs.textContent = '';
  const parts = p.split('/').filter(Boolean);
  const isRoot = p === '/';
  if (isRoot) {
    const btn = document.createElement('button');
    btn.textContent = '/';
    btn.addEventListener('click', () => void navigateDir('/'));
    els.dirCrumbs.appendChild(btn);
    return;
  }
  let acc = p.startsWith('/') ? '' : '';
  parts.forEach((part, i) => {
    if (i > 0 || p.startsWith('/')) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      els.dirCrumbs.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.textContent = part;
    acc = acc ? `${acc}/${part}` : `${p.startsWith('/') ? '/' : ''}${part}`;
    btn.addEventListener('click', () => void navigateDir(acc));
    els.dirCrumbs.appendChild(btn);
  });
}

function renderDirList(data) {
  els.dirList.textContent = '';
  els.dirList.classList.add('hidden');

  const addRow = (name, type) => {
    const row = document.createElement('div');
    row.className = `dir-row ${type}`;
    row.textContent = type === 'dir' ? `📁 ${name}` : `📄 ${name}`;
    row.addEventListener('click', () => {
      if (type === 'dir') {
        row.classList.add('selected');
        void navigateDir(name === '..' ? data.parent : `${data.path}/${name}`);
      }
    });
    els.dirList.appendChild(row);
  };

  if (data.parent !== data.path) addRow('..', 'dir');
  for (const d of data.dirs) addRow(d, 'dir');
  if (data.dirs.length === 0 && data.files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dir-row';
    empty.textContent = '（空目录）';
    els.dirList.appendChild(empty);
  }
  for (const f of data.files) addRow(f, 'file');

  els.dirList.classList.remove('hidden');
  // 高亮当前路径所在行
  [...els.dirList.children].forEach((row) => {
    const name = row.textContent?.replace(/^[📁📄]\s*/, '');
    if (name === data.path.split('/').pop()) row.classList.add('selected');
  });
}

async function confirmDir() {
  try {
    await fetchJson('/api/cwd', { path: state.currentDir });
    state.cwd = state.currentDir;
    els.cwdPath.textContent = state.cwd;
    els.cwdPath.title = state.cwd;
    closeDirModal();
    showBanner(`📁 工作目录已切换：${state.cwd}`);
  } catch (err) {
    showDirError(err.message);
  }
}

function showDirError(msg) {
  els.dirError.textContent = msg;
  els.dirError.classList.remove('hidden');
}

/* ───────────────────────── 其它 ───────────────────────── */

async function abortRun() {
  await fetchJson('/api/abort', {});
  showBanner('已发送停止信号…');
}

async function clearSession() {
  if (!confirm('清空当前会话历史？')) return;
  await fetchJson('/api/clear', {});
  els.messages.querySelectorAll('.msg').forEach((m) => m.remove());
  els.emptyState?.classList.remove('hidden');
  toolCards.clear();
  currentAssistant = null;
}

function showBanner(text, isError = false) {
  els.skillBanner.textContent = text;
  els.skillBanner.style.color = isError ? 'var(--danger)' : '';
  els.skillBanner.style.borderColor = isError ? 'rgba(248,113,113,.35)' : '';
  els.skillBanner.style.background = isError ? 'rgba(248,113,113,.08)' : '';
  els.skillBanner.classList.remove('hidden');
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => els.skillBanner.classList.add('hidden'), 5000);
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

init();
