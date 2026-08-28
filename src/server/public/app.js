/* ═══════════════════════════════════════════════════════════════
   xuanji 工作台 — 前端逻辑（零依赖原生 JS）
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
  cityInput: $('city-input'),
  citySave: $('city-save'),
  // dir modal
  dirModal: $('dir-modal'),
  dirCrumbs: $('dir-crumbs'),
  dirList: $('dir-list'),
  dirInput: $('dir-input'),
  dirError: $('dir-error'),
  dirConfirm: $('dir-confirm'),
  // approval modal
  approvalModal: $('approval-modal'),
  approvalTool: $('approval-tool'),
  approvalArgs: $('approval-args'),
  approvalReason: $('approval-reason'),
  approvalReasonRow: $('approval-reason-row'),
  approvalAllow: $('approval-allow'),
  approvalDeny: $('approval-deny'),
  // 观测台（链路 + 评估）
  mainChat: document.querySelector('.main:not(.observatory)'),
  observatory: $('observatory'),
  navChat: $('nav-chat'),
  navObservatory: $('nav-observatory'),
  obsRuns: $('obs-runs'),
  obsRunsCount: $('obs-runs-count'),
  obsRefresh: $('obs-refresh'),
  obsTraceSection: $('obs-trace-section'),
  obsTraceMeta: $('obs-trace-meta'),
  obsTraceTimeline: $('obs-trace-timeline'),
  obsTraceClose: $('obs-trace-close'),
  obsEvalLabel: $('obs-eval-label'),
  obsEvalRun: $('obs-eval-run'),
  obsEvalReport: $('obs-eval-report'),
  sfxToggle: $('sfx-toggle'),
  hudTime: $('hud-time'),
  // 设置页
  settingsPanel: $('settings-panel'),
  navSettings: $('nav-settings'),
  setVendor: $('set-vendor'),
  setVendorDesc: $('set-vendor-desc'),
  setApikey: $('set-apikey'),
  setBaseurl: $('set-baseurl'),
  setModel: $('set-model'),
  setModels: $('set-models'),
  setCurrent: $('set-current'),
  setTest: $('set-test'),
  setSave: $('set-save'),
  setResult: $('set-result'),
};

const state = {
  cwd: '',
  running: false,
  currentDir: '',      // directory currently shown in the modal
};

/* ───────────────────────── 初始化 ───────────────────────── */

