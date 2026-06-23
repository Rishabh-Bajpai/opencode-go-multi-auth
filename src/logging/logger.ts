import winston from 'winston'
import path from 'node:path'
import os from 'node:os'

const LOG_DIR = path.join(os.homedir(), '.opencode')
const LOG_FILE = path.join(LOG_DIR, 'router.log')

let isPluginMode = false

/**
 * Set plugin mode to suppress console output.
 * When running as an OpenCode plugin, all logs go to file only.
 */
export function setPluginMode(enabled: boolean): void {
  isPluginMode = enabled
}

export function getPluginMode(): boolean {
  return isPluginMode
}

export function createLogger(level = 'info') {
  const transports: winston.transport[] = [
    new winston.transports.File({
      filename: LOG_FILE,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ]

  // Only add console transport when running standalone (not as a plugin)
  if (!isPluginMode) {
    transports.push(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
            return `${timestamp} [${level}]: ${message}${metaStr}`
          }),
        ),
      }),
    )
  }

  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports,
  })
}

export type AppLogger = ReturnType<typeof createLogger>

/**
 * Log a message to the file logger without console output.
 * Used by the plugin and router internals for non-console logging.
 */
const fileLogger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({
      filename: LOG_FILE,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
})

export function logToFile(level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, unknown>): void {
  fileLogger.log(level, message, meta)
}
