/* =========================================================================
 * OpenCode Go Router — Control Room
 * Dashboard client. Vanilla JS, no framework.
 * ========================================================================= */
'use strict';

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const escapeHtml = (v) => String(v ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const fmtNumber = (v) => Number(v || 0).toLocaleString('en-US');
const fmtCurrency = (v) => `$${Number(v || 0).toFixed(4)}`;
const fmtTokens = (v) => {
  const n = Number(v || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return n.toLocaleString('en-US');
};
const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const fmtDateTime = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;
};
const fmtCooldown = (ms) => {
  if (!ms) return 'Ready';
  const remaining = ms - Date.now();
  if (remaining <= 0) return 'Ready';
  const m = Math.ceil(remaining / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};
const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};
const rAFThrottle = (fn) => {
  let pending = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
};

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

const toastStack = $('#toast-stack');
function toast(message, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const api = {
  async req(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },
  status() { return this.req('/api/status'); },
  keys() { return this.req('/api/keys'); },
  strategies() { return this.req('/api/strategies'); },
  currentStrategy() { return this.req('/api/strategy'); },
  setStrategy(s) { return this.req('/api/strategy', { method: 'PUT', body: { strategy: s } }); },
  addKey(payload) { return this.req('/api/keys', { method: 'POST', body: payload }); },
  updateKey(id, payload) { return this.req(`/api/keys/${id}`, { method: 'PUT', body: payload }); },
  replaceKey(id, key) { return this.req(`/api/keys/${id}/key`, { method: 'PUT', body: { key } }); },
  toggleKey(id, enabled) { return this.req(`/api/keys/${id}/toggle`, { method: 'PUT', body: { enabled } }); },
  reorderKeys(order) { return this.req('/api/keys/reorder', { method: 'PUT', body: { order } }); },
  resetCooldown(id) { return this.req(`/api/keys/${id}/reset-cooldown`, { method: 'POST' }); },
  removeKey(id) { return this.req(`/api/keys/${id}`, { method: 'DELETE' }); },
  recentLogs() { return this.req('/api/logs'); },
};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = {
  currentPage: 'overview',
  strategies: [],
  activeStrategy: '',
  keys: [],
  summary: null,
  recentLogs: [],          // ring buffer
  archivedLogs: [],        // up to 10000 older entries
  expandedLogId: null,
  logFilter: { search: '', level: '' },
  paused: false,
  pausedBuffer: [],
  logById: new Map(),      // id -> log entry, for finding expanded row
};

// ---------------------------------------------------------------------------
// Event bus — used for live updates from WebSocket
// ---------------------------------------------------------------------------

const bus = new EventTarget();
const emit = (event, detail) => bus.dispatchEvent(new CustomEvent(event, { detail }));
const on = (event, handler) => bus.addEventListener(event, handler);

// ---------------------------------------------------------------------------
// Routing (page switching)
// ---------------------------------------------------------------------------

function setPage(page) {
  state.currentPage = page;
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  $$('.page').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  if (page === 'logs') ensureLogRender();
  if (page === 'overview') renderOverview();
  if (page === 'routing') renderRouting();
  if (page === 'accounts') renderAccounts();
  if (page === 'settings') renderSettings();
}

function initRouting() {
  $$('.nav-item').forEach((el) => {
    el.addEventListener('click', () => setPage(el.dataset.page));
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  initRouting();
  initModal();
  initLogsToolbar();
  initSearch();
  connectWebSocket();
  await refreshAll();
  await backfillLogs();
  // Re-render periodically for KPIs that come from the snapshot endpoint
  setInterval(refreshSnapshot, 5000);
  setInterval(refreshKeys, 10000);
  // Re-render accounts every 3s so the sparkline ticks even when no requests come in
  setInterval(() => {
    if (state.currentPage === 'accounts') renderAccounts();
    if (state.currentPage === 'overview') {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const k of Object.keys(chartState.series)) {
        chartState.series[k] = chartState.series[k].filter((p) => p.t >= cutoff);
      }
      renderOverviewChart();
    }
  }, 3000);
});

// ---------------------------------------------------------------------------
// Refreshers
// ---------------------------------------------------------------------------

async function refreshAll() {
  await Promise.all([refreshStrategies(), refreshKeys(), refreshSnapshot()]);
}

async function refreshStrategies() {
  const [strategiesRes, currentRes] = await Promise.all([
    api.strategies(),
    api.currentStrategy(),
  ]);
  state.strategies = strategiesRes.strategies || [];
  state.activeStrategy = currentRes.strategy;
  renderRouting();
  $('#footer-strategy').textContent = state.activeStrategy.replace(/_/g, ' ');
}

async function refreshKeys() {
  const keys = await api.keys();
  state.keys = keys;
  $('#nav-keys-count').textContent = String(keys.filter((k) => k.enabled).length);
  renderAccounts();
  if (state.currentPage === 'overview') renderOverview();
}

async function refreshSnapshot() {
  const data = await api.status();
  state.summary = data.summary;
  state.keys = data.keys;
  $('#nav-keys-count').textContent = String(data.summary.enabledKeys);
  if (state.currentPage === 'overview') renderOverview();
  renderAccounts();
  if (state.currentPage === 'routing') renderRouting();
}

window.__refreshAll = refreshAll;
window.__refreshKeys = refreshKeys;
window.__refreshSnapshot = refreshSnapshot;

// ---------------------------------------------------------------------------
// WebSocket — live logs + connection status
// ---------------------------------------------------------------------------

let ws = null;
let wsReconnectTimer = null;

function setStatus(connected) {
  const pill = $('#status-badge');
  const text = pill.querySelector('.status-text');
  pill.classList.toggle('connected', connected);
  text.textContent = connected ? 'Connected' : 'Disconnected';
}

function connectWebSocket() {
  if (ws) { try { ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/logs`);
  ws.onopen = () => {
    setStatus(true);
  };
  ws.onclose = () => {
    setStatus(false);
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWebSocket, 2000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (ev) => {
    let entry;
    try { entry = JSON.parse(ev.data); } catch { return; }
    ingestLog(entry);
  };
}

// Backfill from /api/logs so the page is useful immediately after load
async function backfillLogs() {
  try {
    const logs = await api.recentLogs();
    state.archivedLogs = [];
    state.recentLogs = [];
    for (const e of logs) ingestLog(e, { initial: true });
  } catch (err) {
    console.warn('Failed to backfill logs', err);
  }
}

function ingestLog(entry, { initial = false } = {}) {
  // Idempotency: assign id based on timestamp + message hash
  if (!entry.__id) {
    entry.__id = `${entry.timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  }

  if (state.paused && !initial) {
    state.pausedBuffer.push(entry);
    if (state.pausedBuffer.length > 500) state.pausedBuffer.shift();
    return;
  }

  // Maintain ring buffer of 500
  state.recentLogs.push(entry);
  if (state.recentLogs.length > 500) {
    const evicted = state.recentLogs.shift();
    state.archivedLogs.push(evicted);
    if (state.archivedLogs.length > 10000) state.archivedLogs.shift();
  }
  state.logById.set(entry.__id, entry);

  if (entry.meta?.method) {
    pushChartPoint(entry);
    recordRequestTick(entry);
  }

  if (state.currentPage === 'logs') {
    scheduleLogRender();
  }
  if (state.currentPage === 'overview') {
    scheduleOverviewChart();
  }
}

// ---------------------------------------------------------------------------
// Modal — Add key
// ---------------------------------------------------------------------------

function initModal() {
  const overlay = $('#add-key-modal');
  $('#add-key-btn').addEventListener('click', () => {
    $('#key-alias-input').value = '';
    $('#key-value-input').value = '';
    $('#key-priority-input').value = String((state.keys[state.keys.length - 1]?.priority ?? 0) + 1);
    $('#key-weight-input').value = '1';
    overlay.classList.add('active');
    setTimeout(() => $('#key-alias-input').focus(), 50);
  });
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', saveNewKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) closeModal();
  });
}

function closeModal() { $('#add-key-modal').classList.remove('active'); }

async function saveNewKey() {
  const alias = $('#key-alias-input').value.trim();
  const key = $('#key-value-input').value.trim();
  const priority = Number($('#key-priority-input').value || '1');
  const weight = Number($('#key-weight-input').value || '1');
  if (!key) { toast('API key is required', 'error'); return; }
  try {
    await api.addKey({ key, alias: alias || undefined, priority, weight });
    toast('Key added', 'success');
    closeModal();
    await refreshKeys();
  } catch (err) {
    toast(err.message || 'Failed to add key', 'error');
  }
}

// ---------------------------------------------------------------------------
// Page: Overview
// ---------------------------------------------------------------------------

function renderOverview() {
  if (!state.summary) return;
  renderOverviewKpis();
  renderReconciliation();
  renderTokenBreakdown();
  renderOverviewChart();
}

function renderOverviewKpis() {
  const s = state.summary || {};
  const kpis = [
    { label: 'Enabled keys', value: s.enabledKeys ?? 0, accent: 'accent' },
    { label: 'Active', value: s.activeKeys ?? 0, accent: 'green' },
    { label: 'Cooldown', value: s.cooldownKeys ?? 0, accent: s.cooldownKeys ? 'yellow' : '' },
    { label: 'Requests', value: fmtTokens(s.totalRequests ?? 0) },
    { label: 'Spend', value: fmtCurrency(s.estimatedCost ?? 0), accent: 'accent' },
  ];
  $('#overview-kpis').innerHTML = kpis.map((k) => `
    <div class="kpi">
      <span class="kpi-label">${escapeHtml(k.label)}</span>
      <span class="kpi-value ${k.accent || ''}">${escapeHtml(String(k.value))}</span>
    </div>
  `).join('');
}

function renderReconciliation() {
  const s = state.summary || {};
  const actual = s.actualUsage || {};
  const router30 = s.estimatedCost || 0;
  const opencode30 = actual.rolling30d?.cost || 0;
  const router7 = (state.keys || []).reduce((sum, k) => sum + Number(k.recentUsage?.last7d?.cost || 0), 0);
  const opencode7 = actual.trailing7d?.cost || 0;
  const routerMonth = (state.keys || []).reduce((sum, k) => sum + Number(k.recentUsage?.calendarMonth?.cost || 0), 0);
  const opencodeMonth = actual.calendarMonth?.cost || 0;

  const rows = [
    { label: '7d', router: router7, opencode: opencode7, available: actual.available },
    { label: '30d', router: router30, opencode: opencode30, available: actual.available },
    { label: 'Month', router: routerMonth, opencode: opencodeMonth, available: actual.available },
  ];

  const max = Math.max(0.0001, ...rows.flatMap((r) => [r.router, r.opencode]));

  const reconMeta = actual.available
    ? `Last OpenCode update: ${fmtDateTime(actual.lastUpdatedAt)}`
    : 'OpenCode DB unavailable';
  $('#recon-meta').textContent = reconMeta;

  $('#recon-body').innerHTML = rows.map((r) => {
    const routerPct = (r.router / max) * 100;
    const opencodePct = (r.opencode / max) * 100;
    return `
      <div class="recon-row">
        <div class="recon-label">${r.label}</div>
        <div class="recon-bar router" title="Router observed"><div style="width:${routerPct.toFixed(1)}%"></div></div>
        <div class="recon-bar opencode" title="OpenCode recorded"><div style="width:${opencodePct.toFixed(1)}%"></div></div>
        <div class="recon-amount">${fmtCurrency(r.router)} / ${fmtCurrency(r.opencode)}</div>
      </div>
    `;
  }).join('');
}

function renderTokenBreakdown() {
  const totals = (state.keys || []).reduce((acc, k) => {
    const b = k.quota?.tokensBreakdown || {};
    acc.input += b.input || 0;
    acc.output += b.output || 0;
    acc.cacheRead += b.cacheRead || 0;
    acc.cacheWrite += b.cacheWrite || 0;
    acc.reasoning += b.reasoning || 0;
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  const sum = totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning;
  const pct = (v) => sum > 0 ? (v / sum) * 100 : 0;
  $('#breakdown-body').innerHTML = `
    <div style="display: grid; gap: 10px;">
      <div class="stacked-bar" title="Input / Output / Cache read / Cache write / Reasoning">
        <span class="seg-input" style="width:${pct(totals.input).toFixed(2)}%"></span>
        <span class="seg-output" style="width:${pct(totals.output).toFixed(2)}%"></span>
        <span class="seg-cr" style="width:${pct(totals.cacheRead).toFixed(2)}%"></span>
        <span class="seg-cw" style="width:${pct(totals.cacheWrite).toFixed(2)}%"></span>
        <span class="seg-r" style="width:${pct(totals.reasoning).toFixed(2)}%"></span>
      </div>
      <div class="chart-legend" style="padding: 0;">
        <span><span class="swatch" style="background: var(--accent);"></span>Input ${fmtTokens(totals.input)}</span>
        <span><span class="swatch" style="background: var(--green);"></span>Output ${fmtTokens(totals.output)}</span>
        <span><span class="swatch" style="background: var(--purple);"></span>Cache read ${fmtTokens(totals.cacheRead)}</span>
        <span><span class="swatch" style="background: var(--yellow);"></span>Cache write ${fmtTokens(totals.cacheWrite)}</span>
        <span><span class="swatch" style="background: var(--red);"></span>Reasoning ${fmtTokens(totals.reasoning)}</span>
      </div>
    </div>
  `;
}

// ---- Charts: token throughput over time -------------------------------

let chartState = {
  series: { input: [], output: [], cacheRead: [] },
  maxPoints: 240,    // 4 minutes at 1s tick
};

function pushChartPoint(entry) {
  const t = entry.tokens || {};
  if (!entry.timestamp) return;
  const ts = new Date(entry.timestamp).getTime();
  if (Number.isNaN(ts)) return;
  if (t.input == null && t.output == null && t.cacheRead == null) return;
  chartState.series.input.push({ t: ts, v: t.input || 0 });
  chartState.series.output.push({ t: ts, v: t.output || 0 });
  chartState.series.cacheRead.push({ t: ts, v: t.cacheRead || 0 });
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const key of Object.keys(chartState.series)) {
    chartState.series[key] = chartState.series[key].filter((p) => p.t >= cutoff);
    if (chartState.series[key].length > chartState.maxPoints) {
      chartState.series[key] = chartState.series[key].slice(-chartState.maxPoints);
    }
  }
}

function renderOverviewChart() {
  const host = $('#overview-chart');
  if (!host) return;
  const series = chartState.series;
  const all = [...series.input, ...series.output, ...series.cacheRead];
  if (all.length < 2) {
    host.innerHTML = `<div style="height: 220px; display: flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: 12px; font-family: var(--font-mono);">Waiting for token activity…</div>`;
    return;
  }
  host.innerHTML = lineChartSvg(series, { width: 560, height: 220, padding: { top: 8, right: 12, bottom: 24, left: 40 } });
}

const scheduleOverviewChart = rAFThrottle(() => {
  if (state.currentPage === 'overview') renderOverviewChart();
});

function lineChartSvg(series, opts) {
  const { width, height, padding } = opts;
  const all = [...series.input, ...series.output, ...series.cacheRead];
  const tMin = Math.min(...all.map((p) => p.t));
  const tMax = Math.max(...all.map((p) => p.t));
  const vMax = Math.max(1, ...all.map((p) => p.v));
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const x = (t) => padding.left + ((t - tMin) / Math.max(1, tMax - tMin)) * innerW;
  const y = (v) => padding.top + innerH - (v / vMax) * innerH;

  const grid = [];
  for (let i = 0; i <= 4; i++) {
    const yy = padding.top + (innerH / 4) * i;
    grid.push(`<line x1="${padding.left}" y1="${yy}" x2="${width - padding.right}" y2="${yy}"/>`);
  }

  const path = (pts) => {
    if (pts.length === 0) return '';
    return pts.map((p, i) => (i === 0 ? 'M' : 'L') + x(p.t).toFixed(1) + ',' + y(p.v).toFixed(1)).join(' ');
  };
  const area = (pts) => {
    if (pts.length === 0) return '';
    const start = `M${x(pts[0].t).toFixed(1)},${(padding.top + innerH).toFixed(1)}`;
    const line = pts.map((p) => 'L' + x(p.t).toFixed(1) + ',' + y(p.v).toFixed(1)).join(' ');
    const end = `L${x(pts[pts.length - 1].t).toFixed(1)},${(padding.top + innerH).toFixed(1)} Z`;
    return start + ' ' + line + ' ' + end;
  };

  const fmt = (t) => new Date(t).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <g class="grid">${grid.join('')}</g>
      <g class="axis">
        <text x="${padding.left}" y="${height - 6}">${fmt(tMin)}</text>
        <text x="${width - padding.right}" y="${height - 6}" text-anchor="end">${fmt(tMax)}</text>
        <text x="4" y="${padding.top + 8}">${fmtTokens(vMax)}</text>
        <text x="4" y="${padding.top + innerH}">0</text>
      </g>
      <path class="series-cachewrite series-fill" d="${area(series.cacheRead)}"/>
      <path class="series-cachewrite series" d="${path(series.cacheRead)}"/>
      <path class="series-input series-fill" d="${area(series.input)}"/>
      <path class="series-input series" d="${path(series.input)}"/>
      <path class="series-output series" d="${path(series.output)}"/>
    </svg>
  `;
}

function sparklineSvg(values, opts = {}) {
  const width = opts.width || 140;
  const height = opts.height || 28;
  if (values.length < 2) {
    return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"></svg>`;
  }
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = Math.max(1, max - min);
  const stepX = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`);
  const area = `M0,${height} L${pts.join(' L')} L${width},${height} Z`;
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <path class="area" d="${area}"/>
    <polyline points="${pts.join(' ')}"/>
  </svg>`;
}

// Per-key request rate rolling window
const requestRateByKey = new Map();
function recordRequestTick(entry) {
  const k = entry.meta?.keyId;
  if (!k) return;
  if (!requestRateByKey.has(k)) requestRateByKey.set(k, []);
  const arr = requestRateByKey.get(k);
  arr.push(Date.now());
  const cutoff = Date.now() - 5 * 60 * 1000;
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();
}

// ---------------------------------------------------------------------------
// Page: Accounts
// ---------------------------------------------------------------------------

function renderAccounts() {
  const host = $('#account-list');
  if (!host) return;
  if (state.keys.length === 0) {
    host.innerHTML = `
      <div class="empty-state">
        <strong>No accounts yet</strong>
        Add your first OpenCode Go API key to start routing traffic across multiple accounts.
        <div style="margin-top: 14px;">
          <button class="btn btn-primary" onclick="document.getElementById('add-key-btn').click()">+ Add key</button>
        </div>
      </div>
    `;
    return;
  }
  host.innerHTML = state.keys.map(renderAccountCard).join('');
  initAccountCardHandlers(host);
}

function renderAccountCard(key) {
  const b = key.quota?.tokensBreakdown || {};
  const total = (b.input || 0) + (b.output || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) + (b.reasoning || 0);
  const pct = (v) => total > 0 ? (v / total) * 100 : 0;
  const recent = (requestRateByKey.get(key.id) || []).slice(-30).map((t) => 1);
  const lastModel = key.lastModel || '—';
  const cooldown = key.cooldownUntil && key.cooldownUntil > Date.now()
    ? `<span class="account-cooldown">cooldown ${fmtCooldown(key.cooldownUntil)}</span>` : '';
  const status = key.enabled ? (key.status === 'cooldown' ? 'cooldown' : 'active') : 'drained';
  const statusChip = key.enabled
    ? (key.status === 'cooldown' ? '<span class="chip chip-yellow">cooldown</span>' : '<span class="chip chip-green">active</span>')
    : '<span class="chip chip-muted">drained</span>';

  return `
    <article class="account-card ${key.enabled ? '' : 'is-muted'}" data-id="${key.id}">
      <div class="drag-handle" draggable="true" title="Drag to reorder">⋮⋮</div>

      <div class="account-primary">
        <h3 class="account-alias" contenteditable="true" spellcheck="false" data-alias-id="${key.id}">${escapeHtml(key.alias)}</h3>
        <div class="account-masked">
          <code>${escapeHtml(key.masked)}</code>
          <button class="btn btn-ghost btn-sm" data-action="reveal" data-id="${key.id}">Replace key</button>
        </div>
        <div class="account-actions" style="margin-top: 8px;">
          ${statusChip}
          ${cooldown}
        </div>
      </div>

      <div class="account-meta">
        <div class="account-meta-row">
          <span><span class="label">Pri</span><strong>#${key.priority}</strong></span>
          <span><span class="label">Wt</span><strong>${key.weight}</strong></span>
          <span><span class="label">Req</span><strong>${fmtTokens(key.requestCount)}</strong></span>
          <span><span class="label">Err</span><strong>${fmtTokens(key.errorCount)}</strong></span>
          <span><span class="label">Lat</span><strong>${key.averageLatencyMs ? `${Math.round(key.averageLatencyMs)}ms` : '—'}</strong></span>
          <span><span class="label">Last</span><strong>${escapeHtml(lastModel)}</strong></span>
        </div>
        <div class="account-meta-row">
          <span><span class="label">7d</span><strong>${fmtTokens(key.recentUsage?.last7d?.totalTokens || 0)} tok</strong></span>
          <span><span class="label">30d</span><strong>${fmtTokens(key.recentUsage?.last30d?.totalTokens || 0)} tok</strong></span>
          <span><span class="label">Mo</span><strong>${fmtTokens(key.recentUsage?.calendarMonth?.totalTokens || 0)} tok</strong></span>
        </div>
      </div>

      <div class="account-stat-bar">
        <div class="account-sparkline-wrap">
          <span class="account-sparklabel">5m req</span>
          ${sparklineSvg(recent)}
        </div>
        <div class="account-stackedwrap">
          <div class="stacked-bar" title="Token breakdown for this account (all time)">
            <span class="seg-input" style="width:${pct(b.input || 0).toFixed(2)}%"></span>
            <span class="seg-output" style="width:${pct(b.output || 0).toFixed(2)}%"></span>
            <span class="seg-cr" style="width:${pct(b.cacheRead || 0).toFixed(2)}%"></span>
            <span class="seg-cw" style="width:${pct(b.cacheWrite || 0).toFixed(2)}%"></span>
            <span class="seg-r" style="width:${pct(b.reasoning || 0).toFixed(2)}%"></span>
          </div>
          <span class="account-legend-mini">I ${fmtTokens(b.input || 0)} · O ${fmtTokens(b.output || 0)} · CR ${fmtTokens(b.cacheRead || 0)}</span>
        </div>
        <div class="account-actions">
          <button class="btn btn-sm" data-action="reset" data-id="${key.id}">Reset cooldown</button>
          <div class="toggle ${key.enabled ? 'on' : ''}" data-action="toggle" data-id="${key.id}" role="switch" aria-checked="${key.enabled}"></div>
          <button class="btn btn-sm btn-danger" data-action="remove" data-id="${key.id}">Remove</button>
        </div>
      </div>
    </article>
  `;
}

function initAccountCardHandlers(host) {
  // Toggle
  $$('.toggle[data-action="toggle"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const key = state.keys.find((k) => k.id === id);
      if (!key) return;
      const enabled = !key.enabled;
      el.classList.toggle('on', enabled);
      try {
        await api.toggleKey(id, enabled);
        toast(enabled ? 'Key enabled' : 'Key drained', 'info');
        await refreshKeys();
      } catch (err) {
        el.classList.toggle('on', !enabled);
        toast(err.message, 'error');
      }
    });
  });

  // Reset cooldown
  $$('button[data-action="reset"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      try { await api.resetCooldown(el.dataset.id); toast('Cooldown reset', 'success'); await refreshKeys(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });

  // Remove
  $$('button[data-action="remove"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      const key = state.keys.find((k) => k.id === el.dataset.id);
      if (!key) return;
      if (!confirm(`Remove "${key.alias}"? This deletes the API key from this device.`)) return;
      try { await api.removeKey(el.dataset.id); toast('Key removed', 'success'); await refreshKeys(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });

  // Inline alias edit
  $$('.account-alias', host).forEach((el) => {
    const id = el.dataset.aliasId;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') {
        const key = state.keys.find((k) => k.id === id);
        el.textContent = key ? key.alias : el.textContent;
        el.blur();
      }
    });
    el.addEventListener('blur', async () => {
      const newAlias = el.textContent.trim();
      const key = state.keys.find((k) => k.id === id);
      if (!key || newAlias === key.alias) {
        if (key) el.textContent = key.alias;
        return;
      }
      try {
        await api.updateKey(id, { alias: newAlias });
        toast('Renamed', 'success');
        await refreshKeys();
      } catch (err) {
        toast(err.message, 'error');
        el.textContent = key.alias;
      }
    });
  });

  // Replace-key popover
  $$('button[data-action="reveal"]', host).forEach((btn) => {
    btn.addEventListener('click', (e) => openReplacePopover(btn, e));
  });

  // Drag-and-drop reordering
  initAccountDragDrop(host);
}

