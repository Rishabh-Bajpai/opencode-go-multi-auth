const RETRY_TEXT = /(?:retry[\s-]*after|try again in)\s*(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i

export function isQuota429(statusCode: number, headers: Record<string, string>, body: string): boolean {
  if (statusCode !== 429 && statusCode !== 402) return false

  if (statusCode === 402) return true

  if (headers['x-ratelimit-reason']?.toLowerCase().includes('quota')) return true

  try {
    const json = JSON.parse(body)

    const error = json.error ?? json
    if (!error) return false

    const code = String(error.code ?? '').toLowerCase()
    if (code === 'insufficient_quota' || code === 'usage_not_included') return true

    const type = String(error.type ?? '').toLowerCase()
    if (type.includes('quota') || type.includes('usage') || type.includes('freeusagelimit')) return true

    const message = String(error.message ?? json.message ?? '').toLowerCase()
    if (
      message.includes('quota') ||
      message.includes('exhausted') ||
      message.includes('usage limit') ||
      message.includes('credit balance') ||
      message.includes('billing limit') ||
      message.includes('insufficient_quota')
    ) {
      return true
    }

    return false
  } catch {
    return false
  }
}

export function parseRetryAfterHeaderMs(headers: Record<string, string>, now: number): number | null {
  const retryAfterMs = headers['retry-after-ms']
  if (retryAfterMs) {
    const parsed = Number.parseInt(retryAfterMs, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }

  const retryAfter = headers['retry-after']
  if (!retryAfter) return null

  const asSeconds = Number.parseInt(retryAfter, 10)
  if (Number.isFinite(asSeconds) && asSeconds > 0) return asSeconds * 1000

  const asDate = Date.parse(retryAfter)
  if (Number.isFinite(asDate) && asDate > now) return asDate - now

  return null
}

export function parseResetFromErrorBody(bodyText: string, now: number): number | null {
  try {
    const parsed = JSON.parse(bodyText)
    const error = parsed.error ?? parsed
    if (!error || typeof error !== 'object') return null

    const retryAfterMs = Number(error.retry_after_ms)
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs

    const retryAfterSeconds = Number(error.retry_after)
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return retryAfterSeconds * 1000

    const resetAtRaw = Number(error.resets_at ?? error.reset_at)
    if (Number.isFinite(resetAtRaw) && resetAtRaw > 0) {
      const resetAtMs = resetAtRaw < 10_000_000_000 ? resetAtRaw * 1000 : resetAtRaw
      if (resetAtMs > now) return resetAtMs - now
    }

    return null
  } catch {
    return null
  }
}

export function parseResetFromErrorText(bodyText: string, now: number): number | null {
  const match = bodyText.match(RETRY_TEXT)
  if (match) {
    const amount = parseInt(match[1], 10)
    const unit = match[2].toLowerCase()
    if (unit.startsWith('s')) return amount * 1000
    if (unit.startsWith('m')) return amount * 60_000
    if (unit.startsWith('h')) return amount * 3_600_000
  }

  const dateMatch = bodyText.match(/try again at\s+(.+?)[.\n]/i)
  if (dateMatch) {
    const parsed = Date.parse(dateMatch[1])
    if (Number.isFinite(parsed) && parsed > now) return parsed - now
  }

  return null
}

export function extractCodexResetMs(headers: Record<string, string>, now: number): number | null {
  let latest: number | null = null

  for (const prefix of ['x-codex-primary', 'x-codex-secondary']) {
    const resetAtRaw = headers[`${prefix}-reset-at`]
    if (resetAtRaw) {
      const resetAt = Number(resetAtRaw)
      if (Number.isFinite(resetAt) && resetAt > 0) {
        const resetAtMs = resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt
        if (resetAtMs > now && (latest === null || resetAtMs > latest)) {
          latest = resetAtMs
        }
      }
    }

    const resetAfterSeconds = headers[`${prefix}-reset-after-seconds`]
    if (resetAfterSeconds) {
      const parsed = Number(resetAfterSeconds)
      if (Number.isFinite(parsed) && parsed > 0) {
        const resetAt = now + parsed * 1000
        if (latest === null || resetAt > latest) latest = resetAt
      }
    }
  }

  const legacyReset = headers['x-ratelimit-reset']
  if (legacyReset) {
    const parsed = Number(legacyReset)
    if (Number.isFinite(parsed) && parsed > now) {
      if (latest === null || parsed > latest) latest = parsed
    }
  }

  if (latest !== null) return latest - now
  return null
}

export function resolveCooldownMs(
  headers: Record<string, string>,
  bodyText: string,
  now: number,
  fallbackMs: number,
): number {
  const candidates: number[] = [fallbackMs]

  const headerMs = parseRetryAfterHeaderMs(headers, now)
  if (headerMs !== null) candidates.push(headerMs)

  const bodyMs = parseResetFromErrorBody(bodyText, now)
  if (bodyMs !== null) candidates.push(bodyMs)

  const textMs = parseResetFromErrorText(bodyText, now)
  if (textMs !== null) candidates.push(textMs)

  const codexMs = extractCodexResetMs(headers, now)
  if (codexMs !== null) candidates.push(codexMs)

  return Math.max(...candidates)
}
