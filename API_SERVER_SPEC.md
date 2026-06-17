# Meridian Bot — HTTP + WebSocket Server Spec

> Companion to `PRD.md`. This document describes the **bot-side** changes needed in `meridian-op` to expose data to the dashboard in `meridian-ui`. The dashboard is read-and-control; this server is its only data source.

---

## 1. Goals & non-goals

**Goals**
- Expose REST endpoints for snapshot data the dashboard needs (positions, decisions, lessons, candidates, config, etc.).
- Expose a WebSocket channel for live events (PnL ticks, deploy/close lifecycle, OOR transitions, tool-call stream, cycle start/finish).
- Be a thin, additive layer — **zero changes** to existing cycle/tool logic. Hook by importing existing emitters or wrapping existing notifier functions.
- Localhost-only by default. Bound to `127.0.0.1`.

**Non-goals**
- Multi-user auth, tenancy, RBAC.
- Database. All reads go through the same JSON files the bot already uses.
- Replacing Telegram. Both Telegram notifiers and WebSocket emits fire side-by-side.
- Exposing the wallet private key or `.env` contents over HTTP.

---

## 2. Stack

- **`fastify`** — small, fast, good JSON schema validation, first-class WebSocket plugin (`@fastify/websocket`).
- **`@fastify/cors`** — allow `http://localhost:5173` and the dashboard's dev/prod origins.
- **No new persistence.** Reads call existing modules; writes call existing tools (`executeTool`, direct `closePosition`, etc.).

Alternative: Express + `ws`. Fastify recommended for the validation ergonomics.

---

## 3. Files to add

```
meridian-op/
  server/
    index.js              # Fastify app, route registration, startup
    bus.js                # EventEmitter — bot internals publish here, server fans out to WS clients
    routes/
      positions.js
      state.js
      decisions.js
      lessons.js
      pool-memory.js
      candidates.js
      config.js
      control.js          # POST endpoints — close, claim, pause, deploy, update_config, REPL
      wallet.js
      hivemind.js
      logs.js
    ws/
      index.js            # WebSocket upgrade handler, client registry, event broadcaster
      events.js           # Event type constants + payload schemas
    middleware/
      localhost-only.js   # Reject non-127.0.0.1 connections
      token-auth.js       # Optional bearer token for LAN exposure (default off)
```

---

## 4. Files to modify (minimal)

| File | Change |
|---|---|
| `index.js` | Import `./server/index.js` and call `startServer()` after `startCronJobs()`. Replace direct `notifyOutOfRange`/`notifyDeploy`/etc. calls with `bus.emit(...)` calls that also fan out to Telegram. **No logic changes** — just one extra `bus.emit` per existing notify. |
| `tools/executor.js` | After `logAction(...)`, add `bus.emit("tool_call", { tool, args, result, success, duration_ms })`. One line. |
| `state.js` | After `markOutOfRange/markInRange/updatePnlAndCheckExits/recordClaim/recordClose`, add `bus.emit(...)`. |
| `package.json` | Add `fastify`, `@fastify/websocket`, `@fastify/cors`. |

> Pattern: **emit events from `bus`, don't import dashboard concerns into bot code**. The server subscribes to bus and translates to WebSocket frames. This keeps the bot runnable with the server disabled (just no subscribers).

---

## 5. REST endpoints

All routes prefixed `/api/v1`. JSON unless noted.

### Positions

| Method | Path | Returns |
|---|---|---|
| `GET` | `/positions/open` | `getMyPositions({ force?: bool })` snapshot. Query: `?force=true` to bypass 5-min cache. |
| `GET` | `/positions/history` | All closed positions from `state.json` + their performance record from `lessons.json`. Query: `?limit=50&offset=0&since=ISO8601`. |
| `GET` | `/positions/:address` | Single position with full state + pool memory + signal snapshot + recent ticks. |
| `GET` | `/positions/:address/snapshots` | All recorded snapshots from `pool-memory.json` for the pool, filtered to position lifetime. |

### State / cycles

| Method | Path | Returns |
|---|---|---|
| `GET` | `/state/summary` | `{ open: n, closed: n, total_value_usd, total_unclaimed_usd, balance: {sol, tokens[]}, cycles: {management_last_run, screening_last_run, pnl_poll_last_tick, next_management_in_sec, next_screening_in_sec}, dryRun: bool, paused: bool }`. |
| `GET` | `/state/cycle-history` | Last 100 cycle runs from `actions-YYYY-MM-DD.jsonl` (parsed). |

### Decisions

| Method | Path | Returns |
|---|---|---|
| `GET` | `/decisions` | `decision-log.json` `decisions[]`, newest first. Query: `?type=deploy|close|skip|no_deploy&limit=100`. |
| `GET` | `/decisions/:id` | Single decision. |

