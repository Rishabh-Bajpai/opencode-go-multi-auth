import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { Plugin, PluginModule } from '@opencode-ai/plugin'
import { DEFAULT_CONFIG } from './router/types.js'
import { setPluginMode, logToFile } from './logging/logger.js'
import { getRuntimePaths, isProcessAlive, readPidState } from './runtime/daemon.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function getProxyPort(): number {
  return Number(process.env.PROXY_PORT) || DEFAULT_CONFIG.proxyPort
}

function getDashboardPort(): number {
  return Number(process.env.DASHBOARD_PORT) || DEFAULT_CONFIG.dashboardPort
}

function getHealthUrl(): string {
  return `http://127.0.0.1:${getDashboardPort()}/healthz`
}

async function isDashboardHealthy(): Promise<boolean> {
  try {
    const res = await fetch(getHealthUrl(), {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

async function isProxyListening(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const done = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(1500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(getProxyPort(), '127.0.0.1')
  })
}

async function isRouterHealthy(): Promise<boolean> {
  const [dashboardHealthy, proxyListening] = await Promise.all([
    isDashboardHealthy(),
    isProxyListening(),
  ])
  return dashboardHealthy && proxyListening
}

function removeBootstrapLock(): void {
  try {
    const { bootstrapLockFile } = getRuntimePaths()
    if (fs.existsSync(bootstrapLockFile)) {
      fs.unlinkSync(bootstrapLockFile)
    }
  } catch (error) {
    logToFile('warn', 'Failed to remove bootstrap lock file.', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function readBootstrapLogTail(): string | null {
  try {
    const { bootstrapLogFile } = getRuntimePaths()
    if (!fs.existsSync(bootstrapLogFile)) return null
    const content = fs.readFileSync(bootstrapLogFile, 'utf8')
    if (!content) return null
    const lines = content.trim().split('\n')
    return lines.slice(-10).join('\n')
  } catch {
    return null
  }
}

async function waitForRouterHealthy(timeoutMs: number, daemonPid?: number): Promise<{ healthy: boolean, childExited: boolean }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isRouterHealthy()) return { healthy: true, childExited: false }
    if (daemonPid && !isProcessAlive(daemonPid)) return { healthy: false, childExited: true }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { healthy: false, childExited: daemonPid ? !isProcessAlive(daemonPid) : false }
}

function getDaemonEntry(): string {
  if (path.basename(__dirname) === 'src') {
    return path.join(__dirname, 'bin.ts')
  }
  return path.join(__dirname, 'bin.js')
}

function spawnRouterDaemon(): number {
  const { bootstrapLogFile } = getRuntimePaths()
  const logFd = fs.openSync(bootstrapLogFile, 'a')
  const child = spawn(process.execPath, [getDaemonEntry()], {
    cwd: path.join(__dirname, '..'),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      OPENCODE_ROUTER_PLUGIN_MODE: '1',
    },
  })
  fs.closeSync(logFd)
  child.unref()
  return child.pid ?? 0
}

function tryAcquireBootstrapLock(): boolean {
  const { bootstrapLockFile } = getRuntimePaths()
  try {
    const fd = fs.openSync(bootstrapLockFile, 'wx')
    fs.writeFileSync(fd, String(process.pid))
    fs.closeSync(fd)
    return true
  } catch {
    return false
  }
}

async function ensureRouterDaemon(): Promise<'reused' | 'started' | 'failed'> {
  if (await isRouterHealthy()) {
    const state = readPidState()
    logToFile('info', 'Reusing running router daemon.', {
      pid: state?.pid ?? null,
      dashboardPort: getDashboardPort(),
      proxyPort: getProxyPort(),
    })
    return 'reused'
  }

  const existingState = readPidState()
  if (existingState && !isProcessAlive(existingState.pid)) {
    logToFile('warn', 'Removing stale router pid file before restart.', { pid: existingState.pid })
    const { pidFile } = getRuntimePaths()
    try {
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
    } catch {
      // Best-effort cleanup only.
    }
  }

  if (!tryAcquireBootstrapLock()) {
    const waited = await waitForRouterHealthy(10_000)
    if (waited.healthy) {
      const state = readPidState()
      logToFile('info', 'Router daemon became healthy while waiting for another bootstrapper.', {
        pid: state?.pid ?? null,
      })
      return 'reused'
    }

    logToFile('error', 'Router bootstrap lock was held but the daemon never became healthy.', {
      healthUrl: getHealthUrl(),
      proxyPort: getProxyPort(),
      bootstrapLogTail: readBootstrapLogTail(),
    })
    return 'failed'
  }

  try {
    if (await isRouterHealthy()) {
      return 'reused'
    }

    const pid = spawnRouterDaemon()
    logToFile('info', 'Started router daemon bootstrap.', {
      pid,
      dashboardPort: getDashboardPort(),
      proxyPort: getProxyPort(),
      healthUrl: getHealthUrl(),
    })

    const waited = await waitForRouterHealthy(10_000, pid)
    if (!waited.healthy) {
      logToFile('error', waited.childExited
        ? 'Router daemon exited before becoming healthy.'
        : 'Router daemon failed to become healthy before timeout.', {
        pid,
        healthUrl: getHealthUrl(),
        proxyPort: getProxyPort(),
        bootstrapLogTail: readBootstrapLogTail(),
      })
      return 'failed'
    }

    const state = readPidState()
    logToFile('info', 'Router daemon is healthy and ready.', {
      pid: state?.pid ?? pid,
      dashboardPort: getDashboardPort(),
      proxyPort: getProxyPort(),
    })
    return 'started'
  } finally {
    removeBootstrapLock()
  }
}

const OpenCodeGoMultiAuthPlugin: Plugin = async ({ client }) => {
  setPluginMode(true)
  const status = await ensureRouterDaemon()

  await client.app.log({
    body: {
      service: 'opencode-go-multi-auth',
      level: status === 'failed' ? 'error' : 'info',
      message: status === 'started'
        ? 'Multi-auth router daemon started.'
        : status === 'reused'
          ? 'Multi-auth router daemon reused.'
          : 'Multi-auth router daemon failed to start.',
    },
  }).catch(() => {})

  return {
    dispose: async () => {
      // Shared daemon stays alive across OpenCode session exits.
    },
  }
}

export const server = OpenCodeGoMultiAuthPlugin
export const pluginModule: PluginModule = {
  id: 'opencode-go-multi-auth',
  server: OpenCodeGoMultiAuthPlugin,
}
export default OpenCodeGoMultiAuthPlugin
