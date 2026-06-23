import type { Plugin, PluginModule } from '@opencode-ai/plugin'
import { createRouter, type RouterInstance } from './router/index.js'

let routerPromise: Promise<RouterInstance | null> | null = null

async function startRouterOnce(): Promise<RouterInstance | null> {
  if (!routerPromise) {
    routerPromise = createRouter(undefined, { suppressSetupInstructions: true }).catch((error) => {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : ''
      if (code === 'EADDRINUSE') {
        console.warn('[opencode-go-multi-auth] Router already running on configured ports, reusing existing instance.')
        return null
      }

      routerPromise = null
      throw error
    })
  }

  return routerPromise
}

const OpenCodeGoMultiAuthPlugin: Plugin = async ({ client }, options = {}) => {
  const router = await startRouterOnce()

  await client.app.log({
    body: {
      service: 'opencode-go-multi-auth',
      level: 'info',
      message: router
        ? 'Router plugin initialized and background servers started.'
        : 'Router plugin initialized; existing router instance already serving configured ports.',
      extra: {
        mode: 'plugin',
        options,
      },
    },
  }).catch(() => {})

  return {
    dispose: async () => {
      if (!router) return
      await router.shutdown()
      routerPromise = null
    },
  }
}

export const server = OpenCodeGoMultiAuthPlugin
export const pluginModule: PluginModule = {
  id: 'opencode-go-multi-auth',
  server: OpenCodeGoMultiAuthPlugin,
}
export default OpenCodeGoMultiAuthPlugin
