import type { Plugin, PluginModule } from '@opencode-ai/plugin'
import { createRouter, type RouterInstance } from './router/index.js'
import { DEFAULT_CONFIG } from './router/types.js'

let routerInstance: RouterInstance | null = null
let healthCheckTimer: ReturnType<typeof setInterval> | null = null

function getProxyPort(): number {
  return Number(process.env.PROXY_PORT) || DEFAULT_CONFIG.proxyPort
}

async function tryStartRouter(): Promise<RouterInstance | null> {
  try {
    const router = await createRouter(undefined, { suppressSetupInstructions: true })
    routerInstance = router
    return router
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'EADDRINUSE') {
      return null
    }
    throw error
  }
}

async function isProxyAlive(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${getProxyPort()}/v1/models`, {
      signal: AbortSignal.timeout(2000),
    })
    // Any response (even 4xx) means the proxy is alive
    return true
  } catch {
    return false
  }
}

function startHealthMonitor(): void {
  if (healthCheckTimer) return

  healthCheckTimer = setInterval(async () => {
    const alive = await isProxyAlive()
    if (!alive) {
      // Proxy went down — the original instance likely exited. Take over.
      console.warn('[opencode-go-multi-auth] Proxy unreachable, attempting to start router...')
      stopHealthMonitor()
      try {
        const router = await tryStartRouter()
        if (router) {
          routerInstance = router
          console.log('[opencode-go-multi-auth] Successfully took over as primary router instance.')
        } else {
          // Another instance beat us to it — resume monitoring
          startHealthMonitor()
        }
      } catch (err) {
        console.error('[opencode-go-multi-auth] Failed to start router:', err)
        // Retry monitoring
        startHealthMonitor()
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
  const router = await tryStartRouter()

  if (router) {
    // We are the primary instance — we own the servers
    routerInstance = router
  } else {
    // Another instance is already running — monitor its health
    console.warn('[opencode-go-multi-auth] Router already running on configured ports, monitoring health.')
    startHealthMonitor()
  }

  await client.app.log({
    body: {
      service: 'opencode-go-multi-auth',
      level: 'info',
      message: router
        ? 'Router plugin initialized and background servers started.'
        : 'Router plugin initialized; existing router instance detected, health monitor active.',
      extra: {
        mode: 'plugin',
        isPrimary: !!router,
        options,
      },
    },
  }).catch(() => {})

  return {
    dispose: async () => {
      stopHealthMonitor()
      if (routerInstance) {
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
