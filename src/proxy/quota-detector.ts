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
