export interface TokenBreakdown {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export interface UsageData {
  tokens: TokenBreakdown
  cost: number
}

const DEFAULT_INPUT_RATE = 3e-6
const DEFAULT_OUTPUT_RATE = 15e-6

function hasUsage(tokens: TokenBreakdown): boolean {
  return tokens.input > 0 || tokens.output > 0 || tokens.cacheRead > 0 || tokens.cacheWrite > 0 || tokens.reasoning > 0
}

function mergeUsage(current: TokenBreakdown | null, incoming: TokenBreakdown | null): TokenBreakdown | null {
  if (!incoming) return current
  if (!current) return incoming
  return {
    input: Math.max(current.input, incoming.input),
    output: Math.max(current.output, incoming.output),
    cacheRead: Math.max(current.cacheRead, incoming.cacheRead),
    cacheWrite: Math.max(current.cacheWrite, incoming.cacheWrite),
    reasoning: Math.max(current.reasoning, incoming.reasoning),
  }
}

function extractUsageObject(source: Record<string, any> | undefined): TokenBreakdown | null {
  if (!source) return null

  const tokens: TokenBreakdown = {
    input: source.input_tokens ?? source.prompt_tokens ?? 0,
    output: source.output_tokens ?? source.completion_tokens ?? 0,
    cacheRead: source.cache_read_input_tokens ?? source.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: source.cache_creation_input_tokens ?? 0,
    reasoning: source.reasoning_output_tokens ?? source.completion_tokens_details?.reasoning_tokens ?? 0,
  }

  return hasUsage(tokens) ? tokens : null
}

function parseJsonUsage(json: unknown): TokenBreakdown | null {
  if (!json || typeof json !== 'object') {
    if (Array.isArray(json)) {
      let usage: TokenBreakdown | null = null
      for (const entry of json) {
        usage = mergeUsage(usage, parseJsonUsage(entry))
      }
      return usage
    }
    return null
  }

  const value = json as Record<string, any>
  let usage = extractUsageObject(value.usage)

  if (value.type === 'message_start' && value.message?.usage) {
    usage = mergeUsage(usage, extractUsageObject(value.message.usage))
  }

  if (value.type === 'message_delta' && value.usage) {
    usage = mergeUsage(usage, extractUsageObject(value.usage))
  }

  if (value.message?.usage) {
    usage = mergeUsage(usage, extractUsageObject(value.message.usage))
  }

  return usage
}

function parseEventStreamUsage(body: string): TokenBreakdown | null {
  const normalized = body.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  let usage: TokenBreakdown | null = null

  for (const block of blocks) {
    const dataLines = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean)

    for (const payloadText of dataLines) {
      if (payloadText === '[DONE]') continue
      try {
        const payload = JSON.parse(payloadText)
        usage = mergeUsage(usage, parseJsonUsage(payload))
      } catch {
        continue
      }
    }
  }

  return usage
}

export function parseTokenUsage(body: string, model?: string): TokenBreakdown | null {
  try {
    const json = JSON.parse(body)
    return parseJsonUsage(json)
  } catch {
    return parseEventStreamUsage(body)
  }
}

export function estimateCost(tokens: TokenBreakdown, inputRate?: number, outputRate?: number): number {
  const iRate = inputRate ?? DEFAULT_INPUT_RATE
  const oRate = outputRate ?? DEFAULT_OUTPUT_RATE

  const cacheDiscount = 0.1
  const input = tokens.input - tokens.cacheRead - tokens.cacheWrite
  const cost =
    Math.max(0, input) * iRate +
    tokens.cacheRead * iRate * cacheDiscount +
    tokens.cacheWrite * iRate +
    tokens.output * oRate +
    tokens.reasoning * oRate * 2

  return cost
}
