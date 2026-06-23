import type {
  ApiKey,
  KeySelection,
  KeySelectionContext,
  KeyStatus,
  RouterConfig,
  StoredApiKey,
} from './types.js'
import { RoutingStrategy } from './types.js'

export class KeyManager {
  private keys: ApiKey[] = []
  private roundRobinIndex = 0
  private weightedCursor = 0
  private readonly cooldownMs: number

  constructor(config?: Partial<RouterConfig>) {
    this.cooldownMs = config?.cooldownMs ?? 5 * 60 * 60 * 1000
  }

  getKeys(): ApiKey[] {
    return this.keys
  }

  getActiveKeys(): ApiKey[] {
    const now = Date.now()
    return this.keys.filter(k => {
      if (!k.enabled) return false
      if (k.status === 'active') return true
      if (k.status === 'cooldown' && k.cooldownUntil && k.cooldownUntil <= now) {
        k.status = 'active'
        k.cooldownUntil = null
        return true
      }
      return false
    })
  }

  getKeyById(id: string): ApiKey | undefined {
    return this.keys.find(k => k.id === id)
  }

  addKey(key: string, alias?: string, options?: Partial<StoredApiKey>): ApiKey {
    const id = options?.id || crypto.randomUUID()
    const entry: ApiKey = {
      id,
      key,
      alias: alias || `Key ${this.keys.length + 1}`,
      addedAt: options?.addedAt ?? Date.now(),
      enabled: options?.enabled ?? true,
      priority: this.normalizePriority(options?.priority),
      weight: this.normalizeWeight(options?.weight),
      status: 'active',
      cooldownUntil: null,
      consecutiveErrors: 0,
      tokensUsed: 0,
      costAccumulated: 0,
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      averageLatencyMs: 0,
      lastUsedAt: null,
      lastStatusCode: null,
      lastModel: null,
      lastSessionId: null,
    }
    this.keys.push(entry)
    this.sortKeys()
    return entry
  }

  loadStoredKeys(keys: StoredApiKey[]): void {
    this.keys = []
    for (const entry of keys) {
      this.addKey(entry.key, entry.alias, entry)
    }
  }

  removeKey(id: string): boolean {
    const idx = this.keys.findIndex(k => k.id === id)
    if (idx === -1) return false
    this.keys.splice(idx, 1)
    if (this.roundRobinIndex >= this.keys.length) {
      this.roundRobinIndex = 0
    }
    return true
  }

  getNextKey(strategy: RoutingStrategy, context: KeySelectionContext = {}): KeySelection | null {
    const active = this.getCandidateKeys(context)
    if (active.length === 0) return null

    switch (strategy) {
      case RoutingStrategy.PRIORITY_FAILOVER: {
        const key = this.sortByPriority(active)[0]
        return { key, reason: `Priority failover selected highest priority key (${key.alias}).` }
      }
      case RoutingStrategy.PRIORITY_SPILLOVER: {
        const usageByKey = context.usageByKey ?? new Map()
        const threshold = context.proactiveSwitchThreshold ?? 0.95
        const sorted = this.sortByPriority(active)
        const preferred = sorted.find((key) => (usageByKey.get(key.id)?.percentUsed ?? 0) < threshold) ?? sorted[0]
        const usage = usageByKey.get(preferred.id)?.percentUsed
        return {
          key: preferred,
          reason: usage !== undefined && usage >= threshold
            ? `Priority spillover skipped fuller keys and selected ${preferred.alias}.`
            : `Priority spillover kept traffic on ${preferred.alias}.`,
        }
      }
      case RoutingStrategy.ROUND_ROBIN: {
        const key = active[this.roundRobinIndex % active.length]
        this.roundRobinIndex = (this.roundRobinIndex + 1) % active.length
        return { key, reason: `Round robin advanced to ${key.alias}.` }
      }
      case RoutingStrategy.WEIGHTED_ROUND_ROBIN: {
        const weighted = this.buildWeightedPool(active)
        const key = weighted[this.weightedCursor % weighted.length]
        this.weightedCursor = (this.weightedCursor + 1) % weighted.length
        return { key, reason: `Weighted cycle selected ${key.alias} using weight ${key.weight}.` }
      }
      case RoutingStrategy.HIGHEST_REMAINING_QUOTA: {
        const usageByKey = context.usageByKey ?? new Map()
        const sorted = [...active].sort((a, b) => {
          const remainingDiff = (usageByKey.get(b.id)?.remaining ?? Infinity) - (usageByKey.get(a.id)?.remaining ?? Infinity)
          if (remainingDiff !== 0) return remainingDiff
          if (a.priority !== b.priority) return a.priority - b.priority
          return a.alias.localeCompare(b.alias)
        })
        const key = sorted[0]
        return { key, reason: `Highest remaining quota selected ${key.alias}.` }
      }
    }
  }

