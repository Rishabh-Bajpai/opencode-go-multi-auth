import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { RouterConfig } from '../router/types.js'
import { DEFAULT_CONFIG } from '../router/types.js'

export class ConfigStore {
  private readonly filePath: string
  private config: RouterConfig

  constructor(configDir?: string) {
    const dir = configDir || path.join(os.homedir(), '.opencode')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.filePath = path.join(dir, 'router-config.json')
    this.config = { ...DEFAULT_CONFIG }
    this.load()
  }

  get<K extends keyof RouterConfig>(key: K): RouterConfig[K] {
    return this.config[key]
  }

  set<K extends keyof RouterConfig>(key: K, value: RouterConfig[K]): void {
    this.config[key] = value
    this.save()
  }

  getAll(): RouterConfig {
    return { ...this.config }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8')
        const parsed = JSON.parse(raw)
        this.config = { ...DEFAULT_CONFIG, ...parsed }
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG }
    }
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf8')
  }
}
