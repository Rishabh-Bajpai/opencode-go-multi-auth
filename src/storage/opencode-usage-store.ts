import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface UsageWindowSummary {
  cost: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface OpenCodeUsageSummary {
  available: boolean
  dbPath: string
  rolling30d: UsageWindowSummary
  trailing7d: UsageWindowSummary
  calendarMonth: UsageWindowSummary
  allTime: UsageWindowSummary
  lastUpdatedAt: number | null
}

const EMPTY_WINDOW: UsageWindowSummary = {
  cost: 0,
  sessions: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
}

export class OpenCodeUsageStore {
  private readonly dbPath: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.OPENCODE_DB_PATH || path.join(os.homedir(), '.local/share/opencode/opencode.db')
  }

  getSummary(now: number = Date.now()): OpenCodeUsageSummary {
    if (!fs.existsSync(this.dbPath)) {
      return {
        available: false,
        dbPath: this.dbPath,
        rolling30d: { ...EMPTY_WINDOW },
        trailing7d: { ...EMPTY_WINDOW },
        calendarMonth: { ...EMPTY_WINDOW },
        allTime: { ...EMPTY_WINDOW },
        lastUpdatedAt: null,
      }
    }

    try {
      const trailing7dStart = now - (7 * 24 * 60 * 60 * 1000)
      const rolling30dStart = now - (30 * 24 * 60 * 60 * 1000)
      const current = new Date(now)
      const monthStart = new Date(current.getFullYear(), current.getMonth(), 1).getTime()

      return {
        available: true,
        dbPath: this.dbPath,
        trailing7d: this.queryWindow(trailing7dStart),
        rolling30d: this.queryWindow(rolling30dStart),
        calendarMonth: this.queryWindow(monthStart),
        allTime: this.queryWindow(),
        lastUpdatedAt: this.queryLastUpdatedAt(),
      }
    } catch {
      return {
        available: false,
        dbPath: this.dbPath,
        rolling30d: { ...EMPTY_WINDOW },
        trailing7d: { ...EMPTY_WINDOW },
        calendarMonth: { ...EMPTY_WINDOW },
        allTime: { ...EMPTY_WINDOW },
        lastUpdatedAt: null,
      }
    }
  }

  private queryWindow(startMs?: number): UsageWindowSummary {
    const whereClause = typeof startMs === 'number' ? ` where time_updated >= ${Math.floor(startMs)}` : ''
    const sql = [
      'select',
      'coalesce(sum(cost), 0),',
      'count(*),',
      'coalesce(sum(tokens_input), 0),',
      'coalesce(sum(tokens_output), 0),',
      'coalesce(sum(tokens_cache_read), 0),',
      'coalesce(sum(tokens_cache_write), 0),',
      'coalesce(sum(tokens_reasoning), 0)',
      `from session${whereClause};`,
    ].join(' ')
    const output = this.exec(sql).trim()
    const [cost, sessions, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens] = output.split('|')
    return {
      cost: Number(cost || 0),
      sessions: Number(sessions || 0),
      inputTokens: Number(inputTokens || 0),
      outputTokens: Number(outputTokens || 0),
      cacheReadTokens: Number(cacheReadTokens || 0),
      cacheWriteTokens: Number(cacheWriteTokens || 0),
      reasoningTokens: Number(reasoningTokens || 0),
    }
  }

  private queryLastUpdatedAt(): number | null {
    const output = this.exec('select max(time_updated) from session;').trim()
    const value = Number(output || 0)
    return Number.isFinite(value) && value > 0 ? value : null
  }

  private exec(sql: string): string {
    return execFileSync('sqlite3', ['-readonly', this.dbPath, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  }
}
