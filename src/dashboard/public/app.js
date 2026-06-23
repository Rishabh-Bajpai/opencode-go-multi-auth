const API_BASE = ''
let ws = null
let paused = false
let logBuffer = []
let keyAliases = []

document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket()
  loadKeys()
  loadStatus()
  loadStrategy()
  setupEventListeners()
  setInterval(loadStatus, 5000)
  setInterval(loadKeys, 10000)
})

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws/logs`)

  ws.onopen = () => {
    document.getElementById('status-badge').textContent = 'Connected'
    document.getElementById('status-badge').className = 'status-badge connected'
  }

  ws.onclose = () => {
    document.getElementById('status-badge').textContent = 'Disconnected'
    document.getElementById('status-badge').className = 'status-badge'
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

function appendLog(entry) {
  const viewer = document.getElementById('log-viewer')
  if (!applyFilters(entry)) return
  const row = document.createElement('div')
  row.className = 'log-row'
  row.dataset.level = entry.level || 'info'
  row.dataset.keyAlias = entry.meta?.keyAlias || ''
  row.dataset.path = entry.meta?.path || ''
  row.dataset.statusCode = String(entry.meta?.statusCode ?? '')

  const ts = formatTime(entry.timestamp)
  const level = entry.level || 'info'
  const method = entry.meta?.method || ''
  const path = entry.meta?.path || ''
  const status = entry.meta?.statusCode ?? ''
  const keyName = entry.meta?.keyAlias || ''
  const dur = entry.meta?.duration ? `${entry.meta.duration}ms` : ''
  const tokens = entry.meta?.tokens
  const cost = entry.meta?.cost != null ? `$${Number(entry.meta.cost).toFixed(6)}` : ''

  let tokenHtml = ''
  if (tokens) {
    const parts = []
    if (tokens.input) parts.push(`i:${tokens.input}`)
    if (tokens.output) parts.push(`o:${tokens.output}`)
    if (tokens.cacheRead) parts.push(`cr:${tokens.cacheRead}`)
    if (tokens.cacheWrite) parts.push(`cw:${tokens.cacheWrite}`)
    if (tokens.reasoning) parts.push(`r:${tokens.reasoning}`)
    if (parts.length) tokenHtml = `<span class="token-badge">${parts.join(' ')}</span>`
  }

  const msg = entry.message || ''

  row.innerHTML = `
    <span class="col-time">${ts}</span>
    <span class="col-level l-${level}">${level.toUpperCase()}</span>
    <span class="col-method">${method}</span>
    <span class="col-path">${path}</span>
    <span class="col-status ${status >= 400 ? 'st-error' : status >= 300 ? 'st-warn' : 'st-ok'}">${status}</span>
    <span class="col-key">${keyName}</span>
    <span class="col-dur">${dur}</span>
    <span class="col-tokens">${tokenHtml}</span>
    <span class="col-cost">${cost}</span>
  `

  if (level === 'warn') row.style.background = 'rgba(210, 153, 34, 0.06)'
  if (level === 'error') row.style.background = 'rgba(248, 81, 73, 0.08)'

  viewer.appendChild(row)
  viewer.scrollTop = viewer.scrollHeight
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
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
      }
    }
    row.style.display = applyFilters(fakeEntry) ? '' : 'none'
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
    showToast(err.message, 'error')
    throw err
  }
}

async function loadKeys() {
  try {
    const keys = await fetchApi('/api/keys')
    const list = document.getElementById('key-list')
    keyAliases = keys.map(k => k.alias)

    const keyFilter = document.getElementById('filter-key')
    const currentVal = keyFilter.value
    keyFilter.innerHTML = '<option value="">All Keys</option>' + keys.map(k => `<option value="${k.alias}">${k.alias}</option>`).join('')
    keyFilter.value = currentVal

    if (keys.length === 0) {
      list.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No API keys added yet. Click "+ Add Key" to get started.</p>'
      return
    }
    list.innerHTML = keys.map(k => `
      <div class="key-item ${k.status === 'disabled' ? 'key-disabled' : ''}">
        <div class="key-info">
          <span class="key-alias">${k.alias}</span>
          <span class="key-masked">${k.masked}</span>
        </div>
        <div class="key-actions">
          <label class="toggle-switch" title="${k.enabled ? 'Disable' : 'Enable'} this key">
            <input type="checkbox" ${k.enabled ? 'checked' : ''} data-key-id="${k.id}" onchange="toggleKey('${k.id}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
          <span class="key-status ${k.status === 'disabled' ? 'disabled' : k.status}">${k.status === 'disabled' ? 'disabled' : k.status}</span>
          <button class="btn btn-danger" style="margin-left: 8px; padding: 4px 10px; font-size: 12px;" onclick="removeKey('${k.id}')">Remove</button>
        </div>
      </div>
    `).join('')
  } catch {}
}

async function toggleKey(id, enabled) {
  await fetchApi(`/api/keys/${id}/toggle`, { method: 'PUT' })
  showToast(enabled ? 'Key enabled' : 'Key disabled', 'info')
  loadKeys()
  loadStatus()
}

async function loadStatus() {
  try {
    const data = await fetchApi('/api/status')
    const ledger = document.getElementById('status-ledger')
    if (!data.keys || data.keys.length === 0) {
      ledger.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">Add keys to see status information.</p>'
      return
    }
    ledger.innerHTML = data.keys.map(k => {
      const pct = Math.round(k.quota.percentUsed * 100)
      const fillClass = pct > 90 ? 'danger' : pct > 75 ? 'warning' : ''
      const isDisabled = k.status === 'disabled'
      return `
        <div class="status-card ${isDisabled ? 'status-disabled' : ''}">
          <div class="status-card-header">
            <span class="status-card-title">${k.alias}</span>
            <span class="health-indicator ${isDisabled ? 'disabled' : k.health}"></span>
          </div>
          <div class="status-card-details">
            <span>Status: ${k.status}</span>
            <span>Tokens: ${k.tokensUsed.toLocaleString()}</span>
            <span>Cost: $${k.costAccumulated.toFixed(4)}</span>
          </div>
          <div class="quota-bar">
            <div class="quota-fill ${fillClass}" style="width: ${isDisabled ? 0 : pct}%"></div>
          </div>
          <div class="quota-label">
            <span>Used: $${k.quota.costAccumulated.toFixed(2)}</span>
            <span>Remaining: $${isDisabled ? '-' : k.quota.remaining.toFixed(2)}</span>
          </div>
        </div>
      `
    }).join('')
  } catch {}
}

async function loadStrategy() {
  try {
    const data = await fetchApi('/api/strategy')
    document.getElementById('strategy-select').value = data.strategy
  } catch {}
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
    if (!key) {
      showToast('Please paste an API key', 'error')
      return
    }
    await fetchApi('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ key, alias: alias || undefined }),
    })
    document.getElementById('key-value-input').value = ''
    document.getElementById('key-alias-input').value = ''
    closeModal()
    showToast('Key added successfully', 'success')
    loadKeys()
    loadStatus()
  })

  document.getElementById('strategy-select').addEventListener('change', async (e) => {
    await fetchApi('/api/strategy', {
      method: 'PUT',
      body: JSON.stringify({ strategy: e.target.value }),
    })
    showToast(`Strategy changed to ${e.target.value}`, 'info')
  })

  document.getElementById('clear-logs-btn').addEventListener('click', () => {
    document.getElementById('log-viewer').innerHTML = ''
  })

  document.getElementById('pause-logs').addEventListener('change', (e) => {
    paused = e.target.checked
    if (!paused && logBuffer.length) {
      const viewer = document.getElementById('log-viewer')
      for (const entry of logBuffer) appendLog(entry)
      logBuffer = []
    }
  })

  document.getElementById('filter-path').addEventListener('input', refilter)
  document.getElementById('filter-status').addEventListener('input', refilter)
  document.getElementById('filter-key').addEventListener('change', refilter)
  document.getElementById('filter-level').addEventListener('change', refilter)

  document.getElementById('add-key-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal()
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal()
  })
}

function closeModal() {
  document.getElementById('add-key-modal').classList.remove('active')
}

async function removeKey(id) {
  if (!confirm('Remove this API key?')) return
  await fetchApi(`/api/keys/${id}`, { method: 'DELETE' })
  showToast('Key removed', 'success')
  loadKeys()
  loadStatus()
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div')
  toast.className = `toast ${type}`
  toast.textContent = message
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 3000)
}
