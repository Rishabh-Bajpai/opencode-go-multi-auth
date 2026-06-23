import type { TokenBreakdown } from '../proxy/response-parser.js'
import type { ApiKey } from './types.js'
import type { StoredQuotaEntry, StoredUsageLogEntry } from '../storage/runtime-state-store.js'

interface UsageEntry {
  cost: number
  timestamp: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

interface QuotaEntry {
  keyId: string
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  tokensReasoning: number
  costAccumulated: number
  usageLog: UsageEntry[]
}

const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MIN_COOLDOWN_MS = 60 * 60 * 1000

export class QuotaTracker {
  private store: Map<string, QuotaEntry> = new Map()
  private readonly quotaLimit: number
  private readonly maxLogSize: number
  private readonly onChange?: () => void

  constructor(quotaLimit = 60, maxLogSize = 2000, onChange?: () => void) {
    this.quotaLimit = quotaLimit
    this.maxLogSize = maxLogSize
    this.onChange = onChange
  }

  getUsage(keyId: string) {
    const e = this.store.get(keyId) ?? this.emptyEntry(keyId)
    const remaining = Math.max(0, this.quotaLimit - e.costAccumulated)
    const percentUsed = this.quotaLimit > 0 ? e.costAccumulated / this.quotaLimit : 0
    return {
      tokensInput: e.tokensInput,
      tokensOutput: e.tokensOutput,
      tokensCacheRead: e.tokensCacheRead,
      tokensCacheWrite: e.tokensCacheWrite,
      tokensReasoning: e.tokensReasoning,
      totalTokens: e.tokensInput + e.tokensOutput,
      costAccumulated: e.costAccumulated,
      remaining,
      percentUsed,
    }
  }

  getUsageBreakdown(keyId: string) {
    const usage = this.getUsage(keyId)
    return {
      ...usage,
      tokensBreakdown: {
        input: usage.tokensInput,
        output: usage.tokensOutput,
        cacheRead: usage.tokensCacheRead,
        cacheWrite: usage.tokensCacheWrite,
        reasoning: usage.tokensReasoning,
      },
    }
  }

  recordUsage(keyId: string, tokens: TokenBreakdown, cost: number): void {
    let e = this.store.get(keyId)
    if (!e) { e = this.emptyEntry(keyId); this.store.set(keyId, e) }
    e.tokensInput += tokens.input
    e.tokensOutput += tokens.output
    e.tokensCacheRead += tokens.cacheRead
    e.tokensCacheWrite += tokens.cacheWrite
    e.tokensReasoning += tokens.reasoning
    e.costAccumulated += cost

    e.usageLog.push({
      cost,
      timestamp: Date.now(),
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      reasoning: tokens.reasoning,
    })
    if (e.usageLog.length > this.maxLogSize) {
      e.usageLog = e.usageLog.slice(-this.maxLogSize)
    }
    this.onChange?.()
  }

  getWindowedUsage(keyId: string, windowMs: number, now: number = Date.now()) {
    const entry = this.store.get(keyId)
    const windowStart = now - windowMs
    const usageLog = entry?.usageLog.filter((item) => item.timestamp >= windowStart) ?? []
    return this.summarizeUsageLog(usageLog)
  }

  getCalendarMonthUsage(keyId: string, now: number = Date.now()) {
    const entry = this.store.get(keyId)
    const date = new Date(now)
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
    const usageLog = entry?.usageLog.filter((item) => item.timestamp >= monthStart) ?? []
    return this.summarizeUsageLog(usageLog)
  }

