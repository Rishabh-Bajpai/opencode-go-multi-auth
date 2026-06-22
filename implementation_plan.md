# OpenCode Go Multi-Account Router Plugin

Build a TypeScript/Node.js proxy plugin that pools multiple OpenCode Go API subscriptions into a single endpoint, with automatic failover, round-robin load balancing, quota tracking, and a local web UI for management.

## User Review Required

> [!IMPORTANT]
> **Secure Key Storage**: The PRD specifies using `keytar` or OS-equivalent for secure credential storage. However, `keytar` is deprecated and unmaintained. I propose using **`keytar`'s successor approach**: encrypted JSON file storage with a master password derived via `node:crypto` (PBKDF2 + AES-256-GCM). This works cross-platform without requiring D-Bus/Keychain dependencies that complicate headless/server environments. Alternative: we could use the `secret-service` npm package for Linux or skip OS keychain integration entirely in favor of encrypted-at-rest file storage. **Please confirm your preference.**

> [!IMPORTANT]
> **Port Selection**: The PRD says "chose less common and available port." I'll use **port 18904** for the web UI dashboard. The proxy API endpoint will run on a separate port **18905**. Let me know if you have a preference.

## Open Questions

> [!NOTE]
> The PRD references the OpenCode Go API at `https://opencode.ai/zen/go/v1`. Confirm this is the correct upstream base URL to proxy to.

> [!NOTE]
> The PRD mentions a $60 Go limit per key. The earlier section says $10/month accounts. I'll implement quota tracking against the $60 limit as stated in section 3.2.

---

## Proposed Changes

### Phase 1: Project Scaffolding & Configuration

#### [NEW] package.json
- Node.js project with TypeScript, Express, `http-proxy-middleware`
- Scripts: `dev`, `build`, `start`
- Dependencies: `express`, `http-proxy`, `winston` (logging), `ws` (WebSocket for real-time log streaming)

#### [NEW] tsconfig.json
- TypeScript strict mode, ES2022 target, Node16 module resolution

#### [NEW] .gitignore
- Standard Node.js gitignore + `dist/`, `*.log`, `.env`

#### [NEW] .env.example
- Template for optional env overrides (ports, upstream URL, log path)

---

### Phase 2: Core Router Engine (`src/router/`)

#### [NEW] src/router/types.ts
- `ApiKey` interface: `{ id, key, alias, addedAt, status, cooldownUntil, consecutiveErrors, tokensUsed, costAccumulated }`
- `RoutingStrategy` enum: `EXHAUSTION_FAILOVER`, `ROUND_ROBIN`
- `RouterConfig` interface: cooldown duration, quota limit, circuit breaker thresholds

#### [NEW] src/router/key-manager.ts
- `KeyManager` class: manages the pool of API keys
- Methods: `addKey()`, `removeKey()`, `getNextKey(strategy)`, `markExhausted(keyId)`, `markError(keyId)`, `resetCooldown(keyId)`
- Round-robin index tracking
- Exhaustion failover: use primary until limit, then fall through
- Emits events for state changes (for UI/logging)

#### [NEW] src/router/circuit-breaker.ts
- `CircuitBreaker` class: monitors per-key health
- Tracks consecutive 5xx errors (threshold: 3)
- States: `CLOSED` (healthy), `OPEN` (tripped), `HALF_OPEN` (testing)
- Auto-recovery after configurable timeout

#### [NEW] src/router/quota-tracker.ts
- `QuotaTracker` class: tracks token usage per key against $60 limit
- Parses response headers/body for token usage data
- Proactive switching: triggers failover at 95% quota usage
- Persists usage data to local JSON file

---

### Phase 3: Proxy Server (`src/proxy/`)

#### [NEW] src/proxy/server.ts
- HTTP proxy server on port 18905
- Intercepts all requests to `/v1/*` (OpenAI-compatible) and `/v1/messages` (Anthropic-compatible)
- For each request:
  1. Select key via `KeyManager.getNextKey(currentStrategy)`
  2. **Preserve all caching headers** (`X-Session-Id`, `prompt_cache_key`, `cache_control`) — passthrough unmodified
  3. Attach selected API key to upstream request
  4. Forward to upstream (`https://opencode.ai/zen/go/v1`)
  5. On response: check for 402/429 → trigger exhaustion failover & retry
  6. On response: check for 5xx → feed to circuit breaker
  7. Parse token usage from response → feed to quota tracker
  8. Log the routing decision

