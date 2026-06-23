const SESSION_TTL_MS = 20 * 60 * 1000
const MAX_ENTRIES = 512

interface SessionEntry {
  keyId: string
  createdAt: number
}

export class SessionAffinityStore {
  private sessions: Map<string, SessionEntry> = new Map()

  getPreferredKey(sessionKey: string): string | undefined {
    const entry = this.sessions.get(sessionKey)
    if (!entry) return undefined

    const age = Date.now() - entry.createdAt
    if (age > SESSION_TTL_MS) {
      this.sessions.delete(sessionKey)
      return undefined
    }
    return entry.keyId
  }

  setPreferredKey(sessionKey: string, keyId: string): void {
    if (this.sessions.size >= MAX_ENTRIES) {
      const oldest = this.sessions.entries().next()
      if (oldest.value) {
        this.sessions.delete(oldest.value[0])
      }
    }
    this.sessions.set(sessionKey, { keyId, createdAt: Date.now() })
  }

  clear(): void {
    this.sessions.clear()
  }

  extractSessionKey(headers: Record<string, string | string[] | undefined>): string | undefined {
    const sessionId = this.getHeader(headers, 'x-session-id')
    if (sessionId) return sessionId

    const promptKey = this.getHeader(headers, 'prompt-cache-key')
    if (promptKey) return promptKey

    const promptKeyUnderscore = this.getHeader(headers, 'prompt_cache_key')
    if (promptKeyUnderscore) return promptKeyUnderscore

    const cacheControl = this.getHeader(headers, 'cache_control')
    if (cacheControl) return cacheControl

    return undefined
  }

  private getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const val = headers[name] ?? headers[name.toLowerCase()]
    if (!val) return undefined
    return Array.isArray(val) ? val[0] : val
  }
}
