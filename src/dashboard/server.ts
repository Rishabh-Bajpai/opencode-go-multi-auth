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
import { RoutingStrategy } from '../router/types.js'

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
      const keys = this.keyManager.getKeys().map(k => ({
        id: k.id,
        alias: k.alias,
        masked: `****${k.key.slice(-4)}`,
        status: k.status,
        enabled: k.status !== 'disabled',
        cooldownUntil: k.cooldownUntil,
        tokensUsed: k.tokensUsed,
        costAccumulated: k.costAccumulated,
      }))
      res.json(keys)
    })

    this.app.post('/api/keys', async (req, res) => {
      const { key, alias } = req.body
      if (!key || typeof key !== 'string') {
        res.status(400).json({ error: 'Key is required' })
        return
      }
      const entry = this.keyManager.addKey(key, alias || undefined)
      await this.secureStore.addKey(key, entry.alias)
      res.json(entry)
    })

    this.app.put('/api/keys/:id/toggle', (req, res) => {
      const result = this.keyManager.toggleKey(req.params.id)
      if (!result) {
        res.status(404).json({ error: 'Key not found' })
        return
      }
      res.json({ id: req.params.id, status: result.status })
    })

    this.app.delete('/api/keys/:id', async (req, res) => {
      const key = this.keyManager.getKeyById(req.params.id)
      if (!key) {
        res.status(404).json({ error: 'Key not found' })
        return
      }
      this.keyManager.removeKey(req.params.id)
      await this.secureStore.removeKey(key.alias)
      res.json({ success: true })
    })

    this.app.get('/api/strategy', (_req, res) => {
      res.json({ strategy: this.configStore.get('strategy') || 'exhaustion_failover' })
    })

    this.app.put('/api/strategy', (req, res) => {
      const { strategy } = req.body
      if (!Object.values(RoutingStrategy).includes(strategy)) {
        res.status(400).json({ error: 'Invalid strategy' })
        return
      }
      this.configStore.set('strategy', strategy)
      res.json({ strategy })
    })

    this.app.get('/api/status', (_req, res) => {
      const keys = this.keyManager.getKeys().map(k => {
        this.quotaTracker.applyStateToKey(k)
        return {
          id: k.id,
          alias: k.alias,
          status: k.status,
          enabled: k.status !== 'disabled',
          health: this.circuitBreaker.getState(k.id),
          cooldownUntil: k.cooldownUntil,
          tokensUsed: k.tokensUsed,
          costAccumulated: k.costAccumulated,
          quota: this.quotaTracker.getUsage(k.id),
        }
      })
      res.json({ keys })
    })

    this.app.get('/api/logs', (_req, res) => {
      res.json(this.logStream.getRecentLogs())
    })
  }

  async start(): Promise<http.Server> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        resolve(this.server!)
      })
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
}
