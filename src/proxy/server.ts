import http from 'node:http'
import type { KeyManager } from '../router/key-manager.js'
import type { CircuitBreaker } from '../router/circuit-breaker.js'
import type { QuotaTracker } from '../router/quota-tracker.js'
import { LogStream } from '../logging/log-stream.js'
import type { AppLogger } from '../logging/logger.js'
import { RoutingStrategy, CircuitState } from '../router/types.js'
import { buildUpstreamHeaders, extractCacheHeaders } from './header-passthrough.js'
import { isQuota429 } from './quota-detector.js'
import { parseTokenUsage, estimateCost } from './response-parser.js'
import { SessionAffinityStore } from './session-affinity.js'

export interface ProxyServerConfig {
  port: number
  upstreamUrl: string
}

const MAX_BODY_BYTES = 10 * 1024 * 1024
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
])

export class ProxyServer {
  private server?: http.Server
  private readonly config: ProxyServerConfig
  private readonly sessionAffinity: SessionAffinityStore

  constructor(
    config: ProxyServerConfig,
    private keyManager: KeyManager,
    private circuitBreaker: CircuitBreaker,
    private quotaTracker: QuotaTracker,
    private logStream: LogStream,
    private logger: AppLogger,
  ) {
    this.config = config
    this.sessionAffinity = new SessionAffinityStore()
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(this.config.port, () => resolve())
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const upstream = new URL(this.config.upstreamUrl)
    const targetPath = (req.url ?? '/').replace(/^\/v1\//, '/')
    const body = await this.readBody(req)
    if (body === null) {
      res.writeHead(413)
      res.end('Request body too large')
      return
    }

    const cacheHeaders = extractCacheHeaders(req.headers as Record<string, string | string[] | undefined>)
    const sessionKey = this.sessionAffinity.extractSessionKey(req.headers as Record<string, string | string[] | undefined>)

    const maxAttempts = this.keyManager.getActiveKeys().length || 1
    let lastError = 'All API keys exhausted'

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let key = this.keyManager.getNextKey(RoutingStrategy.EXHAUSTION_FAILOVER)

      if (sessionKey) {
        const preferred = this.sessionAffinity.getPreferredKey(sessionKey)
        if (preferred) {
          const preferredKey = this.keyManager.getKeyById(preferred)
          if (preferredKey && preferredKey.status === 'active' && this.circuitBreaker.isAvailable(preferred)) {
            key = preferredKey
          }
        }
      }

      if (!key) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'No active API keys available' }))
        return
      }

      if (!this.circuitBreaker.isAvailable(key.id)) continue

      const upstreamHeaders = buildUpstreamHeaders(
        req.headers as Record<string, string | string[] | undefined>,
        key.key,
        upstream.host,
      )
      Object.assign(upstreamHeaders, cacheHeaders)

      const startTime = Date.now()

      try {
        const fetchUrl = new URL(targetPath, this.config.upstreamUrl.replace(/\/+$/, '') + '/').toString()
        const upstreamRes = await fetch(fetchUrl, {
          method: req.method ?? 'GET',
          headers: upstreamHeaders,
          body: req.method !== 'GET' && req.method !== 'HEAD' && body ? body.toString() : undefined,
          signal: AbortSignal.timeout(60_000),
        })

        const duration = Date.now() - startTime

        if (upstreamRes.status === 402 || upstreamRes.status === 429) {
          const responseBody = await upstreamRes.clone().text()
          const isQuota = isQuota429(upstreamRes.status, Object.fromEntries(upstreamRes.headers), responseBody)
          if (isQuota) {
            this.keyManager.markExhausted(key.id)
            this.logStream.emit(this.logger, 'warn', `Key "${key.alias}" quota exhausted (HTTP ${upstreamRes.status}), failing over`, {
              keyId: key.id, statusCode: upstreamRes.status, attempt: attempt + 1,
            })
            if (sessionKey) this.sessionAffinity.setPreferredKey(sessionKey, key.id)
            continue
          }
        }

        if (upstreamRes.status >= 500) {
          this.circuitBreaker.recordFailure(key.id)
          this.circuitBreaker.tryRecovery(key.id)
          if (this.circuitBreaker.getState(key.id) === CircuitState.OPEN) {
            this.logStream.emit(this.logger, 'error', `Circuit breaker OPEN for key "${key.alias}"`, { keyId: key.id })
          }
          if (attempt < maxAttempts - 1) continue
        }

        const responseBody = await upstreamRes.clone().text()
        const tokens = parseTokenUsage(responseBody)
        if (tokens) {
          const cost = estimateCost(tokens)
          this.quotaTracker.recordUsage(key.id, tokens, cost)
        }

        if (sessionKey) this.sessionAffinity.setPreferredKey(sessionKey, key.id)
        this.circuitBreaker.recordSuccess(key.id)

        this.logStream.emit(this.logger, 'info', `${req.method} ${targetPath} -> ${upstreamRes.status} via "${key.alias}" (${duration}ms)`)

        const responseHeaders: Record<string, string> = {}
        upstreamRes.headers.forEach((value, key) => {
          const lower = key.toLowerCase()
          if (!HOP_BY_HOP.has(lower) && lower !== 'transfer-encoding') {
            responseHeaders[key] = value
          }
        })

        res.writeHead(upstreamRes.status, responseHeaders)
        if (upstreamRes.body) {
          const reader = upstreamRes.body.getReader()
          ;(async () => {
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) { res.end(); return }
                res.write(value)
              }
            } catch { res.end() }
          })()
        } else {
          res.end()
        }
        return

      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        this.logStream.emit(this.logger, 'error', `Upstream error for key "${key.alias}": ${lastError}`, { keyId: key.id })
        continue
      }
    }

    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'All API keys failed', detail: lastError }))
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) { req.destroy(); resolve(null); return }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', () => resolve(null))
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) { this.server.close(() => resolve()) } else { resolve() }
    })
  }
}
