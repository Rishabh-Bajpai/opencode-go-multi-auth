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

export function parseTokenUsage(body: string, model?: string): TokenBreakdown | null {
  try {
    const json = JSON.parse(body)

    if (json.usage) {
      const u = json.usage
      const tokens: TokenBreakdown = {
        input: u.input_tokens ?? u.prompt_tokens ?? 0,
        output: u.output_tokens ?? u.completion_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        reasoning: u.reasoning_output_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0,
      }
      if (tokens.input > 0 || tokens.output > 0) return tokens
    }

    if (json.type === 'message_start' && json.message?.usage) {
      const u = json.message.usage
      const tokens: TokenBreakdown = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        reasoning: 0,
      }
      if (tokens.input > 0 || tokens.output > 0) return tokens
    }

    if (Array.isArray(json)) {
      for (const entry of json) {
        if (entry.type === 'message_start' && entry.message?.usage) {
          const u = entry.message.usage
          const tokens: TokenBreakdown = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            reasoning: 0,
          }
          if (tokens.input > 0 || tokens.output > 0) return tokens
        }
      }
    }

    return null
  } catch {
    return null
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
