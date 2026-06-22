import http from 'node:http'
import httpProxy from 'http-proxy'
import type { KeyManager } from '../router/key-manager.js'
import type { CircuitBreaker } from '../router/circuit-breaker.js'
import type { QuotaTracker } from '../router/quota-tracker.js'
import { RoutingStrategy, CircuitState } from '../router/types.js'
import { extractCacheHeaders, logCacheMissWarning } from './header-passthrough.js'

export interface ProxyServerConfig {
  port: number
  upstreamUrl: string
}

export class ProxyServer {
  private server?: http.Server
  private proxy: httpProxy
  private readonly config: ProxyServerConfig

  constructor(
    config: ProxyServerConfig,
    private keyManager: KeyManager,
    private circuitBreaker: CircuitBreaker,
    private quotaTracker: QuotaTracker,
  ) {
    this.config = config
    this.proxy = httpProxy.createProxyServer({
      changeOrigin: true,
      proxyTimeout: 60_000,
    })
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(this.config.port, () => {
        console.log(`[PROXY] Listening on port ${this.config.port}`)
        resolve()
      })
    })
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const strategy = RoutingStrategy.EXHAUSTION_FAILOVER
    const key = this.keyManager.getNextKey(strategy)

    if (!key) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'No active API keys available' }))
      return
    }

    if (!this.circuitBreaker.isAvailable(key.id)) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `Key "${key.alias}" is circuit-broken` }))
      return
    }

    const cacheHeaders = extractCacheHeaders(req.headers as Record<string, string | string[] | undefined>)
    const upstream = new URL(this.config.upstreamUrl)
    const targetUrl = `${upstream.origin}${req.url ?? ''}`

    const startTime = Date.now()
    let failedToUpstream = false

    this.proxy.web(
      req,
      res,
      {
        target: `${upstream.origin}`,
        selfHandleResponse: false,
        headers: {
          ...(req.headers as Record<string, string>),
          'authorization': `Bearer ${key.key}`,
          'host': upstream.host,
          ...cacheHeaders,
        },
      },
      (err) => {
        failedToUpstream = true
        console.error(`[PROXY] Upstream error for key "${key.alias}":`, err.message)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Upstream request failed' }))
      },
    )

    res.on('close', () => {
      const duration = Date.now() - startTime
      console.log(`[PROXY] ${req.method} ${req.url} -> ${targetUrl} via key "${key.alias}" (${duration}ms)`)
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
