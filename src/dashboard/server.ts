import express from 'express'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KeyManager } from '../router/key-manager.js'
import type { CircuitBreaker } from '../router/circuit-breaker.js'
import type { QuotaTracker } from '../router/quota-tracker.js'
import { LogStream } from '../logging/log-stream.js'
import { SecureStore } from '../storage/secure-store.js'
import { ConfigStore } from '../storage/config-store.js'
import {
  RoutingStrategy,
  ROUTING_STRATEGIES,
  normalizeRoutingStrategy,
  type ApiKey,
} from '../router/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')

export class DashboardServer {
  private app: express.Application
  private server?: http.Server
  private readonly port: number

  constructor(
    port: number,
    private keyManager: KeyManager,
    private circuitBreaker: CircuitBreaker,
    private quotaTracker: QuotaTracker,
    private logStream: LogStream,
    private secureStore: SecureStore,
    private configStore: ConfigStore,
  ) {
    this.port = port
    this.app = express()
    this.app.use(express.json())
    this.setupRoutes()
  }

  private setupRoutes(): void {
    this.app.use(express.static(PUBLIC_DIR))

    this.app.get('/api/keys', async (_req, res) => {
      res.json(this.serializeKeys())
    })

    this.app.post('/api/keys', async (req, res) => {
      const { key, alias, priority, weight, enabled } = req.body
      if (!key || typeof key !== 'string') {
        res.status(400).json({ error: 'Key is required' })
        return
      }

      const entry = this.keyManager.addKey(key, alias || undefined, {
        enabled: typeof enabled === 'boolean' ? enabled : true,
        priority: typeof priority === 'number' ? priority : 1,
        weight: typeof weight === 'number' ? weight : 1,
      })
      await this.persistKeys()
      res.json(this.serializeKey(entry))
    })

    this.app.put('/api/keys/:id', async (req, res) => {
      const { alias, enabled, priority, weight } = req.body ?? {}
      const updated = this.keyManager.updateKeySettings(req.params.id, {
        alias,
        enabled,
        priority,
        weight,
      })
      if (!updated) {
        res.status(404).json({ error: 'Key not found' })
        return
      }

      await this.persistKeys()
      res.json(this.serializeKey(updated))
    })

    this.app.put('/api/keys/:id/toggle', async (req, res) => {
      const enabled = typeof req.body?.enabled === 'boolean'
        ? req.body.enabled
        : !this.keyManager.getKeyById(req.params.id)?.enabled

      const updated = this.keyManager.setEnabled(req.params.id, enabled)
      if (!updated) {
        res.status(404).json({ error: 'Key not found' })
        return
      }

      await this.persistKeys()
      res.json(this.serializeKey(updated))
    })

    this.app.post('/api/keys/:id/reset-cooldown', (req, res) => {
      const key = this.keyManager.getKeyById(req.params.id)
      if (!key) {
        res.status(404).json({ error: 'Key not found' })
        return
      }

      this.keyManager.resetCooldown(req.params.id)
      res.json(this.serializeKey(key))
    })

    this.app.delete('/api/keys/:id', async (req, res) => {
      const key = this.keyManager.getKeyById(req.params.id)
      if (!key) {
        res.status(404).json({ error: 'Key not found' })
        return
      }

      this.keyManager.removeKey(req.params.id)
      await this.secureStore.removeKey(req.params.id)
      res.json({ success: true })
    })

    this.app.get('/api/strategy', (_req, res) => {
      const strategy = normalizeRoutingStrategy(this.configStore.get('strategy'))
      res.json({ strategy })
    })

    this.app.get('/api/strategies', (_req, res) => {
      res.json({ strategies: ROUTING_STRATEGIES })
    })

    this.app.put('/api/strategy', (req, res) => {
      const strategy = normalizeRoutingStrategy(req.body?.strategy)
      if (!Object.values(RoutingStrategy).includes(strategy)) {
        res.status(400).json({ error: 'Invalid strategy' })
        return
      }
      this.configStore.set('strategy', strategy)
      res.json({ strategy })
    })

    this.app.get('/api/status', (_req, res) => {
      const keys = this.serializeKeys()
      const summary = {
        totalKeys: keys.length,
        enabledKeys: keys.filter((key) => key.enabled).length,
        activeKeys: keys.filter((key) => key.enabled && key.status === 'active').length,
        cooldownKeys: keys.filter((key) => key.status === 'cooldown').length,
        totalRequests: keys.reduce((sum, key) => sum + key.requestCount, 0),
        totalCost: keys.reduce((sum, key) => sum + key.costAccumulated, 0),
      }
      res.json({ summary, keys })
    })

    this.app.get('/api/logs', (_req, res) => {
      res.json(this.logStream.getRecentLogs())
    })
  }

  async start(): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        resolve(this.server!)
      })
      this.server.on('error', (err) => reject(err))
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  private async persistKeys(): Promise<void> {
    await this.secureStore.saveKeys(this.keyManager.toStoredEntries())
  }

  private serializeKeys() {
    return this.keyManager.getKeys().map((key) => this.serializeKey(key))
  }

  private serializeKey(key: ApiKey) {
    const quota = this.quotaTracker.getUsageBreakdown(key.id)
    key.tokensUsed = quota.totalTokens
    key.costAccumulated = quota.costAccumulated

    return {
      id: key.id,
      alias: key.alias,
      masked: `****${key.key.slice(-4)}`,
      status: key.status,
      enabled: key.enabled,
      priority: key.priority,
      weight: key.weight,
      addedAt: key.addedAt,
      cooldownUntil: key.cooldownUntil,
      health: this.circuitBreaker.getState(key.id),
      requestCount: key.requestCount,
      successCount: key.successCount,
      errorCount: key.errorCount,
      averageLatencyMs: key.averageLatencyMs,
      lastUsedAt: key.lastUsedAt,
      lastStatusCode: key.lastStatusCode,
      lastModel: key.lastModel,
      lastSessionId: key.lastSessionId,
      tokensUsed: quota.totalTokens,
      costAccumulated: quota.costAccumulated,
      quota,
    }
  }
}
