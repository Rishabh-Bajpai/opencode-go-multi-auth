# OpenCode Go Multi-Account Router

A native TypeScript OpenCode plugin and proxy router that pools multiple OpenCode Go API subscriptions into a single endpoint. It routes requests across accounts using cache-aware or load-spreading strategies, auto-starts with OpenCode in plugin mode, and includes a persistent control-room dashboard for key management, usage analytics, and live observability.

## Features

- **Five Routing Strategies** — Priority Failover (cache-first default), Priority Spillover, Round Robin, Weighted Cycle, Highest Remaining Quota. Each explained in the dashboard UI.
- **Persistent Key Settings** — Enable/drain, priority, weight, and alias survive restarts. Keys are stored with stable IDs and encrypted at rest.
- **Per-Key Analytics** — Request count, success/error rate, average latency, token breakdown, last model used, last session ID, remaining monthly quota.
- **Stream-Aware Usage Tracking** — Parses token usage from both full JSON and SSE streaming completions. Injects `stream_options.include_usage` for OpenAI-compatible streams.
- **Proactive Quota Tracking** — Spills traffic at a configurable threshold before hitting hard limits.
- **Circuit Breaker** — Temporarily removes unhealthy keys after 3 consecutive 5xx errors, auto-recovers after 5 minutes.
- **Cache-Preserving Header Passthrough** — Forwards `X-Session-Id`, `prompt_cache_key` / `prompt-cache-key`, `cache_control` / `cache-control` for OpenCode's context caching discounts.
- **Local Web UI Control Room** — Strategy explainer, key deck with inline editing, live usage ledger, routing tape with per-request route reasons and session IDs.
- **Secure Key Storage** — AES-256-GCM encrypted at rest using PBKDF2-derived key from machine identity.
- **Push Notifications** — Optional ntfy notifications for exhaustion, circuit breaker trips, and proactive switches.
- **Auto-Starting OpenCode Plugin** — Install as an OpenCode plugin so the proxy and dashboard start with OpenCode automatically.
- **Standalone or Library** — Keep a CLI/server mode for debugging, fallback use, or external automation.

## Prerequisites

- **Node.js** >= 18 (LTS recommended)
- **npm** or **bun** or **pnpm**
- **OpenCode CLI** installed and configured with a Go subscription

## Installation

### Plugin install (recommended)

Install the plugin so OpenCode starts the router automatically when it boots.

If this package is installed from npm:

```bash
opencode plugin opencode-go-multi-auth/plugin --global
```

If you are using this repo from source:

```bash
git clone https://github.com/Rishabh-Bajpai/opencode-go-multi-auth.git
cd opencode-go-multi-auth
npm install
npm run build
mkdir -p ~/.config/opencode/plugins
cat > ~/.config/opencode/plugins/opencode-go-multi-auth.js <<'EOF'
export { default, server, pluginModule } from "/absolute/path/to/opencode-go-multi-auth/dist/opencode-plugin.js"
EOF
```

Replace `/absolute/path/to/opencode-go-multi-auth` with the real path to your local clone.

### OpenCode config

Add the proxy as a base URL override for the built-in `opencode-go` provider in `~/.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-go-multi-auth/plugin"],
  "provider": {
    "opencode-go": {
      "options": {
        "baseURL": "http://localhost:18905"
      }
    }
  }
}
```

If you installed the plugin by copying the built file into `~/.config/opencode/plugins/`, you can leave `plugin` out entirely because local plugin files are auto-loaded.

Then start OpenCode normally. The plugin will boot the proxy at `http://localhost:18905` and the dashboard at `http://localhost:18904` automatically.

### Open the Dashboard

