import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { StoredApiKey } from '../router/types.js'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const TAG_LENGTH = 16
const SALT_LENGTH = 32
const PBKDF2_ITERATIONS = 600_000
const DIGEST = 'sha512'

interface EncryptedPayload {
  salt: string
  iv: string
  tag: string
  data: string
}

export class SecureStore {
  private readonly filePath: string
  private masterKey?: Buffer

  constructor(configDir: string) {
    const dir = configDir || path.join(os.homedir(), '.opencode')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.filePath = path.join(dir, 'router-keys.enc')
  }

  private deriveKey(): Buffer {
    if (this.masterKey) return this.masterKey

    const machineId = `${os.hostname()}-${os.userInfo().username}`
    const salt = crypto.createHash('sha256').update(machineId).digest().subarray(0, SALT_LENGTH)
    this.masterKey = crypto.pbkdf2Sync(machineId, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST)
    return this.masterKey
  }

  async saveKeys(keys: StoredApiKey[]): Promise<void> {
    const key = this.deriveKey()
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    const salt = crypto.randomBytes(SALT_LENGTH)

    const plaintext = JSON.stringify(keys)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    const payload: EncryptedPayload = {
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: encrypted.toString('hex'),
    }

    fs.writeFileSync(this.filePath, JSON.stringify(payload), 'utf8')
  }

  async loadKeys(): Promise<StoredApiKey[]> {
    if (!fs.existsSync(this.filePath)) return []

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const payload: EncryptedPayload = JSON.parse(raw)

      const key = this.deriveKey()
      const iv = Buffer.from(payload.iv, 'hex')
      const tag = Buffer.from(payload.tag, 'hex')
      const encrypted = Buffer.from(payload.data, 'hex')

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(tag)

      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
      const parsed = JSON.parse(decrypted.toString('utf8'))
      if (!Array.isArray(parsed)) return []

      return parsed
        .map((entry) => this.normalizeEntry(entry))
        .filter((entry): entry is StoredApiKey => entry !== null)
    } catch {
      return []
    }
  }

  async addKey(entry: StoredApiKey): Promise<void> {
    const keys = await this.loadKeys()
    keys.push(entry)
    await this.saveKeys(keys)
  }

  async removeKey(id: string): Promise<void> {
    let keys = await this.loadKeys()
    keys = keys.filter(k => k.id !== id)
    await this.saveKeys(keys)
  }

  async updateKey(entry: StoredApiKey): Promise<void> {
    const keys = await this.loadKeys()
    const idx = keys.findIndex(key => key.id === entry.id)
    if (idx === -1) {
      keys.push(entry)
    } else {
      keys[idx] = entry
    }
    await this.saveKeys(keys)
  }

  private normalizeEntry(entry: unknown): StoredApiKey | null {
    if (!entry || typeof entry !== 'object') return null
    const value = entry as Record<string, unknown>
    const key = typeof value.key === 'string' ? value.key : null
    const alias = typeof value.alias === 'string' && value.alias.trim() ? value.alias : null
    if (!key || !alias) return null

    return {
      id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
      key,
      alias,
      addedAt: typeof value.addedAt === 'number' ? value.addedAt : Date.now(),
      enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
      priority: typeof value.priority === 'number' && Number.isFinite(value.priority) ? value.priority : 1,
      weight: typeof value.weight === 'number' && Number.isFinite(value.weight) ? value.weight : 1,
    }
  }

  keyExists(): boolean {
    return fs.existsSync(this.filePath)
  }
}