#### [NEW] src/proxy/header-passthrough.ts
- Utility to identify, preserve, and forward caching headers
- Logs warning on failover: "Cold start cache miss — first request on new key will not benefit from cached context"
- Never injects artificial session IDs

---

### Phase 4: Secure Key Storage (`src/storage/`)

#### [NEW] src/storage/secure-store.ts
- Encrypted-at-rest key storage using AES-256-GCM
- Master key derived from machine-specific entropy (hostname + username hash) via PBKDF2
- File stored at `~/.opencode/router-keys.enc`
- Methods: `saveKeys()`, `loadKeys()`, `addKey()`, `removeKey()`
- Falls back gracefully if crypto unavailable

#### [NEW] src/storage/config-store.ts
- Stores non-secret configuration (selected strategy, port settings, cooldown durations)
- JSON file at `~/.opencode/router-config.json`

---

### Phase 5: Logging (`src/logging/`)

#### [NEW] src/logging/logger.ts
- Winston-based logger
- Outputs to both console and `~/.opencode/router.log`
- Log levels: `info`, `warn`, `error`, `debug`
- Structured JSON log entries with timestamps
- Rotation: max 5MB per file, keep 3 rotated files

#### [NEW] src/logging/log-stream.ts
- WebSocket-based real-time log streaming for Web UI
- Maintains in-memory ring buffer of last 500 log entries
- Broadcasts new entries to connected WebSocket clients

---

### Phase 6: Web UI Dashboard (`src/dashboard/`)

#### [NEW] src/dashboard/server.ts
- Express server on port 18904
- Serves static files from `src/dashboard/public/`
- REST API endpoints:
  - `GET /api/keys` — list keys (masked)
  - `POST /api/keys` — add key
  - `DELETE /api/keys/:id` — remove key
  - `GET /api/strategy` — get current strategy
  - `PUT /api/strategy` — change strategy
  - `GET /api/status` — full status (keys health, quota, cooldowns)
  - `GET /api/logs` — recent log entries
- WebSocket endpoint at `/ws/logs` for real-time log streaming

#### [NEW] src/dashboard/public/index.html
- Single-page dashboard with premium dark-mode design
- Sections:
  1. **Header**: App name + connection status indicator
  2. **Key Management**: Add/remove keys with masked display, secure input form
  3. **Strategy Selector**: Dropdown to switch between Exhaustion Failover and Round-Robin
  4. **Status Ledger**: Visual cards per key showing health (green/yellow/red), quota bar, cooldown timer, tokens used
  5. **Log Viewer**: Real-time scrolling log feed with color-coded severity

#### [NEW] src/dashboard/public/styles.css
- Premium dark theme with glassmorphism cards
- CSS custom properties for theming
- Smooth animations and transitions
- Responsive layout (works on mobile too)
- Color-coded status indicators (green=healthy, amber=warning, red=error/cooldown)

#### [NEW] src/dashboard/public/app.js
- Vanilla JS SPA logic
- WebSocket connection for real-time logs
- Fetch-based API calls for key management and strategy changes
- Auto-refreshing status ledger (polling every 5s)
- Toast notifications for actions

---

### Phase 7: Entry Point & Wiring (`src/`)

#### [NEW] src/index.ts
- Main entry point
- Boots:
  1. Load config from `~/.opencode/router-config.json`
  2. Load keys from encrypted store
  3. Initialize `KeyManager`, `CircuitBreaker`, `QuotaTracker`
  4. Start proxy server on port 18905
  5. Start dashboard server on port 18904
  6. Log startup info with port numbers

#### [NEW] README.md
- Installation instructions
- Configuration guide
- Usage with OpenCode CLI

---

## Verification Plan

### Automated Tests
- `npm run build` — TypeScript compilation succeeds
- Manual testing: start the server, verify dashboard loads at `http://localhost:18904`
- Manual testing: add a key via UI, verify it appears in status
- Manual testing: verify proxy forwards requests correctly

### Manual Verification
- Add 2+ test API keys via the Web UI
- Switch between strategies and verify behavior changes
- Verify logs appear in real-time in the log viewer
- Verify encrypted key file is created at `~/.opencode/router-keys.enc`
- Test failover by simulating a 429 response