### Lessons & performance

| Method | Path | Returns |
|---|---|---|
| `GET` | `/lessons` | `lessons.json` `lessons[]`. Query: `?role=SCREENER|MANAGER|GENERAL&pinned=true`. |
| `POST` | `/lessons/:id/pin` | Toggle pin. |
| `DELETE` | `/lessons/:id` | Soft-delete via `clear_lessons` tool (no, individual). |
| `GET` | `/performance` | `lessons.json` `performance[]`. Query: `?since=ISO8601&limit=500`. |
| `GET` | `/performance/summary` | `getPerformanceSummary()` (existing helper). |
| `GET` | `/performance/equity-curve` | Cumulative PnL series, one entry per closed position, suitable for direct chart binding. |

### Pool memory

| Method | Path | Returns |
|---|---|---|
| `GET` | `/pools` | All pools from `pool-memory.json` as array, sortable. |
| `GET` | `/pools/:address` | Full record with snapshots, deploys, notes, cooldown status. |
| `POST` | `/pools/:address/note` | Append note via `addPoolNote`. Body: `{ note: string }`. |

### Candidates / screening

| Method | Path | Returns |
|---|---|---|
| `GET` | `/candidates` | Triggers `getTopCandidates({ limit: 10 })` — fresh fetch (slow, 5–10s). Query: `?cached=true` to return last-run candidates from in-memory cache. |
| `POST` | `/screening/run` | Triggers `runScreeningCycle({ silent: true })`. Returns immediately with `{ accepted: true, cycle_id }`. Progress streams over WS. |
| `POST` | `/management/run` | Triggers `runManagementCycle({ silent: true })`. Same shape. |

### Config

| Method | Path | Returns |
|---|---|---|
| `GET` | `/config` | Sanitized `user-config.json` (keys matching `*_KEY/*SECRET*/*TOKEN*` redacted). |
| `GET` | `/config/schema` | The full `CONFIG_MAP` from `executor.js` with type + section + clamp info — drives the dashboard's settings UI. |
| `PUT` | `/config` | Body: `{ updates: { key: value }, reason: string }`. Calls `executeTool("update_config", ...)`. Returns `{ applied, unknown, reason }`. |

### Control (write)

All POST endpoints below require a confirmation token: client first POSTs without `confirm=true`, server returns `{ pending: true, confirm_token, summary }`; client re-POSTs with `confirm_token` to execute. Prevents accidental clicks.

| Method | Path | Action |
|---|---|---|
| `POST` | `/control/close-position` | Body: `{ position_address, reason, skip_swap?: bool }`. Calls `closePosition()`. |
| `POST` | `/control/close-all` | Body: `{ reason }`. Loops `closePosition` over all open. |
| `POST` | `/control/claim-fees` | Body: `{ position_address }`. Calls `claimFees()`. |
| `POST` | `/control/swap-token` | Body: `{ input_mint, output_mint, amount, slippage_bps }`. |
| `POST` | `/control/deploy-position` | Body: full `deploy_position` args. Honors `ONCE_PER_SESSION` lock (returns 409 if locked). |
| `POST` | `/control/pause` | Sets `_paused = true` — cron jobs skip until resume. |
| `POST` | `/control/resume` | Clears pause. |
| `POST` | `/control/set-instruction` | Body: `{ position_address, instruction }`. |
| `POST` | `/control/clear-instruction` | Body: `{ position_address }`. |
| `POST` | `/repl` | Body: `{ goal, agent_type?: "GENERAL"|"SCREENER"|"MANAGER" }`. Spawns `agentLoop(...)` with `agent_type=GENERAL` by default, streams tool calls + final text over WS under a session ID returned in response. |

### Wallet

| Method | Path | Returns |
|---|---|---|
| `GET` | `/wallet/balances` | `getWalletBalances()` result. |

### HiveMind

| Method | Path | Returns |
|---|---|---|
| `GET` | `/hivemind/status` | Last sync, pull mode, shared-lesson count. |
| `POST` | `/hivemind/pull` | Manual `pullHiveMindLessons` + `pullHiveMindPresets`. |

### Logs

| Method | Path | Returns |
|---|---|---|
| `GET` | `/logs/today` | Tail of `logs/agent-YYYY-MM-DD.log`. Query: `?lines=200&level=info`. |
| `GET` | `/logs/actions` | JSONL audit from `logs/actions-YYYY-MM-DD.jsonl`. Query: `?since=ISO8601&tool=deploy_position`. |

---

## 6. WebSocket protocol

**Path:** `ws://127.0.0.1:<port>/ws`

