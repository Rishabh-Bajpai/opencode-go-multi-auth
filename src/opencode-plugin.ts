import net from 'node:net'
import type { Plugin, PluginModule } from '@opencode-ai/plugin'
import { createRouter, type RouterInstance } from './router/index.js'
import { DEFAULT_CONFIG } from './router/types.js'
import { setPluginMode, logToFile } from './logging/logger.js'

let routerInstance: RouterInstance | null = null
let healthCheckTimer: ReturnType<typeof setInterval> | null = null

function getProxyPort(): number {
  return Number(process.env.PROXY_PORT) || DEFAULT_CONFIG.proxyPort
}

/**
 * Check if a TCP port is accepting connections.
 * Much more reliable than HTTP requests — works even if the server
 * doesn't have a specific endpoint.
 */
function isPortListening(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let resolved = false

    const done = (result: boolean) => {
      if (resolved) return
      resolved = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, '127.0.0.1')
  })
}

async function tryStartRouter(): Promise<RouterInstance | null> {
  try {
    const router = await createRouter(undefined, { suppressSetupInstructions: true })
    routerInstance = router
    return router
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    if (code === 'EADDRINUSE') {
      return null
    }
    throw error
  }
}

function startHealthMonitor(): void {
  if (healthCheckTimer) return

  healthCheckTimer = setInterval(async () => {
    const alive = await isPortListening(getProxyPort())
    if (!alive) {
      logToFile('warn', 'Proxy port unreachable, attempting takeover...')
      stopHealthMonitor()
      try {
        const router = await tryStartRouter()
        if (router) {
          routerInstance = router
          logToFile('info', 'Successfully took over as primary router instance.')
        } else {
          // Another instance beat us to it — resume monitoring
          logToFile('info', 'Another instance started the router first, resuming health monitor.')
          startHealthMonitor()
        }
      } catch (err) {
        logToFile('error', `Failed to start router: ${err instanceof Error ? err.message : String(err)}`)
        // Retry monitoring after a delay
        setTimeout(() => startHealthMonitor(), 10_000)
      }
    }
  }, 5000)
}

function stopHealthMonitor(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
}

const OpenCodeGoMultiAuthPlugin: Plugin = async ({ client }, options = {}) => {
  // Enable plugin mode — suppress all console output, log to file only
  setPluginMode(true)

  const router = await tryStartRouter()

  if (router) {
    routerInstance = router
    logToFile('info', 'Router plugin initialized — primary instance, servers started.', {
      proxyPort: getProxyPort(),
      dashboardPort: DEFAULT_CONFIG.dashboardPort,
    })
  } else {
    logToFile('info', 'Router plugin initialized — secondary instance, health monitor active.', {
      proxyPort: getProxyPort(),
    })
    startHealthMonitor()
  }

  // Log to OpenCode's structured logger (only errors show in TUI)
  await client.app.log({
    body: {
      service: 'opencode-go-multi-auth',
      level: 'info',
      message: router
        ? 'Multi-auth router started.'
        : 'Multi-auth router connected (secondary).',
    },
  }).catch(() => {})

  return {
    dispose: async () => {
      stopHealthMonitor()
      if (routerInstance) {
        logToFile('info', 'Shutting down router servers.')
        await routerInstance.shutdown()
        routerInstance = null
      }
    },
  }
}

export const server = OpenCodeGoMultiAuthPlugin
export const pluginModule: PluginModule = {
  id: 'opencode-go-multi-auth',
  server: OpenCodeGoMultiAuthPlugin,
}
export default OpenCodeGoMultiAuthPlugin
