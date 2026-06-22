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
