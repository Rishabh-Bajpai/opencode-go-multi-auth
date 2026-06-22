const CACHE_HEADERS = new Set([
  'x-session-id',
  'prompt-cache-key',
  'cache-control',
])

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
])

const FORWARDED_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'content-type',
  'anthropic-version', 'anthropic-beta',
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

export function buildUpstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
  bearerToken: string,
  host: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'authorization': `Bearer ${bearerToken}`,
    'host': host,
    'content-type': 'application/json',
  }

  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase()

    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'authorization' || lower === 'host' || lower === 'content-length') continue
    if (lower.startsWith('sec-') || lower.startsWith('cf-')) continue

    if (CACHE_HEADERS.has(lower) || FORWARDED_HEADERS.has(lower)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    }
  }

  return headers
}

export function logCacheMissWarning(keyAlias: string): void {
  console.warn(`[CACHE-MISS] Failover to "${keyAlias}" — cold start, no cached context`)
}