function openReplacePopover(anchor, evt) {
  closeAllPopovers();
  const id = anchor.dataset.id;
  const pop = document.createElement('div');
  pop.className = 'account-replace-popover';
  pop.innerHTML = `
    <div style="font-size: 12px; color: var(--text-muted); font-family: var(--font-sans);">Replace the stored API key for this account. Stats and alias are kept.</div>
    <input class="input input-mono" placeholder="Paste new OpenCode Go API key" autocomplete="off">
    <div style="display: flex; justify-content: flex-end; gap: 6px;">
      <button class="btn btn-sm" data-popover="cancel">Cancel</button>
      <button class="btn btn-sm btn-primary" data-popover="save">Save</button>
    </div>
  `;
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.position = 'absolute';
  pop.style.top = (window.scrollY + rect.bottom + 4) + 'px';
  pop.style.left = (window.scrollX + rect.left) + 'px';
  const input = pop.querySelector('input');
  setTimeout(() => input.focus(), 30);

  const cleanup = () => pop.remove();
  pop.querySelector('[data-popover="cancel"]').addEventListener('click', cleanup);
  pop.querySelector('[data-popover="save"]').addEventListener('click', async () => {
    const k = input.value.trim();
    if (!k) { toast('Key is required', 'error'); return; }
    try {
      await api.replaceKey(id, k);
      toast('Key replaced', 'success');
      cleanup();
      await refreshKeys();
    } catch (err) { toast(err.message, 'error'); }
  });
  setTimeout(() => {
    document.addEventListener('click', function onDoc(ev) {
      if (!pop.contains(ev.target)) {
        cleanup();
        document.removeEventListener('click', onDoc);
      }
    });
  }, 50);
}

