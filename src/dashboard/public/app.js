const API_BASE = ''
let ws = null
let logsVisible = true

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
    appendLog(entry)
  }
}

function appendLog(entry) {
  const viewer = document.getElementById('log-viewer')
  const div = document.createElement('div')
  div.className = 'log-entry'
  div.innerHTML = `<span class="timestamp">${entry.timestamp}</span><span class="level ${entry.level}">${entry.level.toUpperCase()}</span>${entry.message}`
  viewer.appendChild(div)
  viewer.scrollTop = viewer.scrollHeight
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
    if (keys.length === 0) {
      list.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No API keys added yet. Click "+ Add Key" to get started.</p>'
      return
    }
    list.innerHTML = keys.map(k => `
      <div class="key-item">
        <div class="key-info">
          <span class="key-alias">${k.alias}</span>
          <span class="key-masked">${k.masked}</span>
        </div>
        <div>
          <span class="key-status ${k.status}">${k.status}</span>
          <button class="btn btn-danger" style="margin-left: 8px; padding: 4px 10px; font-size: 12px;" onclick="removeKey('${k.id}')">Remove</button>
        </div>
      </div>
    `).join('')
  } catch {}
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
      return `
        <div class="status-card">
          <div class="status-card-header">
            <span class="status-card-title">${k.alias}</span>
            <span class="health-indicator ${k.health}"></span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary);">
            <span>Status: ${k.status}</span>
            <span>Tokens: ${k.tokensUsed.toLocaleString()}</span>
            <span>Cost: $${k.costAccumulated.toFixed(4)}</span>
          </div>
          <div class="quota-bar">
            <div class="quota-fill ${fillClass}" style="width: ${pct}%"></div>
          </div>
          <div class="quota-label">
            <span>Used: $${k.quota.costAccumulated.toFixed(2)}</span>
            <span>Remaining: $${k.quota.remaining.toFixed(2)}</span>
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
