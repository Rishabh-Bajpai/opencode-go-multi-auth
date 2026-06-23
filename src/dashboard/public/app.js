const API_BASE = ''
let ws = null
let paused = false
let logBuffer = []
let strategyInfo = []
let activeStrategy = ''

function emptyWindow() {
  return {
    cost: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  connectWebSocket()
  setupEventListeners()
  await Promise.all([loadStrategies(), loadKeys(), loadStatus()])
  setInterval(loadStatus, 5000)
  setInterval(loadKeys, 10000)
})

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws/logs`)

  ws.onopen = () => {
    const badge = document.getElementById('status-badge')
    badge.textContent = 'Connected'
    badge.className = 'status-pill connected'
  }

  ws.onclose = () => {
    const badge = document.getElementById('status-badge')
    badge.textContent = 'Disconnected'
    badge.className = 'status-pill'
    setTimeout(connectWebSocket, 2000)
  }

  ws.onmessage = (event) => {
    const entry = JSON.parse(event.data)
    if (paused) {
      logBuffer.push(entry)
    } else {
      appendLog(entry)
    }
  }
}

async function fetchApi(path, options = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error || res.statusText)
    }
    return await res.json()
  } catch (err) {
    showToast(err.message || 'Request failed', 'error')
    throw err
  }
}

async function loadStrategies() {
  const [strategiesResponse, strategyResponse] = await Promise.all([
    fetchApi('/api/strategies'),
    fetchApi('/api/strategy'),
  ])

  strategyInfo = strategiesResponse.strategies || []
  activeStrategy = strategyResponse.strategy

  const select = document.getElementById('strategy-select')
  select.innerHTML = strategyInfo
    .map((strategy) => `<option value="${strategy.value}">${strategy.label}</option>`)
    .join('')
  select.value = activeStrategy
  renderStrategyViews()
}

async function loadKeys() {
  const keys = await fetchApi('/api/keys')
  renderKeyFilter(keys)
  renderKeys(keys)
}

async function loadStatus() {
  const data = await fetchApi('/api/status')
  renderSummary(data.summary || {})
  renderLedger(data.keys || [])
}

function renderSummary(summary) {
  const grid = document.getElementById('summary-grid')
  const actual = summary.actualUsage || {}
  const trailing7d = actual.trailing7d || emptyWindow()
  const calendarMonth = actual.calendarMonth || emptyWindow()
  const rolling30d = actual.rolling30d || emptyWindow()
  const items = [
    ['Enabled Keys', summary.enabledKeys ?? 0],
    ['Active Now', summary.activeKeys ?? 0],
    ['Cooldown Keys', summary.cooldownKeys ?? 0],
    ['Requests Seen', formatNumber(summary.totalRequests ?? 0)],
    ['Router Tokens', formatNumber(summary.totalTokens ?? 0)],
    ['OpenCode 7d', formatCurrency(trailing7d.cost)],
    ['OpenCode Month', formatCurrency(calendarMonth.cost)],
    ['OpenCode Rolling 30d', formatCurrency(rolling30d.cost)],
  ]

  grid.innerHTML = items.map(([label, value]) => `
    <div class="metric-chip">
      <span class="metric-label">${label}</span>
      <strong class="metric-value">${value}</strong>
    </div>
  `).join('')
}

function renderKeyFilter(keys) {
  const keyFilter = document.getElementById('filter-key')
  const currentValue = keyFilter.value
  keyFilter.innerHTML = '<option value="">All Keys</option>' + keys.map((key) => `
    <option value="${key.alias}">${key.alias}</option>
  `).join('')
  keyFilter.value = currentValue
}

function renderKeys(keys) {
  const list = document.getElementById('key-list')
  if (!keys.length) {
    list.innerHTML = '<p class="empty-state">No keys yet. Add your first OpenCode Go account to start routing traffic.</p>'
    return
  }

  const total30dTokens = keys.reduce((sum, key) => sum + Number(key.recentUsage?.last30d?.totalTokens || 0), 0)
  list.innerHTML = keys.map((key) => {
    const last30dTokens = Number(key.recentUsage?.last30d?.totalTokens || 0)
    const activityPercent = total30dTokens > 0 ? Math.round((last30dTokens / total30dTokens) * 100) : 0
    return `
      <article class="key-card ${key.enabled ? '' : 'is-muted'}">
        <div class="key-card-top">
          <div>
            <p class="key-alias">${escapeHtml(key.alias)}</p>
            <p class="key-subline">${key.masked} • ${key.enabled ? 'Enabled' : 'Drained'} • ${key.status}</p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" ${key.enabled ? 'checked' : ''} onchange="toggleKey('${key.id}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="key-metrics-row">
          <div><span>Priority</span><strong>#${key.priority}</strong></div>
          <div><span>Weight</span><strong>${key.weight}</strong></div>
          <div><span>Requests</span><strong>${formatNumber(key.requestCount)}</strong></div>
          <div><span>Avg latency</span><strong>${key.averageLatencyMs ? `${Math.round(key.averageLatencyMs)}ms` : '—'}</strong></div>
        </div>

        <div class="key-edit-grid">
          <label>
            <span>Alias</span>
            <input class="input slim" value="${escapeAttribute(key.alias)}" data-alias-id="${key.id}">
          </label>
          <label>
            <span>Priority</span>
            <input class="input slim" type="number" min="1" value="${key.priority}" data-priority-id="${key.id}">
          </label>
          <label>
            <span>Weight</span>
            <input class="input slim" type="number" min="1" value="${key.weight}" data-weight-id="${key.id}">
          </label>
        </div>

        <div class="key-actions-row">
          <button class="btn btn-secondary" onclick="saveKeySettings('${key.id}')">Save settings</button>
          <button class="btn btn-secondary" onclick="resetCooldown('${key.id}')">Reset cooldown</button>
          <button class="btn btn-danger" onclick="removeKey('${key.id}')">Remove</button>
        </div>

        <div class="quota-strip">
          <div class="quota-bar"><div class="quota-fill" style="width:${Math.min(100, activityPercent)}%"></div></div>
          <div class="quota-copy">
            <span>Observed 30d tokens ${formatNumber(last30dTokens)}</span>
            <span>Observed 7d requests ${formatNumber(key.recentUsage?.last7d?.requests ?? 0)}</span>
          </div>
        </div>
      </article>
    `
  }).join('')
}

function renderLedger(keys) {
  const ledger = document.getElementById('status-ledger')
  if (!keys.length) {
    ledger.innerHTML = '<p class="empty-state">Add keys to see usage, session stickiness, and routing health.</p>'
    return
  }

  ledger.innerHTML = keys.map((key) => {
    const quota = key.quota || {}
    const breakdown = quota.tokensBreakdown || {}
    return `
      <article class="ledger-card ${key.enabled ? '' : 'is-muted'}">
        <div class="ledger-head">
          <div>
            <p class="ledger-title">${escapeHtml(key.alias)}</p>
            <p class="ledger-subtitle">${key.lastModel || 'No model yet'} • ${key.health}</p>
          </div>
          <span class="health-indicator ${key.enabled ? key.health : 'disabled'}"></span>
        </div>

        <div class="ledger-stats">
          <div><span>Status</span><strong>${key.status}</strong></div>
          <div><span>Tokens</span><strong>${formatNumber(key.tokensUsed)}</strong></div>
          <div><span>Success / Error</span><strong>${formatNumber(key.successCount)} / ${formatNumber(key.errorCount)}</strong></div>
          <div><span>Last used</span><strong>${formatDateTime(key.lastUsedAt)}</strong></div>
        </div>

        <div class="ledger-stats">
          <div><span>7d tokens</span><strong>${formatNumber(key.recentUsage?.last7d?.totalTokens ?? 0)}</strong></div>
          <div><span>30d tokens</span><strong>${formatNumber(key.recentUsage?.last30d?.totalTokens ?? 0)}</strong></div>
          <div><span>Month tokens</span><strong>${formatNumber(key.recentUsage?.calendarMonth?.totalTokens ?? 0)}</strong></div>
          <div><span>Est. quota spend</span><strong>${formatCurrency(key.quota?.costAccumulated)}</strong></div>
        </div>

        <div class="token-breakdown">
          <span>I ${formatNumber(breakdown.input || 0)}</span>
          <span>O ${formatNumber(breakdown.output || 0)}</span>
          <span>CR ${formatNumber(breakdown.cacheRead || 0)}</span>
          <span>CW ${formatNumber(breakdown.cacheWrite || 0)}</span>
          <span>R ${formatNumber(breakdown.reasoning || 0)}</span>
        </div>

        <div class="ledger-foot">
          <span>Cooldown: ${formatCooldown(key.cooldownUntil)}</span>
          <span>Session: ${key.lastSessionId ? escapeHtml(key.lastSessionId) : '—'}</span>
        </div>
      </article>
    `
  }).join('')
}

function renderStrategyViews() {
  const current = strategyInfo.find((entry) => entry.value === activeStrategy)
  const explainer = document.getElementById('strategy-explainer')
  const grid = document.getElementById('strategy-grid')

  if (current) {
    explainer.innerHTML = `
      <div class="strategy-hero ${current.cacheFriendly ? 'cache-friendly' : ''}">
        <div>
          <p class="panel-kicker">Active routing behavior</p>
          <h3>${current.label}</h3>
          <p>${current.description}</p>
        </div>
        <div class="strategy-badges">
          <span class="badge ${current.cacheFriendly ? 'badge-green' : 'badge-muted'}">${current.cacheFriendly ? 'Cache-friendly' : 'Load-spreading'}</span>
          <span class="badge">${current.usesPriority ? 'Uses priority' : 'Priority ignored'}</span>
          <span class="badge">${current.usesWeight ? 'Uses weight' : 'Weight ignored'}</span>
        </div>
      </div>
      <div class="strategy-facts">
        <div>
          <span>Best for</span>
          <strong>${current.bestFor}</strong>
        </div>
        <div>
          <span>How it works</span>
          <strong>${current.behavior}</strong>
        </div>
      </div>
    `
  }

  grid.innerHTML = strategyInfo.map((strategy) => `
    <button class="strategy-card ${strategy.value === activeStrategy ? 'active' : ''}" onclick="chooseStrategy('${strategy.value}')">
      <div class="strategy-card-top">
        <span>${strategy.label}</span>
        ${strategy.recommended ? '<span class="badge badge-green">Recommended</span>' : ''}
      </div>
      <p>${strategy.description}</p>
      <small>${strategy.bestFor}</small>
    </button>
  `).join('')
}

async function chooseStrategy(strategy) {
  await fetchApi('/api/strategy', {
    method: 'PUT',
    body: JSON.stringify({ strategy }),
  })
  activeStrategy = strategy
  document.getElementById('strategy-select').value = strategy
  renderStrategyViews()
  showToast(`Strategy switched to ${strategyInfo.find((entry) => entry.value === strategy)?.label || strategy}`, 'info')
}

async function toggleKey(id, enabled) {
  await fetchApi(`/api/keys/${id}/toggle`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
  showToast(enabled ? 'Key enabled' : 'Key drained', 'info')
  await Promise.all([loadKeys(), loadStatus()])
}

async function saveKeySettings(id) {
  const alias = document.querySelector(`[data-alias-id="${id}"]`).value.trim()
  const priority = Number(document.querySelector(`[data-priority-id="${id}"]`).value)
  const weight = Number(document.querySelector(`[data-weight-id="${id}"]`).value)
  await fetchApi(`/api/keys/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ alias, priority, weight }),
  })
  showToast('Key settings saved', 'success')
  await Promise.all([loadKeys(), loadStatus()])
}

