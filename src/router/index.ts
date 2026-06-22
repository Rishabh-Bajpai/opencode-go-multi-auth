import { KeyManager } from './key-manager.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { QuotaTracker } from './quota-tracker.js'
import type { RouterConfig } from './types.js'

export interface RouterInstance {
  keyManager: KeyManager
  circuitBreaker: CircuitBreaker
  quotaTracker: QuotaTracker
  shutdown: () => Promise<void>
}

export async function createRouter(config?: Partial<RouterConfig>): Promise<RouterInstance> {
  const keyManager = new KeyManager()
  const circuitBreaker = new CircuitBreaker()
  const quotaTracker = new QuotaTracker()

  return {
    keyManager,
    circuitBreaker,
    quotaTracker,
    shutdown: async () => {},
  }
}
