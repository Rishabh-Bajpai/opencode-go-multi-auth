export type KeyStatus = 'active' | 'cooldown' | 'exhausted' | 'error'

export interface ApiKey {
  id: string
  key: string
  alias: string
  addedAt: number
  status: KeyStatus
  cooldownUntil: number | null
  consecutiveErrors: number
  tokensUsed: number
  costAccumulated: number
}

export enum RoutingStrategy {
  EXHAUSTION_FAILOVER = 'exhaustion_failover',
  ROUND_ROBIN = 'round_robin',
}

export interface RouterConfig {
  upstreamUrl: string
  dashboardPort: number
  proxyPort: number
  quotaLimit: number
  cooldownMs: number
  circuitBreakerThreshold: number
  logLevel: string
  configDir: string
}

export const DEFAULT_CONFIG: RouterConfig = {
  upstreamUrl: 'https://opencode.ai/zen/go/v1',
  dashboardPort: 18904,
  proxyPort: 18905,
  quotaLimit: 60,
  cooldownMs: 5 * 60 * 60 * 1000,
  circuitBreakerThreshold: 3,
  logLevel: 'info',
  configDir: '',
}

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}