async function resetCooldown(id) {
  await fetchApi(`/api/keys/${id}/reset-cooldown`, { method: 'POST' })
  showToast('Cooldown reset', 'success')
  await Promise.all([loadKeys(), loadStatus()])
}

async function removeKey(id) {
  if (!confirm('Remove this API key?')) return
  await fetchApi(`/api/keys/${id}`, { method: 'DELETE' })
  showToast('Key removed', 'success')
  await Promise.all([loadKeys(), loadStatus()])
}

function appendLog(entry) {
  const viewer = document.getElementById('log-viewer')
  if (!applyFilters(entry)) return
  const row = document.createElement('div')
  row.className = 'log-row'
  row.dataset.level = entry.level || 'info'
  row.dataset.keyAlias = entry.meta?.keyAlias || ''
  row.dataset.path = entry.meta?.path || ''
  row.dataset.statusCode = String(entry.meta?.statusCode ?? '')

  const tokens = entry.meta?.tokens
  const tokenText = tokens
    ? [`I:${tokens.input || 0}`, `O:${tokens.output || 0}`, `CR:${tokens.cacheRead || 0}`, `CW:${tokens.cacheWrite || 0}`, `R:${tokens.reasoning || 0}`].join(' ')
    : ''

  row.innerHTML = `
    <span>${formatTime(entry.timestamp)}</span>
    <span class="level level-${entry.level || 'info'}">${(entry.level || 'info').toUpperCase()}</span>
    <span>${entry.meta?.method || ''}</span>
    <span class="path-cell">${entry.meta?.path || ''}</span>
    <span class="status-cell ${(entry.meta?.statusCode || 0) >= 400 ? 'is-error' : 'is-ok'}">${entry.meta?.statusCode ?? ''}</span>
    <span>${entry.meta?.keyAlias || ''}</span>
    <span class="path-cell">${entry.meta?.routeReason || entry.message || ''}</span>
    <span>${tokenText}</span>
    <span>${entry.meta?.cost != null ? formatCurrency(Number(entry.meta.cost)) : ''}</span>
  `

  viewer.appendChild(row)
  viewer.scrollTop = viewer.scrollHeight
}

