# Developers Log

## 2026-06-22 — Session 1: Research & Planning

### What was done
1. **Read the PRD** (`PRD.md`) — fully parsed all 6 sections covering the multi-account router plugin requirements.
2. **Researched reference repositories:**
   - [ndycode/codex-multi-auth](https://github.com/ndycode/codex-multi-auth) — studied the TypeScript plugin architecture, OAuth management, multi-account switching strategies, and CLI integration patterns.
   - [ArsalanDotMe/switchboard-go](https://github.com/ArsalanDotMe/switchboard-go) — studied the Go-based proxy approach: single `/v1/*` endpoint, automatic key failover on exhaustion, admin status endpoints, and YAML config support.
   - [junhoyeo/tokscale](https://github.com/junhoyeo/tokscale) — reviewed for token usage tracking patterns.
3. **Created `implementation_plan.md`** — a 7-phase plan covering:
   - Phase 1: Project scaffolding (package.json, tsconfig, .gitignore, .env)
   - Phase 2: Core router engine (types, key-manager, circuit-breaker, quota-tracker)
   - Phase 3: Proxy server (HTTP proxy with header passthrough)
   - Phase 4: Secure key storage (AES-256-GCM encrypted file)
   - Phase 5: Logging (Winston + WebSocket real-time streaming)
   - Phase 6: Web UI dashboard (Express + Vanilla JS SPA)
   - Phase 7: Entry point wiring
4. **Saved `implementation_plan.md`** to the project directory.
5. **Created this `Developers Log/log.md`** file.

### Decisions made
- Proposed encrypted-at-rest file storage (PBKDF2 + AES-256-GCM) instead of deprecated `keytar` for cross-platform key security.
- Proposed ports 18904 (dashboard) and 18905 (proxy) as uncommon, available ports.

### Open items (awaiting user input)
- Confirm key storage approach (encrypted file vs OS keychain).
- Confirm port numbers.
- Confirm upstream base URL (`https://opencode.ai/zen/go/v1`).
- Confirm $60 quota limit per key.

### Next steps
- Await user approval of the implementation plan.
- Once approved, begin Phase 1: project scaffolding with initial git commit.

---

## 2026-06-22 — Session 2: Full Build

### What was done
1. **Presented plan and got user approval** — user confirmed all decisions (encrypted file storage, ports 18904/18905, configurable quota, CLI + library, upstream URL).
2. **Phase 1: Project scaffolding** — package.json, tsconfig, .gitignore, .env.example, directory structure, router types.
3. **Phase 2: Core Router Engine** — KeyManager (pool mgmt, exhaustion failover, round-robin), CircuitBreaker (3-consecutive-5xx threshold, auto-recovery), QuotaTracker (token usage tracking, 95% proactive switch).
4. **Phase 3: Proxy Server** — HTTP proxy on port 18905, cache header passthrough utility, key attachment, failover/retry logic.
5. **Phase 4: Plugin Adapter** — OpenCode provider config generator + setup instructions (noted Plugin types not exported by public SDK).
6. **Phase 5: Secure Key Storage** — PBKDF2 + AES-256-GCM encrypted file at `~/.opencode/router-keys.enc`.
7. **Phase 6: Logging** — Winston file logger (5MB rotation) + WebSocket real-time log streaming with 500-entry ring buffer.
8. **Phase 7: Web UI Dashboard** — Express server on port 18904, REST API (keys, strategy, status, logs), dark glassmorphism SPA with real-time logs.
9. **Phase 8: Entry Point & CLI** — `createRouter()` wire-up, `opencode-go-router` bin script, library exports.

### Verification
- `npm run build` — clean compilation with 0 errors
- `npm start` — app boots, both servers listen, setup guide prints
- Smoke test: graceful shutdown on SIGINT
- **Security audit**: scanned all 7 commits — no API keys, passwords, or secrets leaked. Only type names, method names, and placeholder strings present.
- Ports 18904/18905 confirmed free

### Deliverables
- 23 source files across 8 modules
- 7 git commits after initial commit
- Full README with installation and usage instructions

---

## 2026-06-22 — Session 3: Proxy Refactor (post-reference-repo analysis)

### What was done
1. **Cloned and analyzed all 3 reference repos** from PRD:
   - **codex-multi-auth**: Adopted session affinity pattern (`X-Session-Id` → account mapping)
   - **switchboard-go**: Adopted `isQuota429()` body parsing + body buffering for retries
   - **tokscale**: Adopted 5-bucket token breakdown for quota tracking

2. **Replaced `http-proxy` with custom fetch handler** — full control over request/response lifecycle:
   - Body buffering into memory before first upstream call (enables retry replay)
   - Explicit `fetch()` to upstream with per-key `Authorization: Bearer`
   - Response body parsing for token usage extraction
   - Retry loop with different keys on quota exhaustion
   - Streaming response back to client on success

3. **Added `src/proxy/quota-detector.ts`** — `isQuota429()` distinguishes real quota exhaustion from transient rate limits by parsing JSON body fields (`insufficient_quota`, `credit balance`, `exhausted`, etc.) and `X-RateLimit-Reason` header

4. **Added `src/proxy/response-parser.ts`** — Token usage extraction from OpenAI and Anthropic response formats. `estimateCost()` with configurable pricing rates.

5. **Added `src/proxy/session-affinity.ts`** — Maps `X-Session-Id` → account for cache consistency. 20-min TTL, 512-entry cap.

6. **Rewrote `src/proxy/header-passthrough.ts`** — Clean header forwarding with hop-by-hop stripping, cache header preservation.

7. **Updated `src/router/quota-tracker.ts`** — Accepts real `TokenBreakdown` data (input, output, cacheRead, cacheWrite, reasoning) instead of generic counters.

### Files changed
- `src/proxy/server.ts` — Complete rewrite (removed http-proxy dependency)
- `src/proxy/header-passthrough.ts` — Rewritten
- `src/router/quota-tracker.ts` — Updated for TokenBreakdown
- `src/router/index.ts` — Updated wiring
- `package.json` — Removed http-proxy dependency
- New: `quota-detector.ts`, `response-parser.ts`, `session-affinity.ts`

### Verification
- `npm run build` — clean compilation
- Full integration test: dashboard serves HTML, API CRUD works, proxy forwards to upstream (confirmed via opencode.ai 404 response), logs stream, status shows per-key quota
- Removed unused `http-proxy` dependency

---

## 2026-06-22 — Session 4: Optional ntfy Push Notifications

### What was done
1. **Created `src/notification/ntfy.ts`** — `NtfyNotifier` class that POSTs to any ntfy-compatible URL
   - Methods: `keyExhausted()`, `allKeysExhausted()`, `circuitTripped()`, `circuitRecovered()`, `proactiveSwitch()`
   - Priority levels: low (circuit recovered), high (key exhausted with backups), urgent (all keys exhausted)
   - Tags: `information_source`, `rotating_light`, `warning` for mobile notification styling
   - Fully fire-and-forget: failures are logged locally, never block the request

2. **Wired into proxy** — Notifications fire automatically:
   - **Key quota exhausted** (402/429 with quota body) → `keyExhausted()` with remaining key count
   - **All keys exhausted** → `allKeysExhausted()` (sent once at the 503 response)
   - **Circuit breaker OPEN** (3 consecutive 5xx) → `circuitTripped()` with error count
   - **Proactive quota switch** (95% usage) → `proactiveSwitch()` with usage percentage

3. **Config** — `NTFY_URL` env var, added to `.env.example`. Optional: if unset, notifier is a no-op.

### Verification
- `npm run build` — clean compilation
- `NtfyNotifier.send()` test → successfully pushed to `https://ntfy.homelabrb.duckdns.org/Chanakya`
- App startup with `NTFY_URL` set → shows `[NTFY] Notifications enabled → <url>`

---

## 2026-06-22 — Session 5: Dynamic Cooldown from Upstream Signals + Rolling Window Calculation

### What was done

**Analyzed new reference repo: `floze-the-genius/opencode-multi-auth-codex`**
- ChatGPT Codex-based multi-auth (different architecture — uses OAuth tokens + direct Codex API, not OpenCode Go)
- Key insight: `resolveRateLimitedUntil()` combines Retry-After headers + error body JSON + error text regex + stored window resets
- Three-tier blocking model (rate limit, model unsupported, workspace deactivated) with independent cooldowns
- `x-codex-*` header extraction from every response for proactive window tracking

**Adopted patterns (universal HTTP API patterns, applicable to OpenCode Go):**

1. **`parseRetryAfterHeaderMs()`** — Standard HTTP `Retry-After` header parsing:
   - Priority: `retry-after-ms` > `retry-after` (seconds) > `retry-after` (HTTP-date)
   - Returns ms until retry, or null

2. **`parseResetFromErrorBody()`** — JSON error body parsing:
   - `error.retry_after_ms` (milliseconds, direct)
   - `error.retry_after` (seconds)
   - `error.resets_at` / `error.reset_at` (epoch timestamp, handles both seconds and ms)

3. **`parseResetFromErrorText()`** — Free-form text regex:
   - Pattern: `/(?:retry[\s-]*after|try again in)\s*(\d+)\s*(seconds?|minutes?|hours?)/i`
   - Also: `"Try again at <date>"` via Date.parse()

4. **`extractCodexResetMs()`** — `x-codex-*` header parsing:
   - `x-codex-primary-reset-at`, `x-codex-secondary-reset-at` (epoch timestamps)
   - `x-codex-primary-reset-after-seconds`, `x-codex-secondary-reset-after-seconds`
   - `x-ratelimit-reset` (legacy fallback)
   - Catches any upstream pass-through from OpenAI/ChatGPT backend

5. **`resolveCooldownMs()`** — Takes `Math.max(...candidates, fallbackMs)` from all sources

**Rolling window calculation in `QuotaTracker`:**
- Refactored from cumulative counters to timestamped usage ledger
- Stores per-request `{ cost, timestamp }` entries (max 2000 per key)
- `getEstimatedCooldown(keyId, now)`: On full $60 exhaustion, calculates the rolling 30-day window:
  - Filters usage within last 30 days
  - Sorts oldest-first
  - Removes oldest entries until cumulative drops below $60
  - Returns time until the oldest "exceeding" entry ages out of the 30-day window
  - Returns null if not exhausted or no usage data

**Updated `KeyManager.markExhausted()`:**
- Now accepts optional `cooldownMs` parameter
- Falls back to configurable `COOLDOWN_MS` (default 5h) if not provided

**Wired in proxy server:**
- On quota exhaustion: calls `resolveCooldownMs(headers, body, now, fallback)` for upstream signals
- Then calls `quotaTracker.getEstimatedCooldown()` for rolling window estimate
- Uses `Math.max(upstreamCooldown, rollingCooldown)` as the final cooldown duration
- Logs computed cooldown: `Key "Primary" quota exhausted (HTTP 429), cooldown 22.0h, failing over`

### Verification
- `npm run build` — clean compilation
- All 9 unit tests for parser functions pass (Retry-After seconds, HTTP-date, error body ms/resets_at, error text minutes/hours, codex headers, resolve max, codex+fallback)
- Rolling window calculation verified: $50/60 → no cooldown; $65/60 with 11 entries over 10 days → ~528 hours (22 days, matching the rolling window calculation)
- End-to-end test: dashboard serves status, proxy forwards to upstream, logs display properly
- `repos/` excluded from git tracking (reference clones only)

---

## 2026-06-23 — Session 6: Enhanced Dashboard — Structured Log Viewer, Key Toggle, Filters

### What was done

**1. Key enable/disable toggle**
- Added `'disabled'` to `KeyStatus` type
- `KeyManager.toggleKey(id)` — flips between active/disabled
- `getActiveKeys()` now skips disabled keys
- `PUT /api/keys/:id/toggle` dashboard API endpoint
- Frontend: toggle switch per key in key management panel

**2. Structured log emission**
- Proxy now emits every log entry with structured `meta`:
  - `method`, `path`, `statusCode`, `keyAlias`, `keyId`, `duration`, `tokens` (full breakdown), `cost`
- Old format: `"POST /chat/completions -> 200 via "key" (150ms)"`
- New format: `"POST /chat/completions"` with all detail in `meta` object

**3. Enhanced log viewer**
- 9-column grid rendering: Time | Level | Method | Path | Status | Key | Duration | Tokens (i:o:cr:cw:r) | Cost
- Color-coded status codes (green=2xx, yellow=3xx, red=4xx+)
- Token breakdown badges: `i:500 o:1200 cr:50 cw:10 r:0`
- Hover highlighting on log rows

**4. Log filters**
- Path text filter (real-time filtering on existing + incoming logs)
- Status code text filter
- Key alias dropdown (populated from current keys)
- Level dropdown (info/warn/error/debug)
- Pause/resume toggle (buffers logs while paused, replays on resume)
- Clear button

**5. Visual updates**
- Disabled keys at 50% opacity in both key list and status ledger
- Disabled health indicator (gray dot)
- Quota bar at 0% for disabled keys
- `status=disabled` badge styling

### Files changed
- `src/router/types.ts` — Added `'disabled'` KeyStatus
- `src/router/key-manager.ts` — Added `toggleKey()`, disabled-aware `getActiveKeys()`
- `src/proxy/server.ts` — Structured log meta emission
- `src/dashboard/server.ts` — Added toggle endpoint, `enabled` field in API responses
- `src/dashboard/public/index.html` — Filter controls, pause checkbox
- `src/dashboard/public/app.js` — Rewritten with 9-column log rendering, filters, toggle handler
- `src/dashboard/public/styles.css` — New styles: toggle switch, log grid, filter bar, disabled states

### Verification
- `npm run build` — clean compilation
- Toggle API tested: key flips active ↔ disabled, other keys unaffected
- Structured logs verified: `POST /chat/completions` → status=404, key=rishabhbajpai24, dur=147, tokens=null
- Dashboard HTML loads, filters render, WebSocket connects
