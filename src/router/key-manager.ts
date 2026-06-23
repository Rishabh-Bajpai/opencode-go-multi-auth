import type { ApiKey, KeyStatus, RouterConfig } from './types.js'
import { RoutingStrategy } from './types.js'

export class KeyManager {
  private keys: ApiKey[] = []
  private roundRobinIndex = 0
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
      if (k.status === 'disabled') return false
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

  addKey(key: string, alias?: string): ApiKey {
    const id = crypto.randomUUID()
    const entry: ApiKey = {
      id,
      key,
      alias: alias || `Key ${this.keys.length + 1}`,
      addedAt: Date.now(),
      status: 'active',
      cooldownUntil: null,
      consecutiveErrors: 0,
      tokensUsed: 0,
      costAccumulated: 0,
    }
    this.keys.push(entry)
    return entry
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

  getNextKey(strategy: RoutingStrategy): ApiKey | null {
    const active = this.getActiveKeys()
    if (active.length === 0) return null

    switch (strategy) {
      case RoutingStrategy.EXHAUSTION_FAILOVER: {
        return active[0]
      }
      case RoutingStrategy.ROUND_ROBIN: {
        const key = active[this.roundRobinIndex % active.length]
        this.roundRobinIndex = (this.roundRobinIndex + 1) % active.length
        return key
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

  toggleKey(id: string): { status: KeyStatus } | null {
    const key = this.getKeyById(id)
    if (!key) return null
    key.status = key.status === 'disabled' ? 'active' : 'disabled'
    return { status: key.status }
  }
}