function applyFilters(entry) {
  const pathFilter = (document.getElementById('filter-path').value || '').toLowerCase()
  const statusFilter = document.getElementById('filter-status').value
  const keyFilter = document.getElementById('filter-key').value
  const levelFilter = document.getElementById('filter-level').value

  if (pathFilter && !(entry.meta?.path || '').toLowerCase().includes(pathFilter)) return false
  if (statusFilter && String(entry.meta?.statusCode ?? '') !== statusFilter) return false
  if (keyFilter && (entry.meta?.keyAlias || '') !== keyFilter) return false
  if (levelFilter && (entry.level || '') !== levelFilter) return false
  return true
}

function refilter() {
  const viewer = document.getElementById('log-viewer')
  const rows = viewer.querySelectorAll('.log-row')
  for (const row of rows) {
    const fakeEntry = {
      level: row.dataset.level,
      meta: {
        keyAlias: row.dataset.keyAlias,
        path: row.dataset.path,
        statusCode: row.dataset.statusCode,
      },
    }
    row.style.display = applyFilters(fakeEntry) ? '' : 'none'
  }
}

function setupEventListeners() {
  document.getElementById('add-key-btn').addEventListener('click', () => {
    document.getElementById('add-key-modal').classList.add('active')
  })

  document.getElementById('modal-close').addEventListener('click', closeModal)
  document.getElementById('modal-cancel').addEventListener('click', closeModal)

  document.getElementById('modal-save').addEventListener('click', async () => {
    const key = document.getElementById('key-value-input').value.trim()
    const alias = document.getElementById('key-alias-input').value.trim()
    const priority = Number(document.getElementById('key-priority-input').value || '1')
    const weight = Number(document.getElementById('key-weight-input').value || '1')
    if (!key) {
      showToast('Please paste an API key', 'error')
      return
    }

    await fetchApi('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ key, alias: alias || undefined, priority, weight }),
    })

    document.getElementById('key-value-input').value = ''
    document.getElementById('key-alias-input').value = ''
    document.getElementById('key-priority-input').value = '1'
    document.getElementById('key-weight-input').value = '1'
    closeModal()
    showToast('Key added successfully', 'success')
    await Promise.all([loadKeys(), loadStatus()])
  })

  document.getElementById('strategy-select').addEventListener('change', async (event) => {
    await chooseStrategy(event.target.value)
  })

  document.getElementById('clear-logs-btn').addEventListener('click', () => {
    document.getElementById('log-viewer').innerHTML = ''
  })

  document.getElementById('pause-logs').addEventListener('change', (event) => {
    paused = event.target.checked
    if (!paused && logBuffer.length) {
      for (const entry of logBuffer) appendLog(entry)
      logBuffer = []
    }
  })

  document.getElementById('filter-path').addEventListener('input', refilter)
  document.getElementById('filter-status').addEventListener('input', refilter)
  document.getElementById('filter-key').addEventListener('change', refilter)
  document.getElementById('filter-level').addEventListener('change', refilter)

  document.getElementById('add-key-modal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal()
  })
}

function closeModal() {
  document.getElementById('add-key-modal').classList.remove('active')
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div')
  toast.className = `toast ${type}`
  toast.textContent = message
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 3000)
}

function formatTime(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}`
}

function formatCooldown(value) {
  if (!value) return 'None'
  const ms = value - Date.now()
  if (ms <= 0) return 'Ready'
  const minutes = Math.ceil(ms / 60000)
  return `${minutes}m remaining`
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US')
}

function formatCurrency(value) {
  return `$${Number(value || 0).toFixed(4)}`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;')
}

window.toggleKey = toggleKey
window.saveKeySettings = saveKeySettings
window.resetCooldown = resetCooldown
window.removeKey = removeKey
window.chooseStrategy = chooseStrategy
