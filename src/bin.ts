#!/usr/bin/env node

import { createRouter } from './router/index.js'

async function main() {
  const router = await createRouter()

  process.on('SIGINT', async () => {
    await router.shutdown()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await router.shutdown()
    process.exit(0)
  })

  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err)
    await router.shutdown()
    process.exit(1)
  })

  process.on('unhandledRejection', async (reason) => {
    console.error('Unhandled rejection:', reason)
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
