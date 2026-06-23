import { KeyManager } from './key-manager.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { QuotaTracker } from './quota-tracker.js'
import { ProxyServer } from '../proxy/server.js'
import { DashboardServer } from '../dashboard/server.js'
import { LogStream } from '../logging/log-stream.js'
import { createLogger, getPluginMode, logToFile } from '../logging/logger.js'
import { SecureStore } from '../storage/secure-store.js'
import { ConfigStore } from '../storage/config-store.js'
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
    ntfyUrl: process.env.NTFY_URL || DEFAULT_CONFIG.ntfyUrl,
    proactiveSwitchThreshold: Number(process.env.PROACTIVE_SWITCH_THRESHOLD) || DEFAULT_CONFIG.proactiveSwitchThreshold,
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
  const logger = createLogger(mergedConfig.logLevel)
  const logStream = new LogStream()

  mergedConfig.strategy = normalizeRoutingStrategy(configStore.get('strategy') || mergedConfig.strategy)
  const keyManager = new KeyManager(mergedConfig)
  const circuitBreaker = new CircuitBreaker(mergedConfig.circuitBreakerThreshold)
  const quotaTracker = new QuotaTracker(mergedConfig.quotaLimit)

  const storedKeys = await secureStore.loadKeys()
  keyManager.loadStoredKeys(storedKeys)

  const notifier = new NtfyNotifier(mergedConfig.ntfyUrl)

  if (notifier.enabled) {
    logToFile('info', `NTFY notifications enabled → ${mergedConfig.ntfyUrl}`)
  }

  const proxyServer = new ProxyServer(
    {
      port: mergedConfig.proxyPort,
      upstreamUrl: mergedConfig.upstreamUrl,
      proactiveSwitchThreshold: mergedConfig.proactiveSwitchThreshold,
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
      await proxyServer.stop()
      await dashboardServer.stop()
      logStream.stop()
    },
  }
}