function bindSfxToggle() {
  const sync = () => {
    const on = window.sfx?.enabled ?? true;
    els.sfxToggle.textContent = on ? '🔊 音效：开' : '🔇 音效：关';
    els.sfxToggle.classList.toggle('on', on);
  };
  sync();
  els.sfxToggle.addEventListener('click', () => {
    window.sfx?.setEnabled(!(window.sfx?.enabled ?? true));
    sync();
    if (window.sfx?.enabled) window.sfx.click();
  });
  // HUD 时钟
  const tick = () => {
    if (els.hudTime) els.hudTime.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

async function init() {
  try {
    bindEvents();
    bindApprovalEvents();
    bindObservatoryEvents();
    bindSettingsEvents();
    bindSfxToggle();
    await refreshState();
    autoGrow();
  } catch (err) {
    console.error('[xuanji] 初始化失败:', err);
    showBanner(`初始化失败: ${err.message}`, true);
  }
}

async function refreshState() {
  try {
    const s = await fetchJson('/api/state');
    state.cwd = s.cwd;
    els.cwdPath.textContent = s.cwd;
    els.cwdPath.title = s.cwd;
    els.kvProvider.textContent = s.provider;
    renderModelSelect(s.models ?? [], s.model);
    els.toolsCount.textContent = s.tools.length;
    els.skillsCount.textContent = s.skills.length;
    renderTags(els.toolsList, s.tools);
    renderTags(els.skillsList, s.skills.map((x) => x.name));
  } catch (err) {
    showBanner(`加载状态失败: ${err.message}`, true);
  }
}

function renderModelSelect(models, current) {
  els.kvModel.textContent = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === current) opt.selected = true;
    els.kvModel.appendChild(opt);
  }
  if (!models.includes(current) && current) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current}（当前）`;
    opt.selected = true;
    els.kvModel.appendChild(opt);
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
  els.cwdPath.title = '点击选择工作区';
  $('dir-close').addEventListener('click', closeDirModal);
  $('dir-cancel').addEventListener('click', closeDirModal);
  els.dirConfirm.addEventListener('click', () => void confirmDir());
  els.dirInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void navigateDir(els.dirInput.value);
    if (e.key === 'Escape') closeDirModal();
  });

  // 模型切换
  els.kvModel.addEventListener('change', async () => {
    const model = els.kvModel.value;
    try {
      await fetchJson('/api/model', { model });
      showBanner(`🤖 已切换模型：${model}`);
    } catch (err) {
      showBanner(`切换模型失败: ${err.message}`, true);
    }
  });

  // 我的城市（localStorage 记住，页面加载时自动恢复并同步到天气 server）
  const savedCity = localStorage.getItem('xuanji.myCity') ?? '';
  els.cityInput.value = savedCity;
  if (savedCity) {
    void saveCity(savedCity, true);
  }
  els.citySave.addEventListener('click', () => void saveCity(els.cityInput.value.trim(), false));
  els.cityInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void saveCity(els.cityInput.value.trim(), false);
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
  window.sfx?.send();

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
      if (frame.model) els.kvModel.value = frame.model;
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
    case 'approval.request':
      showApproval(frame.request);
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
      window.sfx?.tool();
      addToolCard(e.name, e.args, e.callId);
      scrollToBottom();
      break;
    case 'tool.result':
      window.sfx?.toolOk();
      updateToolCard(e.callId, { status: 'ok', durationMs: e.durationMs, result: summarizeResult(e.result) });
      scrollToBottom();
      break;
    case 'tool.error':
      window.sfx?.toolOk();
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

    // 链路入口：查看本次运行的完整事件链
    if (frame.runId) {
      const link = document.createElement('button');
      link.className = 'btn btn-ghost btn-sm trace-link';
      link.textContent = '🔗 查看链路';
      link.title = '在观测台查看模型输出与工具调用链路';
      link.addEventListener('click', () => {
        switchTab('observatory');
        void openRunInObservatory(frame.runId);
      });
      currentAssistant.body.appendChild(link);
    }

    currentAssistant = null;
  }
  setRunning(false);
  if (errorMsg) {
    window.sfx?.error();
    showBanner(`⚠ ${errorMsg}`, true);
  } else {
    window.sfx?.done();
  }
  // 对话结束后观测台自动刷新，链路列表保持最新
  if (!els.observatory.classList.contains('hidden')) {
    void loadObservatory();
  }
}

/* ───────────────────────── 观测台（链路 + 评估） ───────────────────────── */

let selectedRunId = null;

function switchTab(tab) {
  const isChat = tab === 'chat';
  const isObs = tab === 'observatory';
  const isSet = tab === 'settings';
  els.mainChat.classList.toggle('hidden', !isChat);
  els.observatory.classList.toggle('hidden', !isObs);
  els.settingsPanel.classList.toggle('hidden', !isSet);
  els.navChat.classList.toggle('active', isChat);
  els.navObservatory.classList.toggle('active', isObs);
  els.navSettings.classList.toggle('active', isSet);
  if (isObs) void loadObservatory();
  if (isSet) void loadSettingsPage();
}

async function loadObservatory() {
  await Promise.allSettled([loadRuns(), loadEvalReport()]);
  // 若链路详情正展开，同步重载（保证"刷新"连详情一起更新）
  if (selectedRunId && !els.obsTraceSection.classList.contains('hidden')) {
    void openRunInObservatory(selectedRunId);
  }
}

/** 运行链路列表 */
async function loadRuns() {
  try {
    const runs = await fetchJson('/api/runs');
    els.obsRunsCount.textContent = runs.length;
    renderRunList(runs);
  } catch (err) {
    els.obsRuns.textContent = `加载失败: ${err.message}`;
  }
}

function renderRunList(runs) {
  els.obsRuns.textContent = '';
  if (runs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'obs-empty';
    empty.textContent = '暂无运行记录 —— 去「💬 对话」里发几条消息，或点右上角刷新';
    els.obsRuns.appendChild(empty);
    return;
  }
  for (const r of [...runs].reverse()) {
    const row = document.createElement('div');
    row.className = `obs-run-row${r.id === selectedRunId ? ' selected' : ''}`;
    const left = document.createElement('div');
    left.className = 'obs-run-left';
    const input = document.createElement('div');
    input.className = 'obs-run-input';
    input.textContent = r.input;
    const time = document.createElement('div');
    time.className = 'obs-run-time';
    time.textContent = new Date(r.startedAt).toLocaleTimeString();
    left.append(input, time);
    const right = document.createElement('div');
    right.className = 'obs-run-right';
    right.textContent = `${r.status} · ${r.iterations} 轮 · ${r.toolCalls} 工具 · ${r.tokens} tok`;
    if (r.status !== 'ok') right.style.color = 'var(--danger)';
    row.append(left, right);
    row.addEventListener('click', () => {
      selectedRunId = r.id;
      void openRunInObservatory(r.id);
      renderRunList(runs);
    });
    els.obsRuns.appendChild(row);
  }
}

/** 单次运行链路详情 */
async function openRunInObservatory(runId) {
  els.obsTraceSection.classList.remove('hidden');
  els.obsTraceMeta.textContent = '加载中…';
  els.obsTraceTimeline.textContent = '';
  try {
    const run = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
    renderTraceMeta(run);
    renderTraceTimeline(run.events ?? []);
  } catch (err) {
    els.obsTraceMeta.textContent = `加载失败: ${err.message}`;
  }
}

function closeObsTrace() {
  els.obsTraceSection.classList.add('hidden');
}

/** 效果评估 */
async function loadEvalReport() {
  try {
    const { report } = await fetchJson('/api/eval');
    renderEvalReport(report);
  } catch {
    /* 无报告不提示 */
  }
}

async function runEvalFromUI() {
  const label = els.obsEvalLabel.value.trim() || 'workspace';
  els.obsEvalReport.textContent = '⏳ 评测运行中（mock 离线，5 个用例）…';
  try {
    const res = await fetch('/api/eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, mock: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    renderEvalReport(data.report);
    showBanner(`📈 评测完成：${data.report.summary.passed}/${data.report.summary.total} 通过`);
  } catch (err) {
    els.obsEvalReport.textContent = `评测失败: ${err.message}`;
  }
}

function renderEvalReport(report) {
  els.obsEvalReport.textContent = '';
  if (!report) {
    const empty = document.createElement('div');
    empty.className = 'obs-empty';
    empty.textContent = '还没有评测报告 —— 点「▶ 运行评测集」跑一次';
    els.obsEvalReport.appendChild(empty);
    return;
  }
  const summary = document.createElement('div');
  summary.className = 'obs-eval-summary';
  summary.textContent =
    `${report.label}  ·  通过 ${report.summary.passed}/${report.summary.total} (${(report.summary.passRate * 100).toFixed(1)}%)` +
    `  ·  总 token ${report.summary.totalTokens}  ·  平均 ${report.summary.avgTokens} tok / ${report.summary.avgToolCalls} 工具`;
  els.obsEvalReport.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'obs-eval-table';
  const head = document.createElement('tr');
  for (const h of ['用例', '状态', '工具', 'token', '耗时', '结果']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const c of report.cases) {
    const tr = document.createElement('tr');
    const cells = [
      c.id,
      c.status,
      String(c.toolCalls),
      String(c.tokens),
      `${c.durationMs}ms`,
      c.passed ? '✓' : `✗ ${c.failures.join('; ')}`,
    ];
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td');
      td.textContent = cells[i];
      if (i === 5) td.className = c.passed ? 'ok' : 'fail';
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  els.obsEvalReport.appendChild(table);
}

/* ───────────────────────── 设置页 ───────────────────────── */

let vendorPresets = [];

async function loadSettingsPage() {
  try {
    const data = await fetchJson('/api/settings');
    vendorPresets = data.vendors ?? [];
    renderVendors(data.vendors ?? [], data.current);
  } catch (err) {
    els.setResult.textContent = `加载设置失败: ${err.message}`;
  }
}

function renderVendors(vendors, current) {
  els.setVendor.textContent = '';
  for (const v of vendors) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `${v.name} — ${v.description}`;
    els.setVendor.appendChild(opt);
  }
  // 选中当前厂商
  const vendorId = current?.vendor ?? vendors[0]?.id;
  if (vendorId) els.setVendor.value = vendorId;

  els.setBaseurl.value = current?.baseURL ?? '';
  els.setModel.value = current?.model ?? '';
  els.setApikey.value = '';
  const cur = current;
  els.setCurrent.textContent = cur
    ? `当前：${cur.vendor} · ${cur.model}${cur.mock ? '（mock 离线）' : cur.keySet ? ' · Key 已设置' : ' · 未设置 Key'}${cur.keyMasked ? `（${cur.keyMasked}）` : ''}`
    : '';
  syncVendorFields();
}

function syncVendorFields() {
  const v = vendorPresets.find((x) => x.id === els.setVendor.value);
  if (!v) return;
  els.setVendorDesc.textContent = v.description;
  if (!els.setBaseurl.value && v.baseURL) els.setBaseurl.value = v.baseURL;
  if (!els.setModel.value && v.defaultModel) els.setModel.value = v.defaultModel;
  els.setApikey.placeholder = v.needsKey ? 'sk-…（必填）' : '本地模型无需 Key，可留空';
}

function collectSettings() {
  return {
    vendor: els.setVendor.value,
    apiKey: els.setApikey.value.trim(),
    baseURL: els.setBaseurl.value.trim(),
    model: els.setModel.value.trim(),
    models: els.setModels.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  };
}

function bindSettingsEvents() {
  els.navSettings.addEventListener('click', () => switchTab('settings'));
  els.setVendor.addEventListener('change', syncVendorFields);

  els.setTest.addEventListener('click', async () => {
    const s = collectSettings();
    if (!s.model) return (els.setResult.textContent = '请先填写模型名');
    if (!s.baseURL) return (els.setResult.textContent = '请先填写 Base URL');
    els.setResult.textContent = '⏳ 测试连接中…';
    els.setResult.style.color = '';
    try {
      const res = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      els.setResult.textContent = data.ok
        ? `✅ 连接成功（${data.latencyMs}ms）`
        : `❌ 连接失败: ${data.error}`;
      els.setResult.style.color = data.ok ? 'var(--ok)' : 'var(--danger)';
    } catch (err) {
      els.setResult.textContent = `❌ 测试失败: ${err.message}`;
      els.setResult.style.color = 'var(--danger)';
    }
  });

  els.setSave.addEventListener('click', async () => {
    const s = collectSettings();
    if (!s.model) return (els.setResult.textContent = '请先填写模型名');
    els.setResult.textContent = '⏳ 保存中…';
    els.setResult.style.color = '';
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      els.setResult.textContent = `✅ 已保存并生效（${data.model}）`;
      els.setResult.style.color = 'var(--ok)';
      showBanner(`⚙️ 已切换到 ${data.baseURL} · ${data.model}`);
      await refreshState();
    } catch (err) {
      els.setResult.textContent = `❌ 保存失败: ${err.message}`;
      els.setResult.style.color = 'var(--danger)';
    }
  });
}

function bindObservatoryEvents() {
  els.navChat.addEventListener('click', () => switchTab('chat'));
  els.navObservatory.addEventListener('click', () => switchTab('observatory'));
  els.obsRefresh.addEventListener('click', async () => {
    const btn = els.obsRefresh;
    const old = btn.textContent;
    btn.textContent = '刷新中…';
    btn.disabled = true;
    try {
      await loadObservatory();
      showBanner('↻ 观测台已刷新');
    } catch {
      showBanner('刷新失败', true);
    } finally {
      btn.textContent = old;
      btn.disabled = false;
    }
  });
  els.obsTraceClose.addEventListener('click', closeObsTrace);
  els.obsEvalRun.addEventListener('click', () => void runEvalFromUI());
}

function renderTraceMeta(run) {
  els.obsTraceMeta.textContent = '';
  const meta = document.createElement('div');
  meta.textContent =
    `输入: ${run.input}  ·  状态: ${run.status}  ·  ${run.iterations} 轮  ·  ${run.toolCalls} 次工具调用  ·  ${run.tokens} tokens`;
  els.obsTraceMeta.appendChild(meta);
}

function renderTraceTimeline(events) {
  els.obsTraceTimeline.textContent = '';
  let turn = 0;
  for (const e of events) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    switch (e.type) {
      case 'turn.start':
        turn = e.iteration;
        row.className = 'tl-row tl-turn';
        const turnLabel = document.createElement('div');
        turnLabel.className = 'tl-node tl-node-turn';
        turnLabel.textContent = `轮次 ${turn}`;
        row.appendChild(turnLabel);
        break;
      case 'llm.turn':
        row.className = 'tl-row tl-llm';
        const llmNode = document.createElement('div');
        llmNode.className = 'tl-node tl-node-llm';
        llmNode.textContent = '✦';
        row.appendChild(llmNode);
        const llmBody = document.createElement('div');
        llmBody.className = 'tl-body';
        if (e.message?.toolCalls?.length) {
          llmBody.textContent = `请求调用工具: ${e.message.toolCalls.map((t) => t.name).join(', ')}`;
        } else if (e.message?.content) {
          llmBody.textContent = e.message.content;
        }
        if (e.usage) {
          const u = document.createElement('span');
          u.className = 'tl-token';
          u.textContent = ` ${e.usage.promptTokens}+${e.usage.completionTokens} tok`;
          llmBody.appendChild(u);
        }
        row.appendChild(llmBody);
        break;
      case 'tool.call':
        row.className = 'tl-row tl-tool';
        const toolNode = document.createElement('div');
        toolNode.className = 'tl-node tl-node-tool';
        toolNode.textContent = '🔧';
        row.appendChild(toolNode);
        const toolBody = document.createElement('div');
        toolBody.className = 'tl-body';
        const toolName = document.createElement('div');
        toolName.className = 'tl-tool-name';
        toolName.textContent = e.name;
        toolBody.appendChild(toolName);
        const args = document.createElement('pre');
        args.className = 'tl-args';
        args.textContent = safeJson(e.args);
        toolBody.appendChild(args);
        row.appendChild(toolBody);
        break;
      case 'tool.result':
      case 'tool.error':
        row.className = 'tl-row tl-tool-result';
        const resNode = document.createElement('div');
        resNode.className = 'tl-node';
        resNode.textContent = e.type === 'tool.result' ? '✓' : '✗';
        row.appendChild(resNode);
        const resBody = document.createElement('div');
        resBody.className = 'tl-body';
        if (e.type === 'tool.result') {
          resBody.textContent = `完成 (${e.durationMs}ms)`;
          const pre = document.createElement('pre');
          pre.className = 'tl-args';
          pre.textContent = summarizeResult(e.result);
          resBody.appendChild(pre);
        } else {
          resBody.textContent = `失败: ${e.error?.message ?? ''}`;
          resBody.style.color = 'var(--danger)';
        }
        row.appendChild(resBody);
        break;
      case 'context.compacted':
        row.className = 'tl-row tl-llm';
        const cNode = document.createElement('div');
        cNode.className = 'tl-node tl-node-llm';
        cNode.textContent = '📦';
        row.appendChild(cNode);
        const cBody = document.createElement('div');
        cBody.className = 'tl-body';
        cBody.textContent = `上下文压缩: ${e.beforeTokens} → ${e.afterTokens} tokens（折叠 ${e.foldedTurns} 轮 / 裁剪 ${e.trimmedResults} 个结果）`;
        row.appendChild(cBody);
        break;
      default:
        continue; // agent.start / agent.done / llm.delta 等不单独成行
    }
    els.obsTraceTimeline.appendChild(row);
  }
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
    showBanner(`📁 工作区已切换：${state.cwd}（生成的文件都在这里）`);
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

async function saveCity(city, silent) {
  try {
    await fetchJson('/api/city', { city });
    localStorage.setItem('xuanji.myCity', city);
    els.cityInput.value = city;
    if (!silent) showBanner(`🌤 我的城市已设为：${city}（问天气默认用它）`);
  } catch (err) {
    if (!silent) showBanner(`设置城市失败: ${err.message}`, true);
    // 静默恢复失败（如未配置 weather server）不打扰用户
  }
}

/* ───────────────────────── 审批流 ───────────────────────── */

let currentApproval = null;

function showApproval(req) {
  window.sfx?.approval();
  currentApproval = req;
  els.approvalTool.textContent = req.toolName;
  els.approvalArgs.textContent = safeJson(req.args);
  if (req.reason) {
    els.approvalReason.textContent = req.reason;
    els.approvalReasonRow.classList.remove('hidden');
  } else {
    els.approvalReasonRow.classList.add('hidden');
  }
  els.approvalModal.classList.remove('hidden');
}

async function resolveApproval(decision) {
  const req = currentApproval;
  currentApproval = null;
  els.approvalModal.classList.add('hidden');
  if (!req) return;
  try {
    await fetchJson('/api/approval', { id: req.id, decision });
    showBanner(decision === 'allow' ? `✔ 已允许执行：${req.toolName}` : `✖ 已拒绝：${req.toolName}`);
  } catch (err) {
    showBanner(`审批提交失败: ${err.message}`, true);
  }
}

function bindApprovalEvents() {
  els.approvalAllow.addEventListener('click', () => void resolveApproval('allow'));
  els.approvalDeny.addEventListener('click', () => void resolveApproval('deny'));
  $('approval-deny-x').addEventListener('click', () => void resolveApproval('deny'));
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

init();
