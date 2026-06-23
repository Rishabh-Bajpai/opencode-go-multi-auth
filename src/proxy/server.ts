import crypto from 'node:crypto'
import http from 'node:http'
import type { KeyManager } from '../router/key-manager.js'
import type { CircuitBreaker } from '../router/circuit-breaker.js'
import type { QuotaTracker } from '../router/quota-tracker.js'
import { LogStream } from '../logging/log-stream.js'
import type { AppLogger } from '../logging/logger.js'
import { NtfyNotifier } from '../notification/ntfy.js'
import {
  CircuitState,
  RoutingStrategy,
  normalizeRoutingStrategy,
  type ApiKey,
  type KeySelection,
  type UsageSnapshot,
} from '../router/types.js'
import { buildUpstreamHeaders, extractCacheHeaders } from './header-passthrough.js'
import { isQuota429, resolveCooldownMs } from './quota-detector.js'
import { estimateCost, parseUsageData } from './response-parser.js'
import { SessionAffinityStore } from './session-affinity.js'

export interface ProxyServerConfig {
  port: number
  upstreamUrl: string
  proactiveSwitchThreshold: number
  requestTimeoutMs: number
  upstreamHungTimeoutMs: number
}

interface RequestPreparation {
  body: string | undefined
  model: string | null
  stream: boolean
}

interface RoutingDecision {
  key: ApiKey
  reason: string
  strategy: RoutingStrategy
  selectedBySession: boolean
}

function buildUpstreamUrl(upstreamUrl: string, requestUrl?: string): string {
  const upstream = new URL(upstreamUrl)
  const incomingPath = requestUrl?.split('?')[0] || '/'
  const basePath = upstream.pathname.replace(/\/+$/, '')
  const needsVersionPrefix = !incomingPath.startsWith('/v1/') && incomingPath !== '/v1'
  const normalizedPath = needsVersionPrefix ? `/v1${incomingPath}` : incomingPath
  const withoutDuplicateVersion = basePath.endsWith('/v1') && normalizedPath.startsWith('/v1')
    ? normalizedPath.slice(3) || '/'
    : normalizedPath
  const upstreamPath = `${basePath}${withoutDuplicateVersion}`
  const search = requestUrl?.includes('?') ? `?${requestUrl.split('?').slice(1).join('?')}` : ''

  return `${upstream.origin}${upstreamPath}${search}`
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (!value) return undefined
  return Array.isArray(value) ? value[0] : value
}

