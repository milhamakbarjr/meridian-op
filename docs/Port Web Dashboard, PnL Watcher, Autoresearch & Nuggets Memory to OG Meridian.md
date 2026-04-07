# Plan: Port Web Dashboard, PnL Watcher, Autoresearch & Nuggets Memory to OG Meridian

## Context
Four features from fciaf420's fork are worth porting: Web Dashboard (real-time UI), PnL Watcher separation (instant exits without LLM), Autoresearch (automated prompt optimization), and Nuggets Holographic Memory (cross-session associative memory with confidence-scored recall). The OG Meridian has stronger safety (role filtering, double-deploy guards) but lacks these features.

**Approach:** Build these as additive modules that plug into the existing architecture. No refactoring of working safety systems.

---

## Phase 1: Notifier Event Bus (Foundation)

**Why first:** Both the dashboard and PnL watcher need a central event system. Currently ~25 direct Telegram calls are scattered across index.js and executor.js.

**New file: `notifier.js`** (~30 lines)
- `EventEmitter` singleton with typed events
- Events: `deploy`, `close`, `swap`, `claim`, `oor`, `management:start`, `management:end`, `screening:start`, `screening:end`, `pnl_exit`, `briefing`, `status`
- Export: `emit(event, data)`, `on(event, handler)`, `off(event, handler)`