**Connection:** Plain WS, no subprotocol. On connect server sends a `hello` frame with server version, current state summary, and authoritative server time (for clock-skew correction).

**Framing:** Newline-delimited JSON. Each frame is `{ type, ts, data }` where `ts` is server `ISO8601`.

### Event types

| `type` | Origin in bot | Payload (`data`) |
|---|---|---|
| `hello` | server connect | `{ server_version, paused, dry_run, state_summary }` |
| `pnl_tick` | `state.js` / `pnl-poller` every 3s | `{ position, pool_name, pnl_pct, pnl_usd, in_range, active_bin, value_usd, unclaimed_fees_usd, trailing_active, peak_pnl_pct }` |
| `oor_enter` | `markOutOfRange` first time | `{ position, pool_name, since: ISO8601 }` |
| `oor_exit` | `markInRange` after OOR | `{ position, pool_name, minutes_oor }` |
| `oor_warn` | `notifyOutOfRange` fires | `{ position, pool_name, minutes_oor, threshold_minutes }` |
| `trailing_armed` | `peak_pnl_pct` crosses `trailingTriggerPct` | `{ position, pool_name, peak_pnl_pct, trigger_pct }` |
| `trailing_drop_pending` | `queueTrailingDropConfirmation` | `{ position, peak_pnl_pct, current_pnl_pct, drop_pct, confirmation_in_sec }` |
| `trailing_drop_confirmed` | `resolvePendingTrailingDrop` true | `{ position, peak_pnl_pct, current_pnl_pct, drop_pct }` |
| `trailing_drop_cancelled` | recheck within tolerance | `{ position, reason }` |
| `cycle_start` | `runManagementCycle`/`runScreeningCycle` entry | `{ cycle: "management"|"screening", cycle_id, triggered_by: "cron"|"poll"|"manual"|"post_management" }` |
| `cycle_finish` | cycle exit | `{ cycle, cycle_id, duration_ms, summary, error: string\|null }` |
| `tool_call_start` | executor.js pre-call | `{ tool, args (sanitized), tool_call_id, cycle_id?, repl_session_id? }` |
| `tool_call_finish` | executor.js post-call | `{ tool, tool_call_id, success, result (truncated), duration_ms }` |
| `deploy_start` | `deployPosition` entry | `{ pool, pool_name, amount_sol, strategy, bin_range }` |
| `deploy_finish` | `deployPosition` exit | `{ position, pool, pool_name, success, tx?, error?, signal_snapshot }` |
| `claim_start` / `claim_finish` | `claimFees` | `{ position, pool_name, claimed_usd?, error? }` |
| `close_start` / `close_finish` | `closePosition` | `{ position, pool_name, reason, pnl_pct?, pnl_usd?, fees_earned_usd?, auto_swapped?, error? }` |
| `swap_start` / `swap_finish` | `swapToken` | `{ input_mint, output_mint, amount_in, amount_out?, error? }` |
| `decision_appended` | `appendDecision` | The decision entry (matches `decision-log.json` row shape). |
| `lesson_added` | `addLesson` / `recordPerformance` derives | The lesson row. |
| `pool_snapshot` | `recordPositionSnapshot` | `{ pool, snapshot }` (the snapshot object that was just appended). |
| `config_changed` | `update_config` | `{ applied, reason, source: "agent"|"user" }` |
| `weights_recalculated` | `signal-weights.js` | `{ weights, recalc_count }` |
| `paused` / `resumed` | control endpoints | `{ by: "user" }` |
| `repl_message` | `agentLoop` step inside `/repl` session | `{ repl_session_id, role: "assistant"|"tool", content?, tool_call? }` |
| `error` | uncaught in cycle, RPC failure, etc. | `{ source, message, stack? }` |
| `log` | `log()` emits with level ≥ warn | `{ level, tag, message }` (debounced to ≤ 10/sec to avoid flood) |

### Client → server frames

Optional; the dashboard can be purely receive-only.

| `type` | Purpose |
|---|---|
| `subscribe` | `{ types: ["pnl_tick", "decision_appended"] }` — filter incoming events. Default: all. |
| `unsubscribe` | Same shape. |
| `ping` | Server replies with `pong` (also auto-pings every 30s). |

### Idempotency & ordering

- Every event has a monotonically increasing `seq` number per server run. Dashboard tracks last `seq` and shows a stale-data banner if a gap is detected (it should reconnect and refetch snapshots).
- On reconnect, server sends `hello` again with current state — dashboard re-syncs from REST snapshots, not by replaying missed events. (No event store.)

---

## 7. Auth

**Default (localhost):** no auth. `127.0.0.1` bind only. `localhost-only.js` middleware rejects requests where `req.ip !== "127.0.0.1"` and `req.ip !== "::1"`.

