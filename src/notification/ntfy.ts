import { logToFile } from '../logging/logger.js'

const PRIORITY_MAP: Record<string, number> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  urgent: 5,
}

export class NtfyNotifier {
  private readonly url: string

  constructor(ntfyUrl?: string) {
    this.url = (ntfyUrl ?? '').replace(/\/+$/, '')
  }

  get enabled(): boolean {
    return this.url.length > 0
  }

  async send(title: string, message: string, priority: keyof typeof PRIORITY_MAP = 'default'): Promise<void> {
    if (!this.enabled) return

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Title': title,
          'Priority': String(PRIORITY_MAP[priority] ?? 3),
          'Tags': priority === 'urgent' ? 'warning' : priority === 'high' ? 'rotating_light' : 'information_source',
          'Content-Type': 'text/plain',
        },
        body: message,
      })

      if (!response.ok) {
        logToFile('error', `NTFY send failed: HTTP ${response.status}`)
      }
    } catch (err) {
      logToFile('error', `NTFY error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async keyExhausted(alias: string, statusCode: number, remainingKeys: number): Promise<void> {
    if (!this.enabled) return
    await this.send(
      `Key Exhausted: ${alias}`,
      `API key "${alias}" exhausted (HTTP ${statusCode}). ${remainingKeys > 0 ? `Failing over to next key (${remainingKeys} remaining).` : 'No backup keys available.'}`,
      remainingKeys > 0 ? 'high' : 'urgent',
    )
  }

  async allKeysExhausted(keyCount: number): Promise<void> {
    if (!this.enabled) return
    await this.send(
      'All API Keys Exhausted',
      `All ${keyCount} API key(s) are exhausted. No keys available for routing. Add new keys or wait for cooldown to reset.`,
      'urgent',
    )
  }

  async circuitTripped(alias: string, errors: number): Promise<void> {
    if (!this.enabled) return
    await this.send(
      `Circuit Breaker: ${alias}`,
      `Circuit breaker OPEN for key "${alias}" after ${errors} consecutive 5xx errors. Temporarily removing from pool.`,
      'high',
    )
  }

  async circuitRecovered(alias: string): Promise<void> {
    if (!this.enabled) return
    await this.send(
      `Circuit Recovered: ${alias}`,
      `Circuit breaker CLOSED for key "${alias}". Key is now available for routing.`,
      'low',
    )
  }

  async proactiveSwitch(alias: string, percentUsed: number): Promise<void> {
    if (!this.enabled) return
    await this.send(
      `Proactive Switch: ${alias}`,
      `Key "${alias}" at ${(percentUsed * 100).toFixed(0)}% quota usage. Switching to next key preemptively.`,
      'low',
    )
  }
}
