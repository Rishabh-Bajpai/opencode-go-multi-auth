import { WebSocketServer, WebSocket } from 'ws'
import http from 'node:http'
import type { AppLogger } from './logger.js'
import type { StoredLogEntry } from '../storage/runtime-state-store.js'

const MAX_RING_BUFFER = 5000

interface LogEntry {
  timestamp: string
  level: string
  message: string
  meta?: Record<string, unknown>
}

export class LogStream {
  private wss?: WebSocketServer
  private ringBuffer: LogEntry[] = []
  private clients: Set<WebSocket> = new Set()
  private readonly onChange?: () => void

  constructor(onChange?: () => void) {
    this.onChange = onChange
  }

  attach(server: http.Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws/logs' })

    this.wss.on('connection', (ws) => {
      this.clients.add(ws)

      for (const entry of this.ringBuffer) {
        ws.send(JSON.stringify(entry))
      }

      ws.on('close', () => {
        this.clients.delete(ws)
      })
    })
  }

  emit(logger: AppLogger, level: string, message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      meta,
    }

    this.ringBuffer.push(entry)
    if (this.ringBuffer.length > MAX_RING_BUFFER) {
      this.ringBuffer.shift()
    }
    this.onChange?.()

    const payload = JSON.stringify(entry)
    for (const ws of this.clients) {
      try {
        ws.send(payload)
      } catch {
        this.clients.delete(ws)
      }
    }

    switch (level) {
      case 'error': logger.error(message, meta); break
      case 'warn': logger.warn(message, meta); break
      case 'debug': logger.debug(message, meta); break
      default: logger.info(message, meta)
    }
  }

  getRecentLogs(count = MAX_RING_BUFFER): LogEntry[] {
    return this.ringBuffer.slice(-count)
  }

  load(entries: StoredLogEntry[]): void {
    this.ringBuffer = entries.slice(-MAX_RING_BUFFER).map((entry) => ({
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
      level: typeof entry.level === 'string' ? entry.level : 'info',
      message: typeof entry.message === 'string' ? entry.message : '',
      meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : undefined,
    }))
  }

  export(): StoredLogEntry[] {
    return [...this.ringBuffer]
  }

  stop(): void {
    this.wss?.close()
  }
}
