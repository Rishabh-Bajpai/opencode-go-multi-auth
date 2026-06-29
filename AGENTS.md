# AGENTS.md

> Repo-specific notes for OpenCode sessions working in `opencode-go-multi-auth`.
> Keep this file short. Add only what an agent would otherwise get wrong.

## What this repo is

A TypeScript proxy plugin that pools multiple OpenCode Go + Zen API subscriptions
into a single endpoint, with a local web UI dashboard. It runs as an
**OpenCode plugin** (auto-starts a shared detached daemon) or as a
**standalone CLI**. See `README.md` for end-user docs; this file is for
agents editing the code.

## Build, typecheck, run

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc AND cp -r src/dashboard/public/. dist/dashboard/public/
npm run dev         # tsx watch src/bin.ts (standalone mode, no plugin)
npm run start       # node dist/bin.js (standalone mode)
npm run clean       # rm -rf dist
```

**Critical:** `src/dashboard/public/` is a static asset directory that is
**not compiled by `tsc`**. `npm run build` is a two-step pipeline: it
runs `tsc` first, then `cp -r` the dashboard public/ into `dist/`. If you
edit a `.html`, `.css`, or `.js` file under `src/dashboard/public/`, the
copy step is what makes the change visible. Running `tsc` alone, or
running `tsx` directly, will not pick up dashboard UI changes. The `.ts`
source under `src/dashboard/server.ts` is compiled normally.

There is **no test suite, no linter, and no formatter configured** in
`package.json`. Verification = `npm run typecheck && npm run build`.
Add new tooling only after confirming with the user.

## Runtime topology — do not break this

- The **OpenCode plugin entry** is `src/opencode-plugin.ts` (compiled to
  `dist/opencode-plugin.js`). The plugin's only job is to spawn (or
  reuse) a single detached daemon.
- The **daemon entry** is `src/bin.ts` (compiled to `dist/bin.js`). The
  daemon listens on:
  - `18905` — the proxy / API endpoint (this is what opencode points at
    via `provider.opencode-go.options.baseURL` and any custom
    `provider.<name>.options.baseURL` ending in `/zen` for the Zen
    upstream; see the Dual upstream section below)
  - `18904` — the dashboard web UI
- The daemon is **detached** and **shared across opencode sessions**.
  Closing the opencode UI does **not** stop the daemon. Killing the
  opencode session does **not** stop the daemon. The plugin's
  `dispose()` is intentionally a no-op for this reason.
- The active daemon writes its PID to `~/.opencode/router.pid` and a
  bootstrap lock to `~/.opencode/router-bootstrap.lock`. Both paths are
  hardcoded in `src/runtime/daemon.ts`.

### Hot-swap pattern (when an agent needs to restart the daemon)

**The agent must NOT kill or restart the daemon itself.** The agent's
own shell session is itself routed through the proxy on port 18905.
Restarting the daemon tears down the proxy the agent is using, which
can corrupt the in-flight `opencode` turn, the WebSocket log stream,
and the live edits the user is making. **Always ask the user to run
the restart command themselves** and wait for them to confirm before
proceeding.

When backend code changes (`src/`, `npm run build`) require a restart,
or when something is stuck, the agent should:

1. Build: `npm run build` (the agent is allowed to do this — it
   writes to `dist/` only and does not touch running processes).
2. Tell the user to run `./restart-router.sh` from the repo root
   (or the equivalent one-liner below) and wait.
3. Verify with `curl -sf http://127.0.0.1:18904/healthz` after the
   user reports back.
4. Never `kill` the daemon, never `kill -9` it, never run
   `node dist/bin.js` in the foreground. Restarting the router also
   does **not** affect the OpenCode session (`opencode serve` /
   `opencode -s ...`) — those are independent processes.

The repo ships `restart-router.sh` for this purpose. It is the
canonical recipe:

```bash
PID=$(cat ~/.opencode/router.pid 2>/dev/null | jq -r .pid 2>/dev/null)
[ -n "$PID" ] && kill "$PID" 2>/dev/null
sleep 1
cd "$(dirname "$(readlink -f "$0")")"
nohup env OPENCODE_ROUTER_PLUGIN_MODE=1 node dist/bin.js > /dev/null 2>&1 &
disown
sleep 2
curl -sf http://127.0.0.1:18904/healthz && echo " — daemon is healthy"
```

`OPENCODE_ROUTER_PLUGIN_MODE=1` suppresses the "run setup wizard"
prompt at boot. If a stale WebSocket log-stream connection from the
OpenCode dashboard keeps the previous daemon's `server.close()` from
resolving, the old process stays in `ps` holding no LISTEN sockets;
`kill -KILL <old-pid>` is safe in that state and is the user's call,
not the agent's.

## Routing / request flow