function createProxySessionId(seed: string): string {
  return `router-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
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
    private getStrategy: () => RoutingStrategy,
    private notifier: NtfyNotifier = new NtfyNotifier(),
  ) {
    this.config = config
    this.sessionAffinity = new SessionAffinityStore()
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))
      this.server.on('error', (err) => reject(err))
      this.server.listen(this.config.port, () => resolve())
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const upstream = new URL(this.config.upstreamUrl)
    const targetPath = req.url?.split('?')[0] || '/'
    const headers = req.headers as Record<string, string | string[] | undefined>
    const body = await this.readBody(req)
    if (body === null) {
      res.writeHead(413)
      res.end('Request body too large')
      return
    }

    const prepared = this.prepareRequest(body, targetPath)
    const cacheHeaders = extractCacheHeaders(headers)
    const sessionKey = this.sessionAffinity.extractSessionKey(headers)
    const upstreamSessionId = getHeader(headers, 'x-session-id')
      ?? (getHeader(headers, 'prompt-cache-key') ? createProxySessionId(getHeader(headers, 'prompt-cache-key')!) : undefined)

    const attemptedKeyIds = new Set<string>()
    const totalKeys = this.keyManager.getActiveKeys().length
    const maxAttempts = totalKeys || 1
    let lastError = 'All API keys exhausted'

    const upstreamAbortController = new AbortController()
    let upstreamClientCloseHandler: (() => void) | null = null
    const onClientClose = () => {
      if (!upstreamAbortController.signal.aborted) {
        upstreamAbortController.abort(new Error('client disconnected'))
      }
    }
    if (!res.closed) {
      res.once('close', onClientClose)
      upstreamClientCloseHandler = onClientClose
    } else {
      onClientClose()
    }
    if (this.config.requestTimeoutMs > 0) {
      const requestTimeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs)
      requestTimeoutSignal.addEventListener('abort', () => {
        if (!upstreamAbortController.signal.aborted) {
          upstreamAbortController.abort(requestTimeoutSignal.reason)
        }
      })
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const decision = this.selectKey(sessionKey, attemptedKeyIds)

      if (!decision) {
        if (this.keyManager.getKeys().some((key) => key.enabled)) {
          await this.notifier.allKeysExhausted(this.keyManager.getKeys().filter((key) => key.enabled).length)
        }
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'No active API keys available' }))
        return
      }

      const { key, reason, strategy, selectedBySession } = decision

      if (!this.circuitBreaker.isAvailable(key.id)) {
        attemptedKeyIds.add(key.id)
        continue
      }

      const upstreamHeaders = buildUpstreamHeaders(headers, key.key, upstream.host)
      Object.assign(upstreamHeaders, cacheHeaders)
      if (upstreamSessionId) {
        upstreamHeaders['x-session-id'] = upstreamSessionId
      }

      if (
        strategy === RoutingStrategy.PRIORITY_SPILLOVER &&
        key.priority > Math.min(...this.keyManager.getActiveKeys().map((entry) => entry.priority))
      ) {
        const usage = this.quotaTracker.getUsage(key.id)
        await this.notifier.proactiveSwitch(key.alias, usage.percentUsed)
      }

      const startTime = Date.now()
      const upstreamHungTimer = this.config.upstreamHungTimeoutMs > 0
        ? setTimeout(() => {
            if (!upstreamAbortController.signal.aborted) {
              upstreamAbortController.abort(new Error('upstream hung (no response within UPSTREAM_HUNG_TIMEOUT_MS)'))
            }
          }, this.config.upstreamHungTimeoutMs)
        : undefined

      try {
        const fetchUrl = buildUpstreamUrl(this.config.upstreamUrl, req.url)
        const upstreamRes = await fetch(fetchUrl, {
          method: req.method ?? 'GET',
          headers: upstreamHeaders,
          body: req.method !== 'GET' && req.method !== 'HEAD' ? prepared.body : undefined,
          signal: upstreamAbortController.signal,
        })
        if (upstreamHungTimer) clearTimeout(upstreamHungTimer)

        const duration = Date.now() - startTime
        const responseTextPromise = upstreamRes.clone().text().catch(() => '')

        if (upstreamRes.status === 402 || upstreamRes.status === 429) {
          const responseBody = await responseTextPromise
          const isQuota = isQuota429(upstreamRes.status, Object.fromEntries(upstreamRes.headers), responseBody)
          if (isQuota) {
            const remainingKeys = this.keyManager.getActiveKeys().filter((entry) => entry.id !== key.id && !attemptedKeyIds.has(entry.id)).length
            const now = Date.now()
            const fallbackMs = 5 * 60 * 60 * 1000
            const headerCooldownMs = resolveCooldownMs(Object.fromEntries(upstreamRes.headers), responseBody, now, fallbackMs)
            const rollingCooldownMs = this.quotaTracker.getEstimatedCooldown(key.id, now)
            const cooldownMs = rollingCooldownMs !== null ? Math.max(headerCooldownMs, rollingCooldownMs) : headerCooldownMs
            this.keyManager.markExhausted(key.id, cooldownMs)
            this.keyManager.recordRequest(key.id, {
              statusCode: upstreamRes.status,
              durationMs: duration,
              model: prepared.model,
              sessionId: upstreamSessionId ?? sessionKey ?? null,
              successful: false,
            })
            attemptedKeyIds.add(key.id)

            const cooldownHours = (cooldownMs / 3_600_000).toFixed(1)
            await this.notifier.keyExhausted(key.alias, upstreamRes.status, remainingKeys)
            this.logStream.emit(
              this.logger,
              'warn',
              `Key "${key.alias}" quota exhausted (HTTP ${upstreamRes.status}), cooldown ${cooldownHours}h, failing over`,
              {
                method: req.method,
                path: targetPath,
                statusCode: upstreamRes.status,
                keyAlias: key.alias,
                keyId: key.id,
                duration,
                model: prepared.model,
                strategy,
                routeReason: reason,
                selectedBySession,
                sessionId: upstreamSessionId ?? sessionKey ?? null,
                cooldownMs,
                attempt: attempt + 1,
              },
            )

            if (remainingKeys === 0) {
              await this.notifier.allKeysExhausted(this.keyManager.getKeys().filter((entry) => entry.enabled).length)
            }
            continue
          }
        }

        if (upstreamRes.status >= 500) {
          const circuitState = this.circuitBreaker.recordFailure(key.id)
          this.keyManager.markError(key.id)
          this.keyManager.recordRequest(key.id, {
            statusCode: upstreamRes.status,
            durationMs: duration,
            model: prepared.model,
            sessionId: upstreamSessionId ?? sessionKey ?? null,
            successful: false,
          })
          attemptedKeyIds.add(key.id)

          if (circuitState === CircuitState.OPEN) {
            await this.notifier.circuitTripped(key.alias, key.consecutiveErrors)
            this.logStream.emit(this.logger, 'error', `Circuit breaker OPEN for key "${key.alias}"`, {
              method: req.method,
              path: targetPath,
              keyAlias: key.alias,
              keyId: key.id,
              statusCode: upstreamRes.status,
              model: prepared.model,
              strategy,
              routeReason: reason,
            })
          }

          if (attempt < maxAttempts - 1) {
            continue
          }
        } else {
          this.circuitBreaker.recordSuccess(key.id)
          key.consecutiveErrors = 0
        }

        const responseHeaders = this.buildResponseHeaders(upstreamRes)
        res.writeHead(upstreamRes.status, responseHeaders)
        if (upstreamRes.body) {
          await this.pipeResponseBody(upstreamRes.body, res)
        } else {
          res.end()
        }

        const responseBody = await responseTextPromise
        const usageData = parseUsageData(responseBody, prepared.model ?? undefined)
        const tokens = usageData?.tokens ?? null
        const cost = tokens ? (usageData?.cost ?? estimateCost(tokens)) : null
        if (tokens && cost !== null) {
          this.quotaTracker.recordUsage(key.id, tokens, cost)
        }

        this.keyManager.recordRequest(key.id, {
          statusCode: upstreamRes.status,
          durationMs: duration,
          model: prepared.model,
          sessionId: upstreamSessionId ?? sessionKey ?? null,
          successful: upstreamRes.status < 400,
        })

        if (sessionKey) {
          this.sessionAffinity.setPreferredKey(sessionKey, key.id)
        }

        const level = upstreamRes.status >= 500 ? 'error' : upstreamRes.status >= 400 ? 'warn' : 'info'
        this.logStream.emit(this.logger, level, `${req.method} ${targetPath} -> ${upstreamRes.status}`, {
          method: req.method,
          path: targetPath,
          statusCode: upstreamRes.status,
          keyAlias: key.alias,
          keyId: key.id,
          duration,
          model: prepared.model,
          strategy,
          routeReason: reason,
          selectedBySession,
          sessionId: upstreamSessionId ?? sessionKey ?? null,
          tokens: tokens || null,
          cost,
        })
        return
      } catch (err) {
        if (upstreamHungTimer) clearTimeout(upstreamHungTimer)
        lastError = err instanceof Error ? err.message : String(err)
        this.keyManager.recordRequest(key.id, {
          statusCode: 0,
          durationMs: Date.now() - startTime,
          model: prepared.model,
          sessionId: upstreamSessionId ?? sessionKey ?? null,
          successful: false,
        })
        attemptedKeyIds.add(key.id)
        this.logStream.emit(this.logger, 'error', `Upstream error for key "${key.alias}": ${lastError}`, {
          method: req.method,
          path: targetPath,
          keyAlias: key.alias,
          keyId: key.id,
          model: prepared.model,
          strategy,
          routeReason: reason,
        })
      }
    }

    if (upstreamClientCloseHandler) {
      res.removeListener('close', upstreamClientCloseHandler)
    }
    if (!upstreamAbortController.signal.aborted) {
      upstreamAbortController.abort()
    }

    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'All API keys failed', detail: lastError }))
  }

  private selectKey(sessionKey: string | undefined, attemptedKeyIds: Set<string>): RoutingDecision | null {
    const strategy = normalizeRoutingStrategy(this.getStrategy())
    const usageByKey = this.getUsageSnapshots()

    if (sessionKey) {
      const preferredId = this.sessionAffinity.getPreferredKey(sessionKey)
      if (preferredId && !attemptedKeyIds.has(preferredId)) {
        const preferredKey = this.keyManager.getKeyById(preferredId)
        if (preferredKey && preferredKey.enabled && preferredKey.status === 'active' && this.circuitBreaker.isAvailable(preferredId)) {
          return {
            key: preferredKey,
            reason: `Sticky session reused warm account ${preferredKey.alias}.`,
            strategy,
            selectedBySession: true,
          }
        }
      }
    }

    const selection = this.keyManager.getNextKey(strategy, {
      usageByKey,
      proactiveSwitchThreshold: this.config.proactiveSwitchThreshold,
      excludeKeyIds: attemptedKeyIds,
    })
    if (!selection) return null

    return {
      key: selection.key,
      reason: selection.reason,
      strategy,
      selectedBySession: false,
    }
  }

  private getUsageSnapshots(): Map<string, UsageSnapshot> {
    const entries = new Map<string, UsageSnapshot>()
    for (const key of this.keyManager.getKeys()) {
      const usage = this.quotaTracker.getUsage(key.id)
      entries.set(key.id, {
        costAccumulated: usage.costAccumulated,
        remaining: usage.remaining,
        percentUsed: usage.percentUsed,
      })
    }
    return entries
  }

  private prepareRequest(body: Buffer, targetPath: string): RequestPreparation {
    if (!body.length) {
      return { body: undefined, model: null, stream: false }
    }

    const raw = body.toString('utf8')
    try {
      const json = JSON.parse(raw)
      const model = typeof json?.model === 'string' ? json.model : null
      const stream = Boolean(json?.stream)

      if ((targetPath === '/chat/completions' || targetPath === '/v1/chat/completions') && stream && json && typeof json === 'object') {
        const streamOptions = typeof json.stream_options === 'object' && json.stream_options !== null
          ? json.stream_options as Record<string, unknown>
          : {}
        json.stream_options = { ...streamOptions, include_usage: true }
        return {
          body: JSON.stringify(json),
          model,
          stream,
        }
      }

      return { body: raw, model, stream }
    } catch {
      return { body: raw, model: null, stream: false }
    }
  }

  private buildResponseHeaders(upstreamRes: Response): Record<string, string> {
    const responseHeaders: Record<string, string> = {}
    upstreamRes.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (
        !HOP_BY_HOP.has(lower) &&
        lower !== 'transfer-encoding' &&
        lower !== 'content-encoding' &&
        lower !== 'content-length'
      ) {
        responseHeaders[key] = value
      }
    })
    return responseHeaders
  }

  private async pipeResponseBody(body: ReadableStream<Uint8Array>, res: http.ServerResponse): Promise<void> {
    const reader = body.getReader()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          res.end()
          return
        }
        res.write(value)
      }
    } catch {
      res.end()
    }
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          req.destroy()
          resolve(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', () => resolve(null))
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
