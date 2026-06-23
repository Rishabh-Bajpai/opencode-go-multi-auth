# OpenCode Go Multi-Account Router

A native TypeScript OpenCode plugin and proxy router that pools multiple OpenCode Go API subscriptions into a single endpoint. It routes requests across accounts using cache-aware or load-spreading strategies, auto-starts with OpenCode in plugin mode, and includes a persistent control-room dashboard for key management, usage analytics, and live observability.

## Features

- **Five Routing Strategies** — Priority Failover (cache-first default), Priority Spillover, Round Robin, Weighted Cycle, Highest Remaining Quota. Each explained in the dashboard UI.
- **Persistent Key Settings** — Enable/drain, priority, weight, and alias survive restarts. Keys are stored with stable IDs and encrypted at rest.
- **Per-Key Analytics** — Request count, success/error rate, average latency, token breakdown, last model used, last session ID, remaining monthly quota.
- **Stream-Aware Usage Tracking** — Parses token usage from both full JSON and SSE streaming completions. Injects `stream_options.include_usage` for OpenAI-compatible streams.
- **Proactive Quota Tracking** — Spills traffic at a configurable threshold before hitting hard limits.
- **Circuit Breaker** — Temporarily removes unhealthy keys after 3 consecutive 5xx errors, auto-recovers after 5 minutes.
- **Cache-Preserving Header Passthrough** — Forwards `X-Session-Id`, `prompt_cache_key` / `prompt-cache-key`, `cache_control` / `cache-control`, plus both bearer and `x-api-key` auth for broader model compatibility.
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

Install the plugin so OpenCode starts the router automatically when OpenCode launches. This does not install an OS-level boot service by itself.

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

Whenever you change this repo locally, rebuild before testing or reopening OpenCode:

```bash
npm run build
```

Then fully close any existing OpenCode sessions and open a fresh one so the new plugin build is loaded.

Then start OpenCode normally. The plugin will start or reuse one shared local router daemon, which serves the proxy at `http://localhost:18905` and the dashboard at `http://localhost:18904`.

### Open the Dashboard

Navigate to **[http://localhost:18904](http://localhost:18904)** in your browser. If the page does not open, first open a fresh OpenCode session so the plugin can start the router daemon.

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

In standalone mode you must start the router yourself after reboot. Plugin mode avoids manual startup when opening OpenCode, but it is not an OS boot service.

## Compatibility Notes

- Some OpenCode Go models use `/messages` with Anthropic-style auth. The proxy now forwards both `Authorization: Bearer ...` and `x-api-key` to maximize compatibility.
- If a new model still fails, capture the exact model name and the `/messages` or `/chat/completions` path from the router log.

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
| `REQUEST_TIMEOUT_MS` | `0` | Wall-clock cap on the upstream HTTP round-trip in ms. `0` = disabled, matching OpenCode's no-timeout default for the opencode-go provider. |
| `UPSTREAM_HUNG_TIMEOUT_MS` | `0` | Safety net that aborts the upstream fetch if no response is received at all within this window. `0` = disabled. Cleared as soon as the upstream starts sending bytes. |

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
2. OpenCode auto-loads the plugin at startup (plugin mode) and the plugin starts or reuses a shared detached local router daemon
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

## OS Boot Service

If you want the router to start when the machine boots or when you log into your desktop session, run the standalone router under your OS service manager. Plugin mode alone only starts the router when OpenCode launches.

### Linux (`systemd`)

1. Build the project once:

```bash
cd /absolute/path/to/opencode-go-multi-auth
npm install
npm run build
```

2. Find your absolute Node path. If you use `nvm`, this matters because `systemd` will not load your interactive shell profile:

```bash
which node
```

3. Create `~/.config/systemd/user/opencode-go-router.service` and replace both absolute paths below:

- `WorkingDirectory` must be the repo root
- `ExecStart` must use the full path to your `node` binary and the full path to `dist/bin.js`

```ini
[Unit]
Description=OpenCode Go Multi-Account Router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/opencode-go-multi-auth
ExecStart=/absolute/path/to/node /absolute/path/to/opencode-go-multi-auth/dist/bin.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

4. Enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-go-router.service
```

5. Verify it:

```bash
systemctl --user status opencode-go-router.service --no-pager
curl http://127.0.0.1:18904/healthz
curl http://127.0.0.1:18905/v1/models
```

6. If you rebuild or change the source later, rebuild and restart the service:

```bash
npm run build
systemctl --user restart opencode-go-router.service
```

7. Point OpenCode at the same proxy config from the earlier README section. With this setup, OpenCode can reuse the already-running router after login or reboot.

### Notes

- This is a user service, so it starts when your user session starts.
- If you want it to run before login, you would need system-level service configuration and user lingering, which is usually unnecessary for this app.
- If `which node` prints an `nvm` path, use that exact path in `ExecStart`.

### macOS (`launchd`)

Use the standalone router with a user `LaunchAgent` that runs `node /absolute/path/to/opencode-go-multi-auth/dist/bin.js` in the repo directory. The important part is the same: build first, use absolute paths, and manage `dist/bin.js` as a long-running user service.

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
- The plugin starts or reuses one shared local router daemon across OpenCode sessions, so opening multiple sessions should not create competing proxy/dashboard owners.
- The plugin does not replace the built-in `opencode-go` provider. It auto-starts the proxy; the provider still needs the one-time `baseURL` override in `opencode.json`.
- Plugin mode auto-starts the router when OpenCode launches. It does not create an OS boot service; if you want system boot behavior, run the standalone router under `systemd`, `launchd`, or another service manager.
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