```
opencode CLI
  → provider.opencode-go.options.baseURL  (default http://localhost:18905)
  → provider.opencode-zen.options.baseURL (default http://localhost:18905/zen)
  → src/proxy/server.ts handleRequest
     → keyManager.selectKey (routing strategy + session stickiness)
     → circuitBreaker.isAvailable
     → buildUpstreamHeaders + cache-header passthrough
     → fetch(upstreamUrl, signal)
  → https://opencode.ai/zen/go/v1/{messages|chat/completions}  (Go, no /zen prefix)
  → https://opencode.ai/zen/v1/{messages|chat/completions}     (Zen, /zen prefix stripped)
  → response streamed byte-for-byte back to opencode
```

Key invariants to preserve:

- **The proxy is a byte-for-byte pass-through on the request and
  response body.** Do not parse `tool_use`, `tools`, or `messages` to
  make routing decisions. The only body modification is
  `stream_options.include_usage = true` injection, which is gated to
  `targetPath ∈ {/chat/completions, /v1/chat/completions}` and
  `stream === true` (see `prepareRequest` in `src/proxy/server.ts`).
- **Path routing:** opencode-go serves Anthropic models
  (minimax-m*, Qwen3.7, etc.) on `/messages` and OpenAI-compat models
  (DeepSeek V4, GLM, Kimi) on `/chat/completions`. The proxy
  (`buildUpstreamUrl`) rewrites paths so `/v1` is not duplicated.
- **Dual upstream:** The proxy detects a `/zen` path prefix in the
  incoming request URL and routes to the Zen upstream
  (`upstreamUrlZen`, default `https://opencode.ai/zen/v1`) instead of
  the Go upstream (`upstreamUrl`, default `https://opencode.ai/zen/go/v1`).
  The `/zen` prefix is stripped before forwarding. Both upstreams
  support Anthropic and OpenAI formats. Configured in OpenCode as
  a custom provider with `npm: "@ai-sdk/openai-compatible"` (for free
  Zen models on `/v1/chat/completions`) or `npm: "@ai-sdk/anthropic"`
  (for paid Zen models on `/v1/messages`) and
  `baseURL: http://localhost:18905/zen`. The provider name MUST be
  unique — do NOT use `opencode-zen` or `opencode`, as OpenCode will
  route those to the built-in provider and bypass the proxy. Use a
  unique name like `multi-auth-zen` or `proxy-zen`.

  **Recommended `opencode.json` config for the free Zen tier:**

  ```json
  {
    "provider": {
      "opencode-go": {
        "options": { "baseURL": "http://localhost:18905" },
        "models": { "deepseek-v4-flash": {} }
      },
      "multi-auth-zen": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "OpenCode Zen (multi-auth)",
        "options": { "baseURL": "http://localhost:18905/zen" },
        "models": {
          "deepseek-v4-flash-free": {},
          "mimo-v2.5-free": {},
          "qwen3.6-plus-free": {},
          "minimax-m3-free": {},
          "nemotron-3-ultra-free": {},
          "north-mini-code-free": {}
        }
      }
    }
  }
  ```

  Reference the provider from agents as `multi-auth-zen/<model>`, e.g.
  `"model": "multi-auth-zen/deepseek-v4-flash-free"`. Adding new free
  models: the dashboard's Models page shows a drift banner with a
  "Copy snippet" button that produces a JSON fragment to paste into
  the `models` block — see "Zen model drift detection" below.
- **Zen model drift detection:** The Models page calls
  `GET /api/zen-provider-models?provider=<name>` which reads
  `~/.config/opencode/opencode.json` (honouring `OPENCODE_CONFIG`),
  fetches the live catalog from the proxy's `/zen/v1/models`, and
  reports `missing` (live but not configured) and `stale` (configured
  but no longer in upstream). The Models page shows a banner with
  a "Copy snippet" action so the user can paste the missing models
  into their `opencode.json`. A one-shot toast is fired on first
  detection per session (deduped by drift signature). Re-checks
  every 12 hours while the Models page is open. The endpoint is
  resilient to missing files, JSON errors, and upstream fetch
  failures — all failure modes return a 200 with a sensible
  `liveError` field rather than 5xx.
- **Project-local `opencode.json`:** Only the global
  `~/.config/opencode/opencode.json` is read for drift detection.
  Project-local configs (cwd-relative) are not currently scanned.
  If the user has a project-local config, the drift detection will
  report `providerMissing: true` and prompt them to use the global
  config or extend the read logic.
- **Auth headers:** the proxy always sets both `Authorization: Bearer …`
  AND `x-api-key: …` because some Anthropic-style endpoints reject one
  of them. Do not narrow this to a single header.
- **Upstream timeout:** there is intentionally **no wall-clock timeout**
  on the upstream fetch. This mirrors opencode's `provider.ts:1703`,
  which only adds a signal when `options['timeout']` is set, and the
  anthropic/opencode provider definitions set neither `timeout`,
  `headerTimeout`, nor `chunkTimeout`. If you need a guard, use the
  env-gated `REQUEST_TIMEOUT_MS` or `UPSTREAM_HUNG_TIMEOUT_MS` (both
  default `0` = off) — **do not reintroduce a hard-coded timeout**. The
  client-cancel signal is forwarded via `res.once('close')` →
  `upstreamAbortController.abort()` and must keep working.

