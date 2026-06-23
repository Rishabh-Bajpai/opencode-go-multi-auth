#!/usr/bin/env node

import { setPluginMode, logToFile } from './logging/logger.js'
import { createRouter } from './router/index.js'
import { removePidState, writePidState } from './runtime/daemon.js'

async function main() {
  if (process.env.OPENCODE_ROUTER_PLUGIN_MODE === '1') {
    setPluginMode(true)
  }

  const router = await createRouter()
  writePidState({
    pid: process.pid,
    startedAt: Date.now(),
  })
  logToFile('info', 'Router daemon is healthy.', { pid: process.pid })

  let shuttingDown = false

  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    logToFile('info', 'Router daemon shutting down.', { pid: process.pid, signal })

    try {
      await router.shutdown()
      removePidState()
      process.exit(exitCode)
    } catch (error) {
      logToFile('error', 'Router daemon shutdown failed.', {
        pid: process.pid,
        signal,
        error: error instanceof Error ? error.stack || error.message : String(error),
      })
      process.exit(1)
    }
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  process.on('uncaughtException', (err) => {
    logToFile('error', 'Uncaught exception in router daemon.', {
      pid: process.pid,
      error: err instanceof Error ? err.stack || err.message : String(err),
    })
    void shutdown('uncaughtException', 1)
  })

  process.on('unhandledRejection', (reason) => {
    logToFile('error', 'Unhandled rejection in router daemon.', {
      pid: process.pid,
      error: reason instanceof Error ? reason.stack || reason.message : String(reason),
    })
  })
}

main().catch((err) => {
  removePidState()
  logToFile('error', 'Fatal router startup error.', {
    pid: process.pid,
    error: err instanceof Error ? err.stack || err.message : String(err),
  })
  process.exit(1)
})
