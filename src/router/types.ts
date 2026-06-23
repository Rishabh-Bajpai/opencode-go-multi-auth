export type KeyStatus = 'active' | 'cooldown' | 'exhausted' | 'error'

export interface ApiKey {
  id: string
  key: string
  alias: string
  addedAt: number
  enabled: boolean
  priority: number
  weight: number
  status: KeyStatus
  cooldownUntil: number | null
  consecutiveErrors: number
  tokensUsed: number
  costAccumulated: number
  requestCount: number
  successCount: number
  errorCount: number
  averageLatencyMs: number
  lastUsedAt: number | null
  lastStatusCode: number | null
  lastModel: string | null
  lastSessionId: string | null
}

export interface StoredApiKey {
  id: string
  key: string
  alias: string
  addedAt: number
  enabled: boolean
  priority: number
  weight: number
}

export enum RoutingStrategy {
  PRIORITY_FAILOVER = 'priority_failover',
  PRIORITY_SPILLOVER = 'priority_spillover',
  ROUND_ROBIN = 'round_robin',
  WEIGHTED_ROUND_ROBIN = 'weighted_round_robin',
  HIGHEST_REMAINING_QUOTA = 'highest_remaining_quota',
}

export interface RoutingStrategyInfo {
  value: RoutingStrategy
  label: string
  description: string
  bestFor: string
  behavior: string
  cacheFriendly: boolean
  usesPriority: boolean
  usesWeight: boolean
  recommended?: boolean
}

export interface UsageSnapshot {
  costAccumulated: number
  remaining: number
  percentUsed: number
}

export interface KeySelectionContext {
  usageByKey?: Map<string, UsageSnapshot>
  proactiveSwitchThreshold?: number
  excludeKeyIds?: Set<string>
}

export interface KeySelection {
  key: ApiKey
  reason: string
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
  strategy: RoutingStrategy
  ntfyUrl: string
  proactiveSwitchThreshold: number
  requestTimeoutMs: number
  upstreamHungTimeoutMs: number
}

export const ROUTING_STRATEGIES: RoutingStrategyInfo[] = [
  {
    value: RoutingStrategy.PRIORITY_FAILOVER,
    label: 'Priority Failover',
    description: 'Keep one account warm for cache reuse and only move to the next account when the current one is unavailable.',
    bestFor: 'Best default for cache-heavy coding sessions.',
    behavior: 'Always uses the lowest priority number first. Session stickiness can still pin a warm conversation to its current account.',
    cacheFriendly: true,
    usesPriority: true,
    usesWeight: false,
    recommended: true,
  },
  {
    value: RoutingStrategy.PRIORITY_SPILLOVER,
    label: 'Priority Spillover',
    description: 'Stay on the primary account until it nears the quota threshold, then spill new requests to the next priority account.',
    bestFor: 'Good when you want warm caches but fewer hard quota cutovers.',
    behavior: 'Checks keys in priority order and skips any key that is already beyond the proactive switch threshold.',
    cacheFriendly: true,
    usesPriority: true,
    usesWeight: false,
  },
  {
    value: RoutingStrategy.ROUND_ROBIN,
    label: 'Round Robin',
    description: 'Cycle requests evenly across active accounts.',
    bestFor: 'Simple spreading when cache reuse is less important than fairness.',
    behavior: 'Each new uncached request advances to the next active account. Sticky sessions still keep warm conversations on one account.',
    cacheFriendly: false,
    usesPriority: false,
    usesWeight: false,
  },
  {
    value: RoutingStrategy.WEIGHTED_ROUND_ROBIN,
    label: 'Weighted Cycle',
    description: 'Cycle requests across accounts in proportion to each key weight.',
    bestFor: 'Use when some accounts should receive more traffic than others.',
    behavior: 'A key with weight 4 receives roughly four times as many fresh requests as a key with weight 1.',
    cacheFriendly: false,
    usesPriority: false,
    usesWeight: true,
  },
  {
    value: RoutingStrategy.HIGHEST_REMAINING_QUOTA,
    label: 'Highest Remaining Quota',
    description: 'Choose the active account with the most remaining quota headroom.',
    bestFor: 'Useful when you want to preserve the fullest accounts for long sessions.',
    behavior: 'Ranks accounts by remaining monthly quota, then falls back to priority ordering when tied.',
    cacheFriendly: false,
    usesPriority: true,
    usesWeight: false,
  },
]

export function normalizeRoutingStrategy(value?: string): RoutingStrategy {
  if (value === 'exhaustion_failover') return RoutingStrategy.PRIORITY_FAILOVER
  if (value && Object.values(RoutingStrategy).includes(value as RoutingStrategy)) {
    return value as RoutingStrategy
  }
  return RoutingStrategy.PRIORITY_FAILOVER
}

export function getRoutingStrategyInfo(strategy: RoutingStrategy): RoutingStrategyInfo {
  return ROUTING_STRATEGIES.find(entry => entry.value === strategy) ?? ROUTING_STRATEGIES[0]
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
  strategy: RoutingStrategy.PRIORITY_FAILOVER,
  ntfyUrl: '',
  proactiveSwitchThreshold: 0.95,
  requestTimeoutMs: 0,
  upstreamHungTimeoutMs: 0,
}

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}