function closeAllPopovers() {
  $$('.account-replace-popover').forEach((el) => el.remove());
}

function initAccountDragDrop(host) {
  const cards = $$('.account-card', host);
  let dragId = null;
  cards.forEach((card) => {
    const handle = card.querySelector('.drag-handle');
    if (!handle) return;
    handle.addEventListener('dragstart', (e) => {
      dragId = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    handle.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $$('.account-card', host).forEach((c) => c.classList.remove('drop-target'));
      dragId = null;
    });
    card.addEventListener('dragover', (e) => {
      if (!dragId || dragId === card.dataset.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.account-card', host).forEach((c) => c.classList.remove('drop-target'));
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drop-target');
      if (!dragId || dragId === card.dataset.id) return;
      const newOrder = state.keys.map((k) => k.id);
      const from = newOrder.indexOf(dragId);
      const to = newOrder.indexOf(card.dataset.id);
      newOrder.splice(from, 1);
      newOrder.splice(to, 0, dragId);
      try {
        await api.reorderKeys(newOrder);
        toast('Priority updated', 'success');
        await refreshKeys();
      } catch (err) {
        toast(err.message || 'Reorder failed', 'error');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Page: Routing
// ---------------------------------------------------------------------------

function renderRouting() {
  const heroHost = $('#strategy-hero-host');
  const gridHost = $('#strategy-grid-host');
  if (!heroHost || !gridHost) return;
  const current = state.strategies.find((s) => s.value === state.activeStrategy);
  if (current) {
    heroHost.innerHTML = `
      <div class="strategy-hero">
        <div>
          <h3>${escapeHtml(current.label)}</h3>
          <p>${escapeHtml(current.description)}</p>
          <div class="strategy-facts">
            <div>
              <div class="label">Best for</div>
              <strong>${escapeHtml(current.bestFor)}</strong>
            </div>
            <div>
              <div class="label">How it works</div>
              <strong>${escapeHtml(current.behavior)}</strong>
            </div>
          </div>
        </div>
        <div class="badges">
          <span class="chip ${current.cacheFriendly ? 'chip-accent' : 'chip-muted'}">${current.cacheFriendly ? 'Cache-friendly' : 'Load-spreading'}</span>
          <span class="chip ${current.usesPriority ? 'chip-purple' : 'chip-muted'}">${current.usesPriority ? 'Uses priority' : 'Priority ignored'}</span>
          <span class="chip ${current.usesWeight ? 'chip-yellow' : 'chip-muted'}">${current.usesWeight ? 'Uses weight' : 'Weight ignored'}</span>
        </div>
      </div>
    `;
  } else {
    heroHost.innerHTML = '';
  }
  gridHost.innerHTML = state.strategies.map((s) => `
    <button class="strategy-card ${s.value === state.activeStrategy ? 'active' : ''}" data-strategy="${s.value}">
      <div class="name">
        <span>${escapeHtml(s.label)}</span>
        ${s.recommended ? '<span class="chip chip-green">Recommended</span>' : ''}
      </div>
      <div class="desc">${escapeHtml(s.description)}</div>
      <div class="best">${escapeHtml(s.bestFor)}</div>
    </button>
  `).join('');
  $$('.strategy-card', gridHost).forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        await api.setStrategy(el.dataset.strategy);
        state.activeStrategy = el.dataset.strategy;
        $('#footer-strategy').textContent = state.activeStrategy.replace(/_/g, ' ');
        toast(`Switched to ${el.dataset.strategy.replace(/_/g, ' ')}`, 'info');
        renderRouting();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// ---------------------------------------------------------------------------
// Page: Logs (virtualized)
// ---------------------------------------------------------------------------

const LOG_ROW_H = 32;
const LOG_OVERSCAN = 6;
let logRenderPending = false;
let logFollow = true;

function getFilteredLogs() {
  const search = state.logFilter.search.trim().toLowerCase();
  const level = state.logFilter.level;
  const all = [...state.archivedLogs, ...state.recentLogs];
  if (!search && !level) return all;
  return all.filter((e) => {
    if (level && (e.level || 'info') !== level) return false;
    if (!search) return true;
    const m = e.meta || {};
    const haystack = [
      e.message || '',
      m.path || '',
      m.method || '',
      m.keyAlias || '',
      m.model || '',
      m.routeReason || '',
      m.statusCode || '',
    ].join(' ').toLowerCase();
    return haystack.includes(search);
  });
}

function ensureLogRender() {
  if (logRenderPending) return;
  logRenderPending = true;
  requestAnimationFrame(() => {
    logRenderPending = false;
    renderLogs();
  });
}

const scheduleLogRender = rAFThrottle(ensureLogRender);

function renderLogs() {
  const body = $('#log-body');
  if (!body) return;
  const rows = $('#log-rows');
  const topSpacer = $('#log-spacer-top');
  const botSpacer = $('#log-spacer-bot');
  if (!rows || !topSpacer || !botSpacer) return;

  const filtered = getFilteredLogs();
  const totalH = filtered.length * LOG_ROW_H;
  const scrollTop = body.scrollTop;
  const viewportH = body.clientHeight || 480;
  const first = Math.max(0, Math.floor(scrollTop / LOG_ROW_H) - LOG_OVERSCAN);
  const visible = Math.ceil(viewportH / LOG_ROW_H) + LOG_OVERSCAN * 2;
  const last = Math.min(filtered.length, first + visible);

  topSpacer.style.height = (first * LOG_ROW_H) + 'px';
  botSpacer.style.height = Math.max(0, totalH - last * LOG_ROW_H) + 'px';

  const slice = filtered.slice(first, last);
  rows.innerHTML = slice.map((entry, i) => renderLogRow(entry, first + i)).join('');

  if (logFollow) body.scrollTop = body.scrollHeight;

  // Count
  const totalAll = state.archivedLogs.length + state.recentLogs.length;
  $('#logs-count').textContent = `${fmtNumber(filtered.length)} of ${fmtNumber(totalAll)} entries`;
  $('#logs-status').textContent = state.paused ? 'Paused (buffered)' : 'Live';
}

function renderLogRow(entry, idx) {
  const m = entry.meta || {};
  const status = m.statusCode || '';
  const statusClass = status >= 500 ? 'status-5xx'
    : status >= 400 ? 'status-4xx'
    : status >= 300 ? 'status-3xx'
    : status >= 200 ? 'status-2xx' : '';
  const tokens = m.tokens;
  const tokenText = tokens
    ? `I:${tokens.input || 0} O:${tokens.output || 0} CR:${tokens.cacheRead || 0} CW:${tokens.cacheWrite || 0} R:${tokens.reasoning || 0}`
    : '';
  const expanded = state.expandedLogId === entry.__id;
  return `
    <div class="log-row ${expanded ? 'expanded' : ''}" data-log-id="${entry.__id}" data-log-idx="${idx}">
      <span class="cell time">${escapeHtml(fmtTime(entry.timestamp))}</span>
      <span class="cell level level-${escapeHtml(entry.level || 'info')}">${escapeHtml((entry.level || 'info').toUpperCase())}</span>
      <span class="cell method">${escapeHtml(m.method || '')}</span>
      <span class="cell path" title="${escapeHtml(m.path || '')}">${escapeHtml(m.path || '')}</span>
      <span class="cell status ${statusClass}">${escapeHtml(status ? String(status) : '')}</span>
      <span class="cell key">${escapeHtml(m.keyAlias || '')}</span>
      <span class="cell model" title="${escapeHtml(m.model || '')}">${escapeHtml(m.model || '')}</span>
      <span class="cell reason" title="${escapeHtml(m.routeReason || entry.message || '')}">${escapeHtml(m.routeReason || entry.message || '')}</span>
      <span class="cell tokens">${escapeHtml(tokenText)}</span>
      <span class="cell cost">${m.cost != null ? escapeHtml(fmtCurrency(m.cost)) : ''}</span>
      ${expanded ? `<div class="log-detail">${escapeHtml(JSON.stringify(entry, null, 2))}</div>` : ''}
    </div>
  `;
}

function initLogsToolbar() {
  $('#logs-pause').addEventListener('click', () => {
    state.paused = !state.paused;
    $('#logs-pause').textContent = state.paused ? 'Resume' : 'Pause';
    if (!state.paused && state.pausedBuffer.length) {
      for (const e of state.pausedBuffer) ingestLog(e, { initial: true });
      state.pausedBuffer = [];
    }
    ensureLogRender();
  });
  $('#logs-clear').addEventListener('click', () => {
    state.archivedLogs = [];
    state.recentLogs = [];
    state.expandedLogId = null;
    ensureLogRender();
  });
  $('#logs-download').addEventListener('click', () => {
    const all = [...state.archivedLogs, ...state.recentLogs];
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `router-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#log-body').addEventListener('click', (e) => {
    const row = e.target.closest('.log-row');
    if (!row) return;
    const id = row.dataset.logId;
    state.expandedLogId = state.expandedLogId === id ? null : id;
    ensureLogRender();
  });
  $('#log-body').addEventListener('scroll', () => {
    const body = $('#log-body');
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 20;
    logFollow = atBottom;
    ensureLogRender();
  });
}

function initSearch() {
  const input = $('#logs-search');
  if (!input) return;
  const handler = debounce(() => {
    state.logFilter.search = input.value;
    ensureLogRender();
  }, 120);
  input.addEventListener('input', handler);

  // Level filter chips
  $$('#logs-levels .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#logs-levels .filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.logFilter.level = chip.dataset.level || '';
      ensureLogRender();
    });
  });
}

// ---------------------------------------------------------------------------
// Page: Settings
// ---------------------------------------------------------------------------

async function renderSettings() {
  const table = $('#config-table');
  if (!table) return;
  const [status, current] = await Promise.all([api.status(), api.currentStrategy()]);
  const ports = window.location.port ? `:${window.location.port}` : '';
  const baseUrl = `${location.protocol}//${location.hostname}${ports === ':18904' ? ':18905' : ports}`;
  const proxyHost = `${location.protocol}//${location.hostname}:18905`;

  const rows = [
    ['Proxy URL', proxyHost],
    ['Dashboard URL', `${location.protocol}//${location.host}${location.port ? ':' + location.port : ''}`],
    ['Active strategy', current.strategy],
    ['Enabled keys', String(status.summary.enabledKeys)],
    ['Total requests (session)', fmtNumber(status.summary.totalRequests)],
    ['Total cost (session)', fmtCurrency(status.summary.estimatedCost)],
  ];
  table.innerHTML = rows.map(([k, v]) => `
    <div class="config-key">${escapeHtml(k)}</div>
    <div class="config-val">${escapeHtml(v)}</div>
  `).join('');

  $('#provider-config').value = JSON.stringify({
    provider: {
      'opencode-go': { options: { baseURL: proxyHost } },
    },
  }, null, 2);

  $('#copy-provider-config').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#provider-config').value);
      toast('Copied', 'success');
    } catch {
      $('#provider-config').select();
      document.execCommand('copy');
      toast('Copied', 'success');
    }
  };

  $('#settings-meta').textContent = `Snapshot at ${fmtDateTime(new Date().toISOString())}`;
  $('#footer-dashboard').textContent = `:${location.port || 18904}`;
  $('#footer-proxy').textContent = ':18905';
}

// Render settings on first visit
on('settings:first-visit', renderSettings);
