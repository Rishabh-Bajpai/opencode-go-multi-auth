#!/usr/bin/env node

import { createRouter } from './index.js'

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
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
