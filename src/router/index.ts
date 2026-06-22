import http from 'node:http'
import { KeyManager } from './key-manager.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { QuotaTracker } from './quota-tracker.js'
import { ProxyServer } from '../proxy/server.js'
import { DashboardServer } from '../dashboard/server.js'
import { LogStream } from '../logging/log-stream.js'
import { createLogger } from '../logging/logger.js'
import { SecureStore } from '../storage/secure-store.js'
import { ConfigStore } from '../storage/config-store.js'
import { printSetupInstructions } from '../plugin/index.js'
import type { RouterConfig } from './types.js'
import { DEFAULT_CONFIG } from './types.js'

export interface RouterInstance {
  keyManager: KeyManager
  circuitBreaker: CircuitBreaker
  quotaTracker: QuotaTracker
  proxyServer: ProxyServer
  dashboardServer: DashboardServer
  logStream: LogStream
  configStore: ConfigStore
  secureStore: SecureStore
  httpServer?: http.Server
  shutdown: () => Promise<void>
}

function loadEnvConfig(): Partial<RouterConfig> {
  return {
    upstreamUrl: process.env.UPSTREAM_URL || DEFAULT_CONFIG.upstreamUrl,
    dashboardPort: Number(process.env.DASHBOARD_PORT) || DEFAULT_CONFIG.dashboardPort,
    proxyPort: Number(process.env.PROXY_PORT) || DEFAULT_CONFIG.proxyPort,
    quotaLimit: Number(process.env.QUOTA_LIMIT) || DEFAULT_CONFIG.quotaLimit,
    cooldownMs: Number(process.env.COOLDOWN_MS) || DEFAULT_CONFIG.cooldownMs,
    circuitBreakerThreshold: Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || DEFAULT_CONFIG.circuitBreakerThreshold,
    logLevel: process.env.LOG_LEVEL || DEFAULT_CONFIG.logLevel,
    configDir: process.env.CONFIG_DIR || DEFAULT_CONFIG.configDir,
  }
}

export async function createRouter(config?: Partial<RouterConfig>): Promise<RouterInstance> {
  const envConfig = loadEnvConfig()
  const mergedConfig: RouterConfig = { ...DEFAULT_CONFIG, ...envConfig, ...config }

  const configStore = new ConfigStore(mergedConfig.configDir)
  const secureStore = new SecureStore(mergedConfig.configDir)
  const logger = createLogger(mergedConfig.logLevel)
  const logStream = new LogStream()

  const keyManager = new KeyManager(mergedConfig)
  const circuitBreaker = new CircuitBreaker(mergedConfig.circuitBreakerThreshold)
  const quotaTracker = new QuotaTracker(mergedConfig.quotaLimit)

  const storedKeys = await secureStore.loadKeys()
  for (const { key, alias } of storedKeys) {
    keyManager.addKey(key, alias)
  }

  const proxyServer = new ProxyServer(
    { port: mergedConfig.proxyPort, upstreamUrl: mergedConfig.upstreamUrl },
    keyManager,
    circuitBreaker,
    quotaTracker,
  )

  const dashboardServer = new DashboardServer(
    mergedConfig.dashboardPort,
    keyManager,
    circuitBreaker,
    quotaTracker,
    logStream,
    secureStore,
    configStore,
  )

  await proxyServer.start()
  const httpServer = await dashboardServer.start()
  logStream.attach(httpServer)

  logStream.emit(logger, 'info', `Dashboard UI: http://localhost:${mergedConfig.dashboardPort}`)
  logStream.emit(logger, 'info', `Proxy server: http://localhost:${mergedConfig.proxyPort}`)
  logStream.emit(logger, 'info', `Upstream: ${mergedConfig.upstreamUrl}`)
  logStream.emit(logger, 'info', `Loaded ${storedKeys.length} API key(s)`)

  printSetupInstructions(mergedConfig.proxyPort, mergedConfig.dashboardPort)

  return {
    keyManager,
    circuitBreaker,
    quotaTracker,
    proxyServer,
    dashboardServer,
    logStream,
    configStore,
    secureStore,
    httpServer,
    shutdown: async () => {
      logStream.emit(logger, 'info', 'Shutting down...')
      await proxyServer.stop()
      await dashboardServer.stop()
      logStream.stop()
    },
  }
}
