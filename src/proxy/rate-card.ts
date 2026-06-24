import type { TokenBreakdown } from './response-parser.js'

interface ModelRate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  // Optional higher tier (applied when cacheRead+input > CONTEXT_TIER_THRESHOLD).
  highInput?: number
  highOutput?: number
  highCacheRead?: number
  highCacheWrite?: number
}

// Per-1M-token rates for OpenCode Go models, copied from
// https://opencode.ai/docs/go (last reviewed against the docs at module
// load time). Models not listed here return null from estimateCost.
const RATE_CARD: Record<string, ModelRate> = {
  'glm-5.2':           { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 0 },
  'glm-5.1':           { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 0 },
  'kimi-k2.7':         { input: 0.95, output: 4.00, cacheRead: 0.19, cacheWrite: 0 },
  'kimi-k2.7-code':    { input: 0.95, output: 4.00, cacheRead: 0.19, cacheWrite: 0 },
  'kimi-k2.6':         { input: 0.95, output: 4.00, cacheRead: 0.16, cacheWrite: 0 },
  'mimo-v2.5':         { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  'mimo-v2.5-pro':     { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
  'minimax-m3':        { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0 },
  'minimax-m2.7':      { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0.375 },
  'minimax-m2.5':      { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0.375 },
  'qwen3.7-max':       { input: 2.50, output: 7.50, cacheRead: 0.50, cacheWrite: 3.125,
                         highInput: 5.00, highOutput: 15.00, highCacheRead: 1.00, highCacheWrite: 6.25 },
  'qwen3.7-plus':      { input: 0.40, output: 1.60, cacheRead: 0.04, cacheWrite: 0.50,
                         highInput: 1.20, highOutput: 4.80, highCacheRead: 0.12, highCacheWrite: 1.50 },
  'qwen3.6-plus':      { input: 0.50, output: 3.00, cacheRead: 0.05, cacheWrite: 0.625,
                         highInput: 2.00, highOutput: 6.00, highCacheRead: 0.20, highCacheWrite: 2.50 },
  'qwen3.5-plus':      { input: 0.20, output: 1.20, cacheRead: 0.02, cacheWrite: 0.25 },
  'deepseek-v4-pro':   { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  'grok-build-0.1':    { input: 1.00, output: 2.00, cacheRead: 0.20, cacheWrite: 0 },
}

const CONTEXT_TIER_THRESHOLD = 256_000

const warnedModels = new Set<string>()

function normalizeModel(model: string | null | undefined): string | null {
  if (!model) return null
  return model.toLowerCase().trim()
}

export function isRateCardModel(model: string | null | undefined): boolean {
  const key = normalizeModel(model)
  return Boolean(key && RATE_CARD[key])
}

export function estimateCost(model: string | null | undefined, tokens: TokenBreakdown): number | null {
  const key = normalizeModel(model)
  if (!key) return null
  const rate = RATE_CARD[key]
  if (!rate) {
    if (!warnedModels.has(key)) {
      warnedModels.add(key)
      // eslint-disable-next-line no-console
      console.warn(`[rate-card] No rate for model "${key}"; cost will be null until this is added.`)
    }
    return null
  }
  const totalContext = tokens.input + tokens.cacheRead
  const highTier = totalContext > CONTEXT_TIER_THRESHOLD && rate.highInput != null
  const inputRate = highTier && rate.highInput != null ? rate.highInput : rate.input
  const outputRate = highTier && rate.highOutput != null ? rate.highOutput : rate.output
  const cacheReadRate = highTier && rate.highCacheRead != null ? rate.highCacheRead : rate.cacheRead
  const cacheWriteRate = highTier && rate.highCacheWrite != null ? rate.highCacheWrite : rate.cacheWrite

  const cost =
    (tokens.input / 1_000_000) * inputRate +
    (tokens.output / 1_000_000) * outputRate +
    (tokens.cacheRead / 1_000_000) * cacheReadRate +
    (tokens.cacheWrite / 1_000_000) * cacheWriteRate
  return Math.round(cost * 1_000_000) / 1_000_000
}
