const CACHE_HEADERS = new Set([
  'x-session-id',
  'prompt-cache-key',
  'cache-control',
])

export function isCacheHeader(name: string): boolean {
  return CACHE_HEADERS.has(name.toLowerCase())
}

export function extractCacheHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (isCacheHeader(key) && value !== undefined) {
      result[key] = Array.isArray(value) ? value.join(', ') : String(value)
    }
  }
  return result
}

export function logCacheMissWarning(keyAlias: string): void {
  console.warn(`[CACHE-MISS] Failover to key "${keyAlias}" — first request on new key will not benefit from cached context (cold start)`)
}