Navigate to **[http://localhost:18904](http://localhost:18904)** in your browser.

### Add your Go API keys

1. Click **Add Key**
2. Paste your OpenCode Go API key (found in your OpenCode account settings)
3. Optionally give it an alias, priority, and weight
4. Repeat for each Go account you want to pool

### Standalone mode (fallback)

If you do not want plugin mode, you can still run the router manually:

```bash
npm start
```

Or install globally:

```bash
npm install -g .
opencode-go-router
```

In standalone mode you must start the router yourself after reboot. Plugin mode avoids this.

## Routing Strategies

All strategies are explained in the dashboard UI. Here is a quick reference:

| Strategy | Cache-friendly | Priority-aware | Weight-aware | Best for |
|---|---|---|---|---|
| **Priority Failover** (default) | Yes | Yes | No | Keep one account warm for cache reuse |
| **Priority Spillover** | Yes | Yes | No | Warm caches with fewer hard quota cutovers |
| **Round Robin** | No | No | No | Simple spreading when cache reuse is less important |
| **Weighted Cycle** | No | No | Yes | Proportional traffic distribution |
| **Highest Remaining Quota** | No | Yes | No | Preserve fullest accounts for long sessions |

Session stickiness is applied before any strategy. If a warm session key is detected, the request is pinned to its current account regardless of the active strategy.

## Routing Tape (Log Viewer)

Each log entry now includes rich metadata visible in the UI and file logs:

- Method, path, status code, and duration
- Selected key alias and why it was chosen
- Active strategy name
- Session ID (observed or synthesized from cache key)
- Token breakdown and estimated cost
- Whether the route was chosen by session stickiness

## Dashboard Control Room

The dashboard is organized into four panels:

1. **Key Deck** — Add, enable/drain, reorder, and set priority/weight for each account. Persistent to disk.
2. **Strategy Console** — Select an active strategy and see its description, best-for recommendation, cache friendliness, and behavior.
3. **Live Usage Ledger** — Real-time per-key analytics: token breakdown, success/error counts, average latency, cooldown status, last model and session, and remaining monthly quota.
4. **Routing Tape** — Structured log viewer with path, key, route reason, and cost columns. Filters, pause, and clear controls.

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
| `PROACTIVE_SWITCH_THRESHOLD` | `0.95` | Usage fraction (0-1) that triggers proactive spillover |
| `LOG_LEVEL` | `info` | Log level: `error`, `warn`, `info`, `debug` |
| `CONFIG_DIR` | `~/.opencode` | Directory for config, encrypted key storage, and usage data |
| `NTFY_URL` | — | Optional ntfy URL for push notifications (e.g., `https://ntfy.sh/mytopic`). Leave empty to disable. |

### Ports

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
2. OpenCode auto-loads the plugin at startup (plugin mode) and the plugin boots the proxy/dashboard in-process
3. Proxy selects an API key using the active strategy (with session stickiness as a pre-filter)
4. Request is forwarded to the upstream OpenCode Go API
5. On 402/429: key goes on dynamic cooldown, next key is tried
6. On 5xx: circuit breaker tracks consecutive errors, trips after threshold
7. Token usage is parsed from full JSON or SSE streaming responses and tracked against each key
8. Caching and session headers (`X-Session-Id`, `prompt_cache_key`, `cache_control`) pass through unmodified
9. All decisions are logged with routing reasons and streamed to the dashboard in real time

## Security

- **API keys are never stored in plain text.** They are encrypted with AES-256-GCM using a key derived from your machine's hostname and username via PBKDF2 with 600,000 iterations.
- The encrypted key file is stored at `~/.opencode/router-keys.enc` and is tied to your specific machine.
- **No keys are ever sent to any external service** — all processing is local.
- The dashboard runs on localhost only and is not exposed to the network.

## Push Notifications

Optional push notifications via [ntfy](https://ntfy.sh/) are sent when critical events happen.

Set the `NTFY_URL` environment variable to enable:

```bash
export NTFY_URL=https://ntfy.sh/mytopic
npm start
```

| Event | Priority | Trigger |
|---|---|---|
| Key quota exhausted | High / Urgent | A key returns 402/429 with quota body, failover activates |
| All keys exhausted | Urgent | Every key in the pool is exhausted |
| Circuit breaker tripped | High | 3 consecutive 5xx errors, key removed from pool |
| Proactive quota switch | Low | Key usage crosses the proactive switch threshold |

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

## Plugin Notes

- OpenCode plugin mode is the preferred installation path.
- The plugin starts the router once per OpenCode process and reuses an existing router if the configured ports are already occupied.
- The plugin does not replace the built-in `opencode-go` provider. It auto-starts the proxy; the provider still needs the one-time `baseURL` override in `opencode.json`.
- Standalone CLI mode remains available for debugging, system service setups, or running the router outside OpenCode.

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
