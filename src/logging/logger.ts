import winston from 'winston'
import path from 'node:path'
import os from 'node:os'

const LOG_DIR = path.join(os.homedir(), '.opencode')
const LOG_FILE = path.join(LOG_DIR, 'router.log')

export function createLogger(level = 'info') {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
            return `${timestamp} [${level}]: ${message}${metaStr}`
          }),
        ),
      }),
      new winston.transports.File({
        filename: LOG_FILE,
        maxsize: 5 * 1024 * 1024,
        maxFiles: 3,
      }),
    ],
  })
}

export type AppLogger = ReturnType<typeof createLogger>
