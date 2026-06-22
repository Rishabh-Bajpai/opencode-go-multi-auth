import type { TokenBreakdown } from '../proxy/response-parser.js'
import type { ApiKey } from './types.js'

interface UsageEntry {
  cost: number
  timestamp: number
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

  constructor(quotaLimit = 60, maxLogSize = 2000) {
    this.quotaLimit = quotaLimit
    this.maxLogSize = maxLogSize
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

  recordUsage(keyId: string, tokens: TokenBreakdown, cost: number): void {
    let e = this.store.get(keyId)
    if (!e) { e = this.emptyEntry(keyId); this.store.set(keyId, e) }
    e.tokensInput += tokens.input
    e.tokensOutput += tokens.output
    e.tokensCacheRead += tokens.cacheRead
    e.tokensCacheWrite += tokens.cacheWrite
    e.tokensReasoning += tokens.reasoning
    e.costAccumulated += cost

    e.usageLog.push({ cost, timestamp: Date.now() })
    if (e.usageLog.length > this.maxLogSize) {
      e.usageLog = e.usageLog.slice(-this.maxLogSize)
    }
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

  private emptyEntry(keyId: string): QuotaEntry {
    return { keyId, tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0, costAccumulated: 0, usageLog: [] }
  }
}