**Changes to existing files:**
- `tools/executor.js` (lines 299-339): Replace `notifyDeploy/Close/Swap()` calls with `emit('deploy', {...})`, `emit('close', {...})`, `emit('swap', {...})`
- `telegram.js`: Add `subscribeToNotifier()` that listens to events and calls existing `notifyDeploy/Close/Swap/OutOfRange` functions. This preserves all existing Telegram behavior.
- `index.js`: Replace direct `sendHTML/sendMessage` for briefing/OOR with emits. Keep REPL and Telegram command handlers as-is (they're interactive, not events).

**Key principle:** Telegram subscribes to the notifier on startup. Old behavior preserved, new subscribers (WebSocket) can be added.

---

## Phase 2: PnL Watcher Separation

**Why:** Currently when the 30s poller detects an exit condition (index.js:641-670), it triggers the full `runManagementCycle()` which goes through the LLM. The fork's approach closes directly — much faster for time-critical stop-loss/trailing TP exits.

**New file: `pnl-watcher.js`** (~120 lines)

Extract from `index.js` lines 641-670 + lines 83-98 (peak confirmation):

```
startPnlWatcher(deps) → setInterval(30s)
  deps = { getMyPositions, closePosition, config, isBusy, isManagementBusy, isScreeningBusy }

Each tick:
  1. Guard: skip if any busy flag is true
  2. getMyPositions({ force: true, silent: true })
  3. For each position:
     a. Age guard: skip if deployed < 2 minutes ago (prevents acting on fresh deploys)
     b. Peak confirmation: queuePeakConfirmation + schedulePeakConfirmation (15s setTimeout)
     c. updatePnlAndCheckExits() — returns exit action or null
     d. If exit action is STOP_LOSS or TRAILING_TP:
        → Call closePosition() DIRECTLY (bypass LLM)
        → emit('pnl_exit', { position, reason, pnl })
        → Record to state.recentAutoCloses[]
     e. If exit action is OOR or LOW_YIELD:
        → Trigger runManagementCycle({ silent: true }) (these need LLM judgment)
        → break
  4. Reset busy flag
```

**Changes to existing files:**
- `index.js`: Remove PnL poll code (lines 641-670), import and call `startPnlWatcher()` in `startCronJobs()`. Pass `closePosition` from dlmm.js and busy flag getters.
- `state.js`: Add `recentAutoCloses` array (capped at 20) to track watcher-initiated closes for diagnostics.
- `tools/dlmm.js`: No changes — `closePosition()` already works standalone.

**Safety:** The watcher only auto-closes for STOP_LOSS and TRAILING_TP (deterministic, time-critical). OOR and LOW_YIELD still go through management cycle + LLM.

---

## Phase 3: Web Dashboard

**New dependencies:** `express` ^5.2.1, `ws` ^8.19.0

**New file: `server.js`** (~250 lines) — Express + WebSocket backend

**REST endpoints:**
- `GET /api/status` — busy flags, timer countdowns, config summary, wallet balance
- `GET /api/positions` — current positions with PnL
- `GET /api/candidates` — last screening candidates (cached)
- `GET /api/history` — performance history from lessons.js
- `GET /api/lessons` — current lessons
- `GET /api/config` — current config (sanitized, no private keys)
- `GET /` — serve static SPA files from `web/dist/`

**WebSocket events (server → client):**
- `init` — full state snapshot on connection
- `positions` — position updates (after management/deploy/close)
- `candidates` — screening results
- `notification` — deploy/close/swap/oor/pnl_exit events (via notifier subscription)
- `timer` — countdown to next management/screening cycle (every 10s)
- `status` — busy flag changes

**WebSocket events (client → server):**
- `chat` — send message to GENERAL agent loop, stream response back
- `command` — direct commands (/positions, /close N, etc.)

**Authentication:** Simple bearer token from `.env` (`DASHBOARD_TOKEN`). WebSocket sends token on connect, REST checks `Authorization` header. Optional — if not set, dashboard is open (local use).

**New directory: `web/`** — React + Vite + Tailwind SPA

Minimal viable dashboard (not the full fork's UI — build incrementally):

**Views:**
1. **Dashboard tab** — Position cards (pool name, PnL %, progress bar, age, fees, range status), wallet balance, next cycle countdown
2. **Activity tab** — Live feed of events (deploy, close, swap, OOR, exits) with timestamps
3. **Chat tab** — Send messages to the bot, see responses (like Telegram but in browser)

**Components (keep simple, no Radix/cmdk initially):**
- `PositionCard` — shows one position with PnL, range bar, action buttons (close, claim)
- `EventFeed` — scrolling list of notifier events
- `ChatPanel` — input + response display
- `StatusBar` — wallet SOL, position count, next cycle timer, busy indicators

**Integration with index.js:**
- `startServer()` called during startup after cron setup
- Server imports: `getMyPositions`, `getWalletBalances`, `config`, `getPerformanceHistory`, `getLessonsForPrompt`, timer state
- Server subscribes to notifier for real-time broadcasts
- Timer state: expose `getTimerState()` from index.js that returns seconds-until-next for management/screening

**npm scripts:**
- `npm run build:web` — `cd web && npm run build`
- `npm run dev:web` — `cd web && npm run dev` (Vite dev server with proxy to 3737)

---

## Phase 4: Autoresearch

**New file: `autoresearch.js`** (~300 lines)

**Persistence:** `autoresearch.json`
```json
{
  "experiments": [],
  "activeExperiment": null,
  "cooldownRemaining": 0,
  "keptOverrides": {}
}
```

**Algorithm (triggered from `recordPerformance()` after each close):**

1. **Gate check:** Need ≥15 closed positions total. If active experiment running, evaluate it instead of starting new.

2. **Loss attribution** (last 15 losing positions):
   - `screener_criteria`: default bucket + OOR-upside on bid_ask strategies
   - `manager_logic`: stop_loss, trailing_tp, or OOR-downside close reasons
   - `range_selection`: range_efficiency < 30%

3. **Pick worst section** (most attributed losses)

4. **Read current prompt text** via new `getPromptSection(sectionName)` function in prompt.js

5. **Generate mutation** via LLM call (use existing OpenRouter setup, cheap model):
   - System prompt: "You are a DLMM strategy optimizer. Generate ONE small, targeted modification to this prompt section."
   - Input: current section text + loss context
   - Output: `HYPOTHESIS: ...` + `MODIFIED_TEXT: ...`

6. **Compute baseline** from last N closes (win rate × 0.6 + avg PnL × 0.4)

7. **Activate experiment:** Store override in `autoresearch.json`, inject into prompt.js

8. **Evaluate on each subsequent close** (only positions deployed AFTER experiment start):
   - **Circuit breaker:** If first 3 trial closes are ALL losses → auto-revert
   - **Full trial:** After 7+ trial closes, compute composite score vs baseline
   - KEEP if improvement ≥ 15%, REVERT if ≤ -15%, else INCONCLUSIVE (revert)

9. **On KEEP:** Persist override permanently in `keptOverrides`, log as lesson
10. **On REVERT:** Remove override, set cooldown (5 closes before next experiment)

**Changes to existing files:**
- `prompt.js`: Add `getPromptSection(name)` and `applyOverride(name, text)` functions. `buildSystemPrompt()` checks for active overrides before using default text.
- `lessons.js` `recordPerformance()`: Add hook at end to call `autoresearch.onPositionClosed(perfEntry)`.
- `config.js`: Add `autoresearch` section: `{ enabled: false, minClosesPerTrial: 7, minPositionsToStart: 15 }`. **Disabled by default** — opt-in feature.

**Section boundaries in prompt.js:**
- `screener_criteria` — the hard rules + risk signals block in SCREENER prompt
- `manager_logic` — the behavioral core + management rules in MANAGER prompt
- `range_selection` — bins_below formula + range guidance in SCREENER prompt

---

## Phase 5: Nuggets Holographic Memory

**Why:** The OG lessons.json + pool-memory.json are flat stores with no confidence scoring, no associative recall, and no cross-session fact promotion. Nuggets uses Holographic Reduced Representations (HRR) — facts are encoded as 16384-dim complex vectors, superposed in memory banks, and recalled with continuous confidence scores. The agent knows *how certain* a memory is, enabling confidence-weighted decisions.

### Architecture Overview

**4 core files (packages/nuggets/)** — zero external dependencies, pure Float64Array math:

| File | Purpose | Lines |
|------|---------|-------|
| `core.js` | HRR math: complex bind/unbind, seeded PRNG (Mulberry32), vocab key generation, Gram-Schmidt orthogonalization, magnitude sharpening, softmax | ~300 |
| `memory.js` | Nugget class: stores key-value facts across 4 memory banks, recall via cosine similarity + softmax confidence | ~400 |
| `shelf.js` | NuggetShelf: multi-nugget manager, cross-nugget broadcast recall, file I/O | ~200 |
| `promote.js` | Auto-promotion: facts recalled 3+ times across sessions get promoted to permanent context | ~100 |

**Integration wrapper: `memory.js`** (~250 lines) — bridges nuggets into the agent loop

### Data Model

A **nugget** = a named category (e.g. "pools", "strategies") with:
- `facts[]` — array of `{ key: string, value: string, hits: number, last_hit_session: number }`
- `maxFacts` — capacity cap (FIFO eviction when exceeded)
- 4 internal memory banks (vectors rebuilt deterministically from facts, never serialized)

**Default categories on init:**

| Category | Max Facts | Purpose |
|----------|-----------|---------|
| `pools` | 150 | Pool performance observations, fee/TVL trends, volatility buckets |
| `strategies` | 80 | Strategy + binStep combos that worked/failed |
| `lessons` | 100 | Cross-session lessons (replaces/supplements lessons.json) |
| `patterns` | 80 | Recurring patterns the LLM discovers (e.g. "meme tokens with <500 holders always rug") |

LLM can create additional custom categories via the `remember_fact` tool.

### How It Works

**Storage:** `*.nugget.json` files in a `nuggets/` directory. Each file stores the fact list only — vectors are rebuilt on load from the seeded PRNG (deterministic reconstruction, no vector serialization needed). This keeps files small.

**Write path (3 channels):**
1. **Automatic** — `rememberPositionSnapshot()` fires every management cycle, stores pool status, fee/TVL trends, volatility, strategy+binStep combos
2. **LLM-initiated** — `remember_fact` tool: `{ category, key, value }`
3. **Lesson bridge** — when lessons.js derives a lesson, also store as a nugget in the `lessons` category

**Recall path (3 channels):**
1. **Contextual recall** — per-position/candidate recall injected into cycle goals (e.g. "What do I remember about pool X?")
2. **Global prompt injection** — `getMemoryContext()` returns top-confidence facts, injected into every system prompt under `## HOLOGRAPHIC MEMORY` header
3. **LLM-initiated** — `recall_memory` tool: `{ query }` → returns matching facts with confidence scores

**Promotion system:**
- Every recall increments `fact.hits`
- Facts recalled 3+ times across sessions are auto-promoted to permanent context
- Low-hit facts decay naturally via FIFO eviction when capacity is reached

**Holographic properties:**
- Information is distributed across the entire 16384-dim vector (not discrete locations)
- Multiple facts coexist via superposition (vector addition)
- Recall produces continuous confidence scores (0.0–1.0), not binary hit/miss
- Graceful degradation: accuracy decreases smoothly as capacity fills (no cliff)
- Fuzzy key matching (SequenceMatcher, threshold 0.55) resolves approximate queries

### LLM Tools (3 new tool definitions)

```
remember_fact:
  params: { category: string, key: string, value: string }
  description: "Store a fact in holographic memory for cross-session recall"

recall_memory:
  params: { query: string, category?: string }
  returns: [{ key, value, confidence, category }]
  description: "Recall facts from memory. Returns matches with confidence scores."

forget_fact:
  params: { category: string, key: string }
  description: "Remove a specific fact from memory"
```

### Changes to Existing Files

- **`prompt.js`**: Add `## HOLOGRAPHIC MEMORY` section to `buildSystemPrompt()` via `getMemoryContext()`. When nuggets have content for SCREENER role, optionally suppress flat lessons (`nuggetsFirst` flag) to avoid redundancy.
- **`agent.js`**: Add `remember_fact`, `recall_memory`, `forget_fact` to all role tool sets (MANAGER_TOOLS, SCREENER_TOOLS, GENERAL intents). Memory tools are read/write but non-destructive — safe for all roles.
- **`tools/definitions.js`**: Add 3 tool schemas.
- **`tools/executor.js`**: Add 3 tool implementations to `toolMap`. Wire to `memory.js` wrapper functions.
- **`index.js`**: Initialize nuggets shelf on startup. Call `rememberPositionSnapshot()` at end of each management cycle. Pass memory context to agent loop.
- **`lessons.js`**: In `derivLesson()`, also write the derived lesson as a nugget in the `lessons` category (bridge between old and new systems).
- **`config.js`**: Add `nuggets` section: `{ enabled: false, nuggetsFirst: true, maxRecallResults: 5, promotionThreshold: 3 }`. **Disabled by default** — opt-in feature.
- **`package.json`**: No new external deps (nuggets is pure math). Add `"nuggets": "file:packages/nuggets"` as local package.

### Relationship to Existing Systems

| Existing System | What Changes | Coexistence |
|----------------|-------------|-------------|
| `lessons.json` | Still works as-is | Nuggets `lessons` category mirrors derived lessons. When `nuggetsFirst: true`, SCREENER prompt uses nuggets recall instead of flat lessons. MANAGER/GENERAL still get flat lessons. |
| `pool-memory.json` | Still works as-is | Nuggets `pools` category adds associative recall on top. Pool memory keeps its snapshot/cooldown role. |
| `strategy-library.json` | Unchanged | Nuggets `strategies` category tracks what worked, not strategy definitions. |

The nuggets system **supplements** rather than replaces existing storage. Both systems run in parallel. The `nuggetsFirst` flag controls which takes priority in prompts for the SCREENER role.

---

## Implementation Order

1. **Notifier** (foundation) — needed by PnL watcher + dashboard
2. **PnL Watcher** — highest immediate value, instant exits
3. **Nuggets Memory** — enhances agent intelligence, needed before autoresearch (autoresearch can use nuggets for experiment context)
4. **Web Dashboard backend** — server.js + API routes + nuggets insight endpoint
5. **Web Dashboard frontend** — minimal React SPA with Intel tab showing nuggets
6. **Autoresearch** — most complex, disabled by default, can log experiments as nuggets

Each phase is independently testable and deployable.

---

## Verification

1. **Notifier:** Run `npm run dev`, confirm Telegram still receives all notifications as before
2. **PnL Watcher:** Run `npm run dev` with DRY_RUN, verify poller logs exit detections, verify no double management cycles
3. **Nuggets Memory:** Run `npm run dev`, verify `nuggets/*.nugget.json` files are created after management cycles. Test via REPL: "remember that BONK pools with >80% organic score performed well" → verify stored. "What do I know about BONK?" → verify recall with confidence score.
4. **Dashboard:** Run `npm start`, open `http://localhost:3737`, verify positions display, events stream, Intel tab shows nuggets
5. **Autoresearch:** Deploy a few test positions, close them, verify experiment lifecycle in `autoresearch.json`

---

## Files Modified
- `notifier.js` (NEW)
- `pnl-watcher.js` (NEW)
- `server.js` (NEW)
- `autoresearch.js` (NEW)
- `memory.js` (NEW — nuggets integration wrapper)
- `packages/nuggets/` (NEW — core HRR library: core.js, memory.js, shelf.js, promote.js)
- `web/` (NEW directory)
- `index.js` — startup integration, extract PnL poll, expose timer state, nuggets init + per-cycle snapshots
- `tools/executor.js` — emit events instead of direct Telegram calls, add memory tool dispatch
- `tools/definitions.js` — add 3 memory tool schemas
- `telegram.js` — subscribe to notifier
- `agent.js` — add memory tools to role sets
- `prompt.js` — section accessors + override system + holographic memory injection
- `lessons.js` — autoresearch hook + nugget bridge in derivLesson
- `config.js` — autoresearch + nuggets + dashboard config sections
- `state.js` — recentAutoCloses array
- `package.json` — add express, ws, local nuggets package
- `.env.example` — add DASHBOARD_TOKEN, DASHBOARD_PORT