## Quota handling — react, do not predict

The router does **not** estimate quota. OpenCode runs per-model and
per-promo multipliers (often 3x) and other OpenCode processes may
share the same account, so a local cost accumulator is unreliable
for predicting "this account is exhausted". The only signal we trust
is the upstream itself.

- Cooldown is taken from the upstream's own 4xx response:
  `Retry-After` header → `x-codex-*-reset-at` / `x-codex-*-reset-after-seconds`
  headers → `error.retry_after_ms` / `error.retry_after` / `error.resets_at`
  body fields → "retry after N m/h" text. `COOLDOWN_MS` is the
  last-resort fallback (5h default).
- `quota-detector.ts:isQuota429()` distinguishes a real quota
  response (insufficient_quota, usage_not_included, freeusagelimit,
  exhausted / credit balance text, 402 status) from a generic 429
  rate limit. Only the former triggers a cooldown.
- The `cost` field that some providers return in usage payloads is
  recorded as a *display-only* `costAccumulated`. It is never used
  to drive routing, never compared against a `QUOTA_LIMIT`, and
  never fed into a rolling-window estimate.
- The OpenCode Go upstream does not return a `cost` field in its
  responses. `src/proxy/rate-card.ts` provides a per-model rate
  card (input/output/cacheRead/cacheWrite per 1M tokens) sourced
  from https://opencode.ai/docs/go. The proxy server falls back to
  `estimateCost(model, tokens)` when the upstream omits the field,
  and tags the log entry with `costEstimated: true`. The dashboard
  renders estimated values in yellow italic with a `~` prefix and
  a tooltip: "Estimated from published rate card — may not reflect
  the actual cost." Actual upstream values render plain without
  the `~` prefix. Models missing from the rate card keep `cost: null`
  and the cell shows `—` with a tooltip explaining the absence.
  Tiered pricing (Qwen3.6/3.7 Plus, Qwen3.7 Max) applies the higher
  tier rate when `cacheRead + input > 256_000` tokens.
- Aggregate actual cost from the local `opencode.db` SQLite file is
  available through `OpenCodeUsageStore` and surfaced in the
  overview's `actualUsage` summary (30d / 7d / calendar month /
  all-time). Per-request matching between proxy log entries and
  opencode.db session rows is not implemented — the IDs are
  different formats and the heuristic would be fragile.
- The two strategies that depended on the cost estimate
  (`priority_spillover` and `highest_remaining_quota`) were
  removed. `normalizeRoutingStrategy()` maps them to
  `priority_failover` for backward compatibility.

## State files in `~/.opencode/` (live state, not source)

- `router-config.json` — persisted config (strategy, ports, etc.).
  Overrides env vars at boot via `src/storage/config-store.ts`.
- `router-keys.enc` — AES-256-GCM encrypted API keys, key derived from
  `PBKDF2(machine-identity, salt, 600_000, sha512)`. **Never** log or
  print key material. **Never** commit this file (already in
  `.gitignore`).
- `router-state.json` — runtime state (key health, cooldowns, recent
  logs, quota usage). Persisted by `src/storage/runtime-state-store.ts`
  with a 100 ms debounce.
- `router.pid`, `router-bootstrap.lock`, `router-bootstrap.log` — see
  `src/runtime/daemon.ts`.
- `router.log` — winston log file (rotated by winston, capped at
  `~/.opencode/`). Useful first stop when debugging "what did the
  proxy do" — the dashboard at `localhost:18904` mirrors it.

## Local working dirs (gitignored, do not touch)

- `repos/` — local clones of reference repos used during design
  (codex-multi-auth, switchboard-go, tokscale). Untracked, ignored.
- `Developers Log/` — the maintainer's personal dev log. Untracked,
  ignored. Do not read or modify.
- `current-dashboard.png`, `.playwright-mcp/` — debugging screenshots
  and Playwright MCP cache. Untracked, ignored.
- `*.enc` — encrypted key files. Never commit.

## Style and conventions

- TypeScript `strict: true`, `target: ES2022`, `module: Node16`. The
  build emits `.js` + `.d.ts` + source maps. The runtime is Node 22+.
- ESM imports use the explicit `.js` extension even when the source
  is `.ts` (Node16 module-resolution requirement).
- Avoid adding new runtime dependencies without a strong reason — the
  project deliberately keeps the dep list to winston, ws, express,
  and the two `@opencode-ai/*` packages. See `package.json`.
- Do not add code comments unless they capture something the next
  reader would miss (a non-obvious gotcha, a documented upstream
  quirk, a security boundary). Self-explanatory code stays
  comment-free.
- The dashboard `public/app.js` is hand-written vanilla JS. No build
  step, no bundler, no transpilation.