  getEstimatedCooldown(keyId: string, now: number = Date.now()): number | null {
    const e = this.store.get(keyId)
    if (!e || e.costAccumulated < this.quotaLimit) return null

    if (e.usageLog.length === 0) return null

    const windowStart = now - MONTHLY_WINDOW_MS
    const recent = e.usageLog.filter(entry => entry.timestamp >= windowStart)
    if (recent.length === 0) return null

    const recentTotal = recent.reduce((sum, entry) => sum + entry.cost, 0)
    if (recentTotal < this.quotaLimit) return null

    const sorted = [...recent].sort((a, b) => a.timestamp - b.timestamp)

    let cumulative = recentTotal
    for (const entry of sorted) {
      cumulative -= entry.cost
      if (cumulative < this.quotaLimit) {
        const ageOutAt = entry.timestamp + MONTHLY_WINDOW_MS
        const waitMs = ageOutAt - now
        if (waitMs <= 0) return MIN_COOLDOWN_MS
        return Math.max(MIN_COOLDOWN_MS, waitMs)
      }
    }

    const oldest = sorted[0]
    const ageOutAt = oldest.timestamp + MONTHLY_WINDOW_MS
    const waitMs = ageOutAt - now
    return Math.max(MIN_COOLDOWN_MS, waitMs)
  }

  shouldProactiveSwitch(keyId: string): boolean {
    return this.getUsage(keyId).percentUsed >= 0.95
  }

  isExhausted(keyId: string): boolean {
    return this.getUsage(keyId).costAccumulated >= this.quotaLimit
  }

  applyStateToKey(key: ApiKey): void {
    const u = this.getUsage(key.id)
    key.tokensUsed = u.totalTokens
    key.costAccumulated = u.costAccumulated
  }

  loadState(entries: StoredQuotaEntry[]): void {
    this.store = new Map()
    for (const entry of entries) {
      if (!entry || typeof entry.keyId !== 'string') continue
      this.store.set(entry.keyId, {
        keyId: entry.keyId,
        tokensInput: this.normalizeNumber(entry.tokensInput),
        tokensOutput: this.normalizeNumber(entry.tokensOutput),
        tokensCacheRead: this.normalizeNumber(entry.tokensCacheRead),
        tokensCacheWrite: this.normalizeNumber(entry.tokensCacheWrite),
        tokensReasoning: this.normalizeNumber(entry.tokensReasoning),
        costAccumulated: this.normalizeNumber(entry.costAccumulated),
        usageLog: Array.isArray(entry.usageLog)
          ? entry.usageLog.map((log) => this.normalizeUsageLog(log)).filter((log): log is UsageEntry => log !== null).slice(-this.maxLogSize)
          : [],
      })
    }
  }

  exportState(): StoredQuotaEntry[] {
    return [...this.store.values()].map((entry) => ({
      keyId: entry.keyId,
      tokensInput: entry.tokensInput,
      tokensOutput: entry.tokensOutput,
      tokensCacheRead: entry.tokensCacheRead,
      tokensCacheWrite: entry.tokensCacheWrite,
      tokensReasoning: entry.tokensReasoning,
      costAccumulated: entry.costAccumulated,
      usageLog: entry.usageLog.map((log) => ({
        timestamp: log.timestamp,
        cost: log.cost,
        input: log.input,
        output: log.output,
        cacheRead: log.cacheRead,
        cacheWrite: log.cacheWrite,
        reasoning: log.reasoning,
      })),
    }))
  }

  private emptyEntry(keyId: string): QuotaEntry {
    return { keyId, tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0, costAccumulated: 0, usageLog: [] }
  }

  private summarizeUsageLog(usageLog: UsageEntry[]) {
    return usageLog.reduce((summary, entry) => {
      summary.requests += 1
      summary.input += entry.input
      summary.output += entry.output
      summary.cacheRead += entry.cacheRead
      summary.cacheWrite += entry.cacheWrite
      summary.reasoning += entry.reasoning
      summary.totalTokens += entry.input + entry.output
      summary.cost += entry.cost
      return summary
    }, {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 0,
      cost: 0,
    })
  }

  private normalizeNumber(value?: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    return value
  }

  private normalizeUsageLog(entry: StoredUsageLogEntry): UsageEntry | null {
    if (!entry || typeof entry.timestamp !== 'number') return null
    return {
      timestamp: entry.timestamp,
      cost: this.normalizeNumber(entry.cost),
      input: this.normalizeNumber(entry.input),
      output: this.normalizeNumber(entry.output),
      cacheRead: this.normalizeNumber(entry.cacheRead),
      cacheWrite: this.normalizeNumber(entry.cacheWrite),
      reasoning: this.normalizeNumber(entry.reasoning),
    }
  }
}