  markExhausted(id: string, cooldownMs?: number): void {
    const key = this.getKeyById(id)
    if (!key) return
    key.status = 'cooldown'
    key.cooldownUntil = Date.now() + (cooldownMs ?? this.cooldownMs)
  }

  markError(id: string): void {
    const key = this.getKeyById(id)
    if (!key) return
    key.consecutiveErrors++
  }

  resetCooldown(id: string): void {
    const key = this.getKeyById(id)
    if (!key) return
    key.status = 'active'
    key.cooldownUntil = null
    key.consecutiveErrors = 0
  }

  setEnabled(id: string, enabled: boolean): ApiKey | null {
    const key = this.getKeyById(id)
    if (!key) return null
    key.enabled = enabled
    if (!enabled) {
      key.cooldownUntil = null
    } else if (key.status === 'cooldown' && key.cooldownUntil && key.cooldownUntil <= Date.now()) {
      key.status = 'active'
      key.cooldownUntil = null
    }
    this.sortKeys()
    return key
  }

  updateKeySettings(id: string, updates: Partial<Pick<ApiKey, 'alias' | 'enabled' | 'priority' | 'weight'>>): ApiKey | null {
    const key = this.getKeyById(id)
    if (!key) return null

    if (typeof updates.alias === 'string' && updates.alias.trim()) {
      key.alias = updates.alias.trim()
    }
    if (typeof updates.enabled === 'boolean') {
      key.enabled = updates.enabled
    }
    if (typeof updates.priority === 'number') {
      key.priority = this.normalizePriority(updates.priority)
    }
    if (typeof updates.weight === 'number') {
      key.weight = this.normalizeWeight(updates.weight)
    }

    this.sortKeys()
    return key
  }

  recordRequest(id: string, details: {
    statusCode: number
    durationMs: number
    model?: string | null
    sessionId?: string | null
    successful: boolean
  }): void {
    const key = this.getKeyById(id)
    if (!key) return

    key.requestCount++
    if (details.successful) {
      key.successCount++
    } else {
      key.errorCount++
    }
    key.averageLatencyMs = key.requestCount === 1
      ? details.durationMs
      : ((key.averageLatencyMs * (key.requestCount - 1)) + details.durationMs) / key.requestCount
    key.lastUsedAt = Date.now()
    key.lastStatusCode = details.statusCode
    key.lastModel = details.model ?? key.lastModel
    key.lastSessionId = details.sessionId ?? key.lastSessionId
  }

  toStoredEntries(): StoredApiKey[] {
    return this.keys.map((key) => ({
      id: key.id,
      key: key.key,
      alias: key.alias,
      addedAt: key.addedAt,
      enabled: key.enabled,
      priority: key.priority,
      weight: key.weight,
    }))
  }

  private getCandidateKeys(context: KeySelectionContext): ApiKey[] {
    const excluded = context.excludeKeyIds ?? new Set<string>()
    return this.getActiveKeys().filter((key) => !excluded.has(key.id))
  }

  private sortKeys(): void {
    this.keys.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.addedAt - b.addedAt
    })
  }

  private sortByPriority(keys: ApiKey[]): ApiKey[] {
    return [...keys].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.addedAt - b.addedAt
    })
  }

  private buildWeightedPool(keys: ApiKey[]): ApiKey[] {
    const sorted = this.sortByPriority(keys)
    const pool: ApiKey[] = []
    for (const key of sorted) {
      for (let i = 0; i < key.weight; i++) {
        pool.push(key)
      }
    }
    return pool.length ? pool : sorted
  }

  private normalizePriority(value?: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 1
    return Math.max(1, Math.round(value))
  }

  private normalizeWeight(value?: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 1
    return Math.max(1, Math.round(value))
  }
}