**LAN mode (opt-in):** set `DASHBOARD_TOKEN=…` in `.env`. Server accepts `Authorization: Bearer <token>` for REST and `?token=` query param for WS. Token-auth middleware enforced when token is set. Dashboard prompts for token on first load and stores in `localStorage`.

**No CORS by default** beyond the dashboard's dev/prod origin (`http://localhost:5173`, configurable via `DASHBOARD_ORIGIN`).

---

## 8. Confirmation token flow (write endpoints)

```
POST /api/v1/control/close-position
Body: { position_address: "abc...", reason: "manual close from dashboard" }

200 OK
{
  "pending": true,
  "confirm_token": "ct_8f3c…",
  "expires_in_sec": 60,
  "summary": {
    "action": "close_position",
    "position": "abc...",
    "pool_name": "ROCKET-SOL",
    "current_pnl_pct": 2.3,
    "value_usd": 35.12,
    "warnings": []
  }
}
```

Client re-posts with `confirm_token` to execute. Server one-shots the token. Tokens TTL 60s.

Bypass for the `/repl` endpoint (chat doesn't need double-confirm — the agent's own `ONCE_PER_SESSION` locks apply).

---

## 9. Startup wiring

```js
// index.js — at the bottom of startup
import { startServer } from "./server/index.js";
import { bus } from "./server/bus.js";

const serverPort = Number(process.env.DASHBOARD_PORT ?? 7474);
startServer({ port: serverPort, host: "127.0.0.1" })
  .then(() => log("startup", `Dashboard API listening on http://127.0.0.1:${serverPort}`))
  .catch((e) => log("startup_warn", `Dashboard server failed: ${e.message}`));
```

Existing notifier calls get an additional `bus.emit`:

```js
// telegram.js (existing) — unchanged
export async function notifyDeploy(...) { /* sends Telegram */ }

// index.js (new) — wherever notifyDeploy is called, also emit
import { bus } from "./server/bus.js";
bus.emit("deploy_finish", { position, pool, pool_name, success, signal_snapshot });
notifyDeploy({ pair, amountSol, position, tx, priceRange });
```

Or cleaner: wrap the notifier in `telegram.js` to also `bus.emit`. Either way, **the bot remains runnable with the server stopped** — the bus is just an EventEmitter; no subscribers means events drop on the floor.

---

## 10. Failure modes & guarantees

| Concern | Approach |
|---|---|
| Bot crash | Server is in-process — it dies with the bot. Dashboard shows "disconnected" + auto-reconnect. |
| Server crash but bot lives | Wrap `startServer` in try/catch; log warning, continue without server. Cron + Telegram unaffected. |
| Slow REST endpoint blocks cycle | Routes that need fresh on-chain data (`getMyPositions({ force: true })`, `getTopCandidates`) are debounced — if a cycle is busy, return cached. |
| WebSocket back-pressure | Per-client send buffer cap 100 events. Overflow drops oldest with a `dropped` event. |
| Tool call from dashboard while LLM is mid-cycle | `_managementBusy/_screeningBusy` already prevent overlap. Endpoints return 409 with `retry_after`. |
| Once-per-session tool locks | Server respects them. Dashboard surfaces lock state via `state_summary.locks`. |

---

## 11. Implementation order (suggested)

1. `server/bus.js` + `server/index.js` skeleton, `GET /api/v1/state/summary`, `localhost-only` middleware. Wire into `index.js` startup. **Smoke test from curl.**
2. All read-only REST routes (positions, decisions, lessons, performance, pool-memory, config, wallet, logs).
3. WebSocket plumbing + `hello` + `pnl_tick` only. Connect from a throwaway HTML page.
4. Hook `bus.emit` into `executor.js` post-tool, `state.js` transitions, `index.js` cycles. Add the full event taxonomy from §6.
5. Control endpoints with confirmation-token flow.
6. `/repl` streaming endpoint (last — needs the full WS pattern working).
7. Optional: `DASHBOARD_TOKEN` LAN-auth middleware.

---

## 12. Open questions

- **PnL tick cadence on WebSocket** — the bot polls every 3s (`config.pnl.pollIntervalSec`). Push every tick, or downsample to 5s? Suggest: push every tick; dashboard's chart layer down-samples for rendering.
- **Should `/repl` use the same WebSocket connection or open a per-session WS?** Suggest: same WS, multiplexed by `repl_session_id`.
- **`getTopCandidates` is slow (5–10s with 150ms throttle)** — should the API stream candidate enrichment over WS instead of blocking the REST call? Suggest yes; for v1, REST with a 30s timeout is acceptable.
