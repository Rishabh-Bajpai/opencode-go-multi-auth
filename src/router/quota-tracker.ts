import type { ApiKey } from './types.js'

interface QuotaData {
  keyId: string
  tokensUsed: number
  costAccumulated: number
}

export class QuotaTracker {
  private quotaMap: Map<string, QuotaData> = new Map()
  private readonly quotaLimit: number
  private static readonly PROACTIVE_THRESHOLD = 0.95

  constructor(quotaLimit = 60) {
    this.quotaLimit = quotaLimit
  }

  getUsage(keyId: string): { tokensUsed: number; costAccumulated: number; remaining: number; percentUsed: number } {
    const data = this.quotaMap.get(keyId) ?? { keyId, tokensUsed: 0, costAccumulated: 0 }
    const remaining = Math.max(0, this.quotaLimit - data.costAccumulated)
    const percentUsed = this.quotaLimit > 0 ? data.costAccumulated / this.quotaLimit : 0
    return { ...data, remaining, percentUsed }
  }

  recordUsage(keyId: string, tokensUsed: number, cost: number): void {
    let data = this.quotaMap.get(keyId)
    if (!data) {
      data = { keyId, tokensUsed: 0, costAccumulated: 0 }
      this.quotaMap.set(keyId, data)
    }
    data.tokensUsed += tokensUsed
    data.costAccumulated += cost
  }

  shouldProactiveSwitch(keyId: string): boolean {
    const usage = this.getUsage(keyId)
    return usage.percentUsed >= QuotaTracker.PROACTIVE_THRESHOLD
  }

  isExhausted(keyId: string): boolean {
    const usage = this.getUsage(keyId)
    return usage.costAccumulated >= this.quotaLimit
  }

  applyStateToKey(key: ApiKey): void {
    const usage = this.getUsage(key.id)
    key.tokensUsed = usage.tokensUsed
    key.costAccumulated = usage.costAccumulated
  }
}
