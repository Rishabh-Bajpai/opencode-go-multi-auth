import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface DaemonPidState {
  pid: number
  startedAt: number
}

function getConfigDir(): string {
  const dir = process.env.CONFIG_DIR || path.join(os.homedir(), '.opencode')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getRuntimePaths() {
  const dir = getConfigDir()
  return {
    dir,
    pidFile: path.join(dir, 'router.pid'),
    bootstrapLockFile: path.join(dir, 'router-bootstrap.lock'),
    bootstrapLogFile: path.join(dir, 'router-bootstrap.log'),
  }
}

export function readPidState(): DaemonPidState | null {
  try {
    const { pidFile } = getRuntimePaths()
    if (!fs.existsSync(pidFile)) return null

    const raw = fs.readFileSync(pidFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DaemonPidState>
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null
    }

    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function writePidState(state: DaemonPidState): void {
  const { pidFile } = getRuntimePaths()
  fs.writeFileSync(pidFile, JSON.stringify(state), 'utf8')
}

export function removePidState(): void {
  try {
    const { pidFile } = getRuntimePaths()
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile)
    }
  } catch {
    // Best-effort cleanup only.
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String((error as { code?: unknown }).code)
      if (code === 'EPERM') return true
    }
    return false
  }
}
