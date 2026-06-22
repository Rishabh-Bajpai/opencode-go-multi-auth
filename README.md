# OpenCode Go Multi-Account Router

A native TypeScript proxy server that pools multiple OpenCode Go API subscriptions into a single endpoint. It switches accounts automatically based on limit exhaustion or round-robin strategies, with a local Web UI for key management and usage tracking.

## Features

- **Dynamic Switching Strategies** — Exhaustion Failover (fallback on 402/429) or Round-Robin load balancing
- **Proactive Quota Tracking** — Switches accounts at 95% usage before hitting the hard limit
- **Circuit Breaker** — Temporarily removes unhealthy keys after 3 consecutive 5xx errors
- **Cache-Preserving Header Passthrough** — Preserves `X-Session-Id`, `prompt_cache_key`, `cache_control` headers for OpenCode's context caching discounts
- **Local Web UI Dashboard** — Key management, strategy selector, status ledger, real-time log viewer
- **Secure Key Storage** — AES-256-GCM encrypted at rest using PBKDF2-derived key from machine identity
- **Standalone or Library** — Use as a CLI server or import programmatically

## Prerequisites

- **Node.js** >= 18 (LTS recommended)
- **npm** or **bun** or **pnpm**
- **OpenCode CLI** installed and configured with a Go subscription

## Installation

### 1. Clone and build

```bash
git clone https://github.com/Rishabh-Bajpai/opencode-go-multi-auth.git
cd opencode-go-multi-auth
npm install
npm run build
```

### 2. Run the server

```bash
npm start
```

Or install globally:

```bash
npm install -g .
opencode-go-router
```

You should see output like:

```
[PROXY] Listening on port 18905
Dashboard UI: http://localhost:18904
Proxy server: http://localhost:18905
Upstream: https://opencode.ai/zen/go/v1
Loaded 0 API key(s)
```

### 3. Open the Dashboard

Navigate to **[http://localhost:18904](http://localhost:18904)** in your browser.

### 4. Add your Go API keys

1. Click **+ Add Key**
2. Paste your OpenCode Go API key (found in your OpenCode account settings)
3. Optionally give it an alias (e.g., "Primary", "Backup")
4. Repeat for each Go account you want to pool

### 5. Configure OpenCode CLI

Edit your OpenCode config file (typically `~/.opencode/config.json` or `opencode.json` in your project) to point to the router:

```json
{
  "provider": {
    "opencode-go-router": {
      "type": "native",
      "url": "http://localhost:18905",
      "settings": {}
    }
  }
}
```

Then run OpenCode normally. All API calls to `https://opencode.ai/zen/go/v1/*` will be routed through the multi-account proxy.

## Usage

### Selecting a routing strategy

In the Dashboard, use the **Routing Strategy** dropdown:

| Strategy | Behavior |
|---|---|
| **Exhaustion Failover** | Routes all traffic through Account A. On 402/429 error, Account A goes on 5-hour cooldown and traffic switches to Account B. |
| **Round-Robin** | Cycles through all active accounts sequentially on each API call, distributing load evenly. |

### Status dashboard

The **Status Ledger** shows per-key:
- Health indicator (green = closed, yellow = half-open, red = open/tripped)
- Status (active, cooldown, exhausted, error)
- Token usage and accumulated cost
- Quota bar showing remaining balance

### Log viewer

Real-time scrolling log feed with color-coded severity:
- **Blue** — Info (routing decisions, startup)
- **Yellow** — Warning (cache misses, cooldown triggers)
- **Red** — Error (upstream failures, circuit breaker trips)

## Configuration

### Environment variables

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Description |
|---|---|---|
| `UPSTREAM_URL` | `https://opencode.ai/zen/go/v1` | Upstream OpenCode Go API base URL |
| `DASHBOARD_PORT` | `18904` | Web UI dashboard port |
| `PROXY_PORT` | `18905` | Proxy server port |
| `QUOTA_LIMIT` | `60` | Quota limit per key in USD |
| `COOLDOWN_MS` | `18000000` | Cooldown duration for exhausted keys (ms, default 5 hours) |
| `CIRCUIT_BREAKER_THRESHOLD` | `3` | Consecutive 5xx errors before tripping |
| `LOG_LEVEL` | `info` | Log level: `error`, `warn`, `info`, `debug` |
| `CONFIG_DIR` | `~/.opencode` | Directory for config and encrypted key storage |

### Ports

The application uses two ports:
- **18904** — Dashboard Web UI
- **18905** — Proxy/API endpoint

Both are configurable via environment variables.

## Architecture

```
┌──────────────┐     ┌──────────────────────────────────────┐
│  OpenCode    │────▶│  Go Router Proxy (port 18905)        │
│  CLI         │     │                                      │
└──────────────┘     │  KeyManager ──▶ CircuitBreaker       │
                     │       │              │                │
                     │  QuotaTracker   HeaderPassthrough     │
                     │       │              │                │
                     │  SecureStore    LogStream ──▶ Logger  │
                     └──────┬───────────────────────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
│  OpenCode    │   │  OpenCode    │   │  Dashboard UI    │
│  Go API (A)  │   │  Go API (B)  │   │  (port 18904)    │
└──────────────┘   └──────────────┘   └──────────────────┘
```

1. OpenCode CLI points to the proxy at `localhost:18905`
2. Proxy selects an API key based on the active strategy
3. Request is forwarded to the upstream OpenCode Go API
4. On 402/429: key goes on cooldown, next key is tried (exhaustion failover)
5. On 5xx: circuit breaker tracks consecutive errors, trips after threshold
6. Token usage is parsed from responses and tracked against quota
7. Caching headers (`X-Session-Id`, etc.) pass through unmodified
8. All decisions are logged locally and streamed to the dashboard

## Security

- **API keys are never stored in plain text.** They are encrypted with AES-256-GCM using a key derived from your machine's hostname and username via PBKDF2 with 600,000 iterations.
- The encrypted key file is stored at `~/.opencode/router-keys.enc` and is tied to your specific machine.
- **No keys are ever sent to any external service** — all processing is local.
- The dashboard runs on localhost only and is not exposed to the network.

## Development

```bash
# Watch mode with auto-reload
npm run dev

# TypeScript type checking
npm run typecheck

# Build
npm run build

# Clean build output
npm run clean
```

## Programmatic Usage

You can also use the router as a library:

```typescript
import { createRouter } from 'opencode-go-multi-auth'

const router = await createRouter({
  proxyPort: 18905,
  dashboardPort: 18904,
})

// Access internal components
router.keyManager.addKey('sk-...', 'Primary')
router.circuitBreaker.getState('key-id')
router.quotaTracker.getUsage('key-id')

// Graceful shutdown
await router.shutdown()
```

## License

MIT
