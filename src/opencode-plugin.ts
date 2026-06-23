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
 * Two-phase health check:
 * 1. TCP probe — is anything listening on the port? (fast, catches "port free" case)
 * 2. HTTP liveness — is the server actually responding? (catches stopped/zombie processes)
 *
 * A stopped process (Ctrl+Z, SIGTSTP) can hold ports open but won't respond to HTTP.
 * The TCP probe alone would report it as "alive" — the HTTP check catches this.
 */
async function isProxyAlive(): Promise<boolean> {
  // Phase 1: TCP port probe
  const tcpAlive = await new Promise<boolean>((resolve) => {
    const socket = new net.Socket()
    let resolved = false

    const done = (result: boolean) => {
      if (resolved) return
      resolved = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(1500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(getProxyPort(), '127.0.0.1')
  })

  if (!tcpAlive) return false

  // Phase 2: HTTP liveness — confirm server is actually processing requests
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)

    // Use HEAD to /v1 — minimal overhead, any HTTP response = alive
    const res = await fetch(`http://127.0.0.1:${getProxyPort()}/v1`, {
      method: 'HEAD',
      signal: controller.signal,
    })
    clearTimeout(timeout)
    return true // Any response (even 4xx/5xx) means server is processing
  } catch {
    // Timeout or connection error — server is not responding
    return false
  }
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
    const alive = await isProxyAlive()
    if (!alive) {
      logToFile('warn', 'Proxy health check failed (port unresponsive or process stopped), attempting takeover...')
      stopHealthMonitor()
      try {
        const router = await tryStartRouter()
        if (router) {
          routerInstance = router
          logToFile('info', 'Successfully took over as primary router instance.')
        } else {
          // Another instance beat us — resume monitoring
          logToFile('info', 'Another instance claimed the port, resuming health monitor.')
          startHealthMonitor()
        }
      } catch (err) {
        logToFile('error', `Failed to start router: ${err instanceof Error ? err.message : String(err)}`)
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

const OpenCodeGoMultiAuthPlugin: Plugin = async ({ client }) => {
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
    // Check if the existing proxy is actually healthy
    const alive = await isProxyAlive()
    if (alive) {
      logToFile('info', 'Router plugin initialized — secondary instance, existing proxy is healthy.', {
        proxyPort: getProxyPort(),
      })
      startHealthMonitor()
    } else {
      // Port is held by a dead/stopped process — wait for OS to release it, then try again
      logToFile('warn', 'Port bound but proxy unresponsive (possibly a stopped process). Waiting for port release...')
      const retryDelay = 3000
      await new Promise((resolve) => setTimeout(resolve, retryDelay))

      const retryRouter = await tryStartRouter()
      if (retryRouter) {
        routerInstance = retryRouter
        logToFile('info', 'Router started after port was released.')
      } else {
        logToFile('info', 'Port still held, starting health monitor to wait for release.')
        startHealthMonitor()
      }
    }
  }

  // Log to OpenCode's structured logger
  await client.app.log({
    body: {
      service: 'opencode-go-multi-auth',
      level: 'info',
      message: routerInstance
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
