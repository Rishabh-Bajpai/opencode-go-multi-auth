import type { TokenBreakdown } from '../proxy/response-parser.js'
import type { ApiKey } from './types.js'

interface QuotaEntry {
  keyId: string
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  tokensReasoning: number
  costAccumulated: number
}

export class QuotaTracker {
  private store: Map<string, QuotaEntry> = new Map()
  private readonly quotaLimit: number

  constructor(quotaLimit = 60) {
    this.quotaLimit = quotaLimit
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
    return { keyId, tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0, costAccumulated: 0 }
  }
}
