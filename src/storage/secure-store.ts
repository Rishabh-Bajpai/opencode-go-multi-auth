import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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

  async saveKeys(keys: Array<{ key: string; alias: string }>): Promise<void> {
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

  async loadKeys(): Promise<Array<{ key: string; alias: string }>> {
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
      return JSON.parse(decrypted.toString('utf8'))
    } catch {
      return []
    }
  }

  async addKey(apiKey: string, alias: string): Promise<void> {
    const keys = await this.loadKeys()
    keys.push({ key: apiKey, alias })
    await this.saveKeys(keys)
  }

  async removeKey(alias: string): Promise<void> {
    let keys = await this.loadKeys()
    keys = keys.filter(k => k.alias !== alias)
    await this.saveKeys(keys)
  }

  keyExists(): boolean {
    return fs.existsSync(this.filePath)
  }
}
