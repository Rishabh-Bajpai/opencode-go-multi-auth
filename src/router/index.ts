import { KeyManager } from './key-manager.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { QuotaTracker } from './quota-tracker.js'
import { ProxyServer } from '../proxy/server.js'
import { DashboardServer } from '../dashboard/server.js'
import { LogStream } from '../logging/log-stream.js'
import { createLogger, getPluginMode, logToFile } from '../logging/logger.js'
import { SecureStore } from '../storage/secure-store.js'
import { ConfigStore } from '../storage/config-store.js'
import { RuntimeStateStore } from '../storage/runtime-state-store.js'
import { NtfyNotifier } from '../notification/ntfy.js'
import { printSetupInstructions } from '../plugin/index.js'
import type { RouterConfig } from './types.js'
import { DEFAULT_CONFIG, normalizeRoutingStrategy } from './types.js'

export interface RouterInstance {
  keyManager: KeyManager
  circuitBreaker: CircuitBreaker
  quotaTracker: QuotaTracker
  proxyServer: ProxyServer
  dashboardServer: DashboardServer
  logStream: LogStream
  configStore: ConfigStore
  secureStore: SecureStore
  notifier: NtfyNotifier
  shutdown: () => Promise<void>
}

export interface RouterBootstrapOptions {
  suppressSetupInstructions?: boolean
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

function loadEnvConfig(): Partial<RouterConfig> {
  return {
    upstreamUrl: process.env.UPSTREAM_URL || DEFAULT_CONFIG.upstreamUrl,
    upstreamUrlZen: process.env.UPSTREAM_URL_ZEN || DEFAULT_CONFIG.upstreamUrlZen,
    dashboardPort: Number(process.env.DASHBOARD_PORT) || DEFAULT_CONFIG.dashboardPort,
    proxyPort: Number(process.env.PROXY_PORT) || DEFAULT_CONFIG.proxyPort,
    cooldownMs: Number(process.env.COOLDOWN_MS) || DEFAULT_CONFIG.cooldownMs,
    circuitBreakerThreshold: Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || DEFAULT_CONFIG.circuitBreakerThreshold,
    logLevel: process.env.LOG_LEVEL || DEFAULT_CONFIG.logLevel,
    configDir: process.env.CONFIG_DIR || DEFAULT_CONFIG.configDir,
    ntfyUrl: process.env.NTFY_URL || DEFAULT_CONFIG.ntfyUrl,
    requestTimeoutMs: readPositiveInt(process.env.REQUEST_TIMEOUT_MS, DEFAULT_CONFIG.requestTimeoutMs),
    upstreamHungTimeoutMs: readPositiveInt(process.env.UPSTREAM_HUNG_TIMEOUT_MS, DEFAULT_CONFIG.upstreamHungTimeoutMs),
    keepAliveTimeoutMs: readPositiveInt(process.env.KEEP_ALIVE_TIMEOUT_MS, DEFAULT_CONFIG.keepAliveTimeoutMs),
    headersTimeoutMs: readPositiveInt(process.env.HEADERS_TIMEOUT_MS, DEFAULT_CONFIG.headersTimeoutMs),
  }
}

export async function createRouter(
  config?: Partial<RouterConfig>,
  options: RouterBootstrapOptions = {},
): Promise<RouterInstance> {
  const envConfig = loadEnvConfig()
  const mergedConfig: RouterConfig = { ...DEFAULT_CONFIG, ...envConfig, ...config }

  const configStore = new ConfigStore(mergedConfig.configDir)
  const secureStore = new SecureStore(mergedConfig.configDir)
  const runtimeStateStore = new RuntimeStateStore(mergedConfig.configDir)
  const logger = createLogger(mergedConfig.logLevel)

  let keyManager!: KeyManager
  let quotaTracker!: QuotaTracker
  let logStream!: LogStream
  let persistTimer: NodeJS.Timeout | undefined
  let persistReady = false

  const persistRuntimeState = () => {
    if (!persistReady) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      runtimeStateStore.save({
        keys: keyManager.exportRuntimeState(),
        quota: quotaTracker.exportState(),
        logs: logStream.export(),
      })
    }, 100)
  }

  logStream = new LogStream(persistRuntimeState)
  mergedConfig.strategy = normalizeRoutingStrategy(configStore.get('strategy') || mergedConfig.strategy)
  mergedConfig.ntfyUrl = configStore.get('ntfyUrl') || mergedConfig.ntfyUrl
  keyManager = new KeyManager(mergedConfig, persistRuntimeState)
  const circuitBreaker = new CircuitBreaker(mergedConfig.circuitBreakerThreshold)
  quotaTracker = new QuotaTracker(2000, persistRuntimeState)

  const storedKeys = await secureStore.loadKeys()
  keyManager.loadStoredKeys(storedKeys)
  const runtimeState = runtimeStateStore.load()
  keyManager.loadRuntimeState(runtimeState.keys)
  quotaTracker.loadState(runtimeState.quota)
  logStream.load(runtimeState.logs)
  persistReady = true

  const notifier = new NtfyNotifier(mergedConfig.ntfyUrl)

  if (notifier.enabled) {
    logToFile('info', `NTFY notifications enabled → ${mergedConfig.ntfyUrl}`)
  }

  const proxyServer = new ProxyServer(
    {
      port: mergedConfig.proxyPort,
      upstreamUrl: mergedConfig.upstreamUrl,
      upstreamUrlZen: mergedConfig.upstreamUrlZen,
      requestTimeoutMs: mergedConfig.requestTimeoutMs,
      upstreamHungTimeoutMs: mergedConfig.upstreamHungTimeoutMs,
      fallbackCooldownMs: mergedConfig.cooldownMs,
      keepAliveTimeoutMs: mergedConfig.keepAliveTimeoutMs,
      headersTimeoutMs: mergedConfig.headersTimeoutMs,
    },
    keyManager,
    circuitBreaker,
    quotaTracker,
    logStream,
    logger,
    () => normalizeRoutingStrategy(configStore.get('strategy')),
    notifier,
  )

  const dashboardServer = new DashboardServer(
    mergedConfig.dashboardPort,
    keyManager,
    circuitBreaker,
    quotaTracker,
    logStream,
    secureStore,
    configStore,
    notifier,
  )

  await proxyServer.start()
  const httpServer = await dashboardServer.start()
  logStream.attach(httpServer)

  logStream.emit(logger, 'info', `Dashboard UI: http://localhost:${mergedConfig.dashboardPort}`)
  logStream.emit(logger, 'info', `Proxy server: http://localhost:${mergedConfig.proxyPort}`)
  logStream.emit(logger, 'info', `Upstream: ${mergedConfig.upstreamUrl}`)
  logStream.emit(logger, 'info', `Loaded ${storedKeys.length} API key(s)`)

  if (!options.suppressSetupInstructions && !getPluginMode()) {
    printSetupInstructions(mergedConfig.proxyPort, mergedConfig.dashboardPort)
  }

  return {
    keyManager,
    circuitBreaker,
    quotaTracker,
    proxyServer,
    dashboardServer,
    logStream,
    configStore,
    secureStore,
    notifier,
    shutdown: async () => {
      logStream.emit(logger, 'info', 'Shutting down...')
      if (persistTimer) clearTimeout(persistTimer)
      runtimeStateStore.save({
        keys: keyManager.exportRuntimeState(),
        quota: quotaTracker.exportState(),
        logs: logStream.export(),
      })
      await proxyServer.stop()
      await dashboardServer.stop()
      logStream.stop()
    },
  }
}
