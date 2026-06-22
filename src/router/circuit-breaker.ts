import { CircuitState } from './types.js'

interface KeyCircuitState {
  state: CircuitState
  consecutiveErrors: number
  lastErrorTime: number | null
  trippedAt: number | null
}

export class CircuitBreaker {
  private circuits: Map<string, KeyCircuitState> = new Map()
  private readonly threshold: number
  private readonly recoveryTimeout: number

  constructor(threshold = 3, recoveryTimeout = 300_000) {
    this.threshold = threshold
    this.recoveryTimeout = recoveryTimeout
  }

  getState(keyId: string): CircuitState {
    return this.circuits.get(keyId)?.state ?? CircuitState.CLOSED
  }

  recordSuccess(keyId: string): void {
    const circuit = this.circuits.get(keyId)
    if (!circuit) return

    if (circuit.state === CircuitState.HALF_OPEN) {
      circuit.state = CircuitState.CLOSED
      circuit.consecutiveErrors = 0
      circuit.trippedAt = null
    } else {
      circuit.consecutiveErrors = 0
    }
  }

  recordFailure(keyId: string): CircuitState {
    let circuit = this.circuits.get(keyId)
    if (!circuit) {
      circuit = {
        state: CircuitState.CLOSED,
        consecutiveErrors: 0,
        lastErrorTime: null,
        trippedAt: null,
      }
      this.circuits.set(keyId, circuit)
    }

    circuit.consecutiveErrors++
    circuit.lastErrorTime = Date.now()

    if (circuit.consecutiveErrors >= this.threshold) {
      circuit.state = CircuitState.OPEN
      circuit.trippedAt = Date.now()
    }

    return circuit.state
  }

  tryRecovery(keyId: string): void {
    const circuit = this.circuits.get(keyId)
    if (!circuit || circuit.state !== CircuitState.OPEN) return
    if (!circuit.trippedAt) return

    const elapsed = Date.now() - circuit.trippedAt
    if (elapsed >= this.recoveryTimeout) {
      circuit.state = CircuitState.HALF_OPEN
    }
  }

  isAvailable(keyId: string): boolean {
    this.tryRecovery(keyId)
    const state = this.getState(keyId)
    return state !== CircuitState.OPEN
  }
}
