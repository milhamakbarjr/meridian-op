# Overnight build prompt — `meridian-ui` dashboard (all phases)

## How to run this

Open a fresh Claude session in `/Volumes/Data 2/projects/meridian-ui`. Copy the **`/goal` block** below (between `===GOAL START===` and `===GOAL END===`). It's under 4000 chars and points the agent at the full brief on disk (`../meridian-op/NEXT_SESSION_PROMPT.md`, the rest of this file).

```
===GOAL START===
Autonomously build the Meridian Dashboard (TanStack Start + Tailwind v4 + shadcn/ui base-vega/mist + Bun) overnight, executing Phases 0 → 3 end-to-end without stopping for clarification.

OPERATING BRIEF: Read `../meridian-op/NEXT_SESSION_PROMPT.md` IN FULL right now. That file is the ground-truth manual for this run — phase boundaries, exit criteria, panel catalog refs, anti-patterns, react-doctor checklist, PR plan, PRD §15 defaults. Then read, in order: `./CLAUDE.md`, `../meridian-op/CLAUDE.md`, `../meridian-op/PRD.md`, `../meridian-op/API_SERVER_SPEC.md`. Treat PRD.md as ground truth for what to build.

EXECUTION RULES (non-negotiable):
1. Run phases in order: 0 scaffold → 1 MVP → 2 polish → 3 power. One git branch per phase: `dashboard/phase-{0-scaffold,1-mvp,2-polish,3-power}`. Commit per panel.
2. Build against mocked API responses behind `VITE_USE_MOCK=true` (default true). Fixture shapes must match `API_SERVER_SPEC.md`. Copy realistic data from `../meridian-op/{state,pool-memory,decision-log,lessons}.json`.
3. No Solana code, no secrets in the browser, no light mode unless Phase 3 finishes ≥30 min early.
4. Apply every cross-phase constraint from the brief: tabular-nums everywhere, 1Hz P&L debounce, staleness indicators on every panel, UUIDv4 `X-Idempotency-Key` on every mutation, snapshot+stream pattern with WS gap detection and 5s polling fallback after 30s WS downtime, every red/green paired with sign + glyph.
5. Use PRD §15 recommendations as defaults — do NOT stop to ask. Note each decision in the eventual PR body.
6. Use TaskCreate aggressively (one task per panel). Use `general-purpose` subagents in parallel for independent panel implementations; reserve main loop for orchestration.

PHASE-END CHECKLIST (run after EACH phase, in this order):
a. `bun typecheck` — fix every error.
b. `bun lint` — fix every error.
c. `bun test` if tests exist — fix every failure.
d. Spawn a subagent (slash command `react-doctor` if available, else `general-purpose` with the audit prompt in the brief) to audit hooks rules, deps arrays, a11y, key warnings, WS leaks, query-cache collisions, tabular-num compliance, all 12 PRD §12 anti-patterns. Apply every fix.
e. Re-run typecheck + lint clean. Commit. Then next phase.

FINAL STEP (after Phase 3 + final react-doctor):
Open 4 stacked PRs — one per phase, in order — targeting the previous branch (or `main` for PR #1). Each PR body must include: summary mapped to PRD sections, PRD §1 success-criteria checklist, PRD §12 anti-pattern absence checklist (Phase 1+), list of PRD §15 decisions, panels skipped + why, react-doctor summary (findings/fixes/deferred), operator test plan. DO NOT MERGE. DO NOT PUSH TO `main`. Stop after creating the PRs.

OUTPUT AT END: list of PR URLs, PRD §15 decisions, any open blockers.

You will not be interrupted overnight. Optimize for shipping all four phases with clean PRs by morning over getting any single phase perfect. If genuinely stuck on something not covered by PRD or the brief, make the call most consistent with the operator-console spirit (trust + explainability + control + forensics), note it in the PR body, keep going.

START NOW by reading the operating brief.
===GOAL END===
```

---

# Operating brief (the agent reads this from disk)

> Everything below is the full manual the `/goal` prompt above instructs the agent to read. Keep this file at `/Volumes/Data 2/projects/meridian-op/NEXT_SESSION_PROMPT.md` so the relative path `../meridian-op/NEXT_SESSION_PROMPT.md` resolves from `meridian-ui/`.

---

## Mission

Build the **Meridian Dashboard** — a localhost operator console for the Meridian DLMM LP bot. Stack and panel catalog are fully specified. The bot lives in `/Volumes/Data 2/projects/meridian-op` (sibling folder); this repo (`meridian-ui`) currently has only `CLAUDE.md`.

Run autonomously through **Phase 0 → Phase 1 → Phase 2 → Phase 3**. At the end of each phase, run `react-doctor` (subagent), fix every reported issue, then proceed. After Phase 3, open one PR per phase against `main`.

You are operating overnight. Do not wait for human input. Make the recommended call from PRD §15 on every open question and note it in the eventual PR description.

## Required reading before you start (in order)

1. **`./CLAUDE.md`** — declared stack: TanStack Start + TanStack Router + Tailwind v4 + shadcn/ui `base-vega`/`mist` + Bun. Non-negotiable.
2. **`../meridian-op/CLAUDE.md`** — bot engineering manual. Focus on: persistent JSON files (`state.json`, `pool-memory.json`, `lessons.json`, `decision-log.json`), the 5 deterministic close rules (`index.js#getDeterministicCloseRule`), trailing-TP two-phase confirmation, SCREENER/MANAGER/GENERAL roles, cron cycle structure.
3. **`../meridian-op/PRD.md`** — **ground truth** for the dashboard. Panel catalog (§5), per-screen layouts (§6), visual conventions (§7), control-action tiers (§10), anti-patterns (§12), phased plan (§13), open questions with recommended defaults (§15).
4. **`../meridian-op/API_SERVER_SPEC.md`** — REST endpoints, WS event taxonomy, confirmation tokens, idempotency keys.

Skim — don't deep-read — the bot's source unless you hit a specific gap. The PRD already extracts what you need.

## Stack & libraries

From `meridian-ui/CLAUDE.md`:
- **TanStack Start** (React SSR), **TanStack Router** (file-based, `src/routes/`).
- **Tailwind v4**, **shadcn/ui** (`base-vega` / `mist` / `lucide`).
- **DM Sans Variable + Geist Variable** via `@fontsource-variable`.
- `@base-ui/react` headless primitives.
- **Bun** for all package + dev commands. `bun dev` (port 3000), `bun build`, `bun test`, `bun lint`, `bun typecheck`, `bun format`.

Add (PRD §8):
- `@tanstack/react-query` (verify if bundled by TanStack Start).
- `lightweight-charts` (equity curve, drawdown, bin distribution).
- `recharts` (sparklines, bars, attribution stacks).
- `zod` (response validation).
- `zustand` (ephemeral UI state).
- `date-fns` (time/duration formatting).

## Critical constraints (apply to every phase)

1. **Bot-side API doesn't exist yet.** Build against **mocked responses** behind `VITE_USE_MOCK=true` (default true). Copy small slices of realistic shapes from `../meridian-op/state.json`, `../meridian-op/pool-memory.json`, `../meridian-op/decision-log.json`, `../meridian-op/lessons.json` for fixtures. The shape MUST match `API_SERVER_SPEC.md` — when the real server lands the flag flips and everything works.
2. **No Solana code in the dashboard.** All chain interaction is the bot's job. Dashboard reads via `GET /api/v1/*`, writes via `POST /api/v1/control/*`.
3. **No secrets in the browser.** Wallet private key, API keys, mnemonic must never appear. The bot's `/api/v1/config` redacts on its side.
4. **Debounce P&L cell updates to ≤1Hz** with CSS transitions. Anti-pattern PRD §12.2.
5. **Every mutation = UUIDv4 in `X-Idempotency-Key`** header. One per user action, not per retry.
6. **`font-variant-numeric: tabular-nums`** on every number in tables and KPI cards.
7. **Snapshot + stream pattern.** TanStack Query for snapshot on mount; WebSocket events patch the cache via `queryClient.setQueryData`. Sequence-gap detection invalidates the query. Polling fallback at 5s after 30s of WS downtime, with a visible "Polling fallback" badge.
8. **Every panel shows "Last updated Ns ago"**, amber at 2× expected interval, red at 5× (anti-pattern PRD §12.1).
9. **All 12 anti-patterns in PRD §12 must be absent** at Phase 1 exit and verified again at Phase 2 exit.

## Working style for overnight execution

- **Use TaskCreate aggressively.** Each panel = a task. Mark complete as soon as it works against mocked data. There are 15+ panels.
- **Commit per panel.** Branch per phase: `dashboard/phase-0-scaffold`, `dashboard/phase-1-mvp`, `dashboard/phase-2-polish`, `dashboard/phase-3-power`.
- **Don't stop to ask.** PRD §15 lists open questions and the recommended answer for each. Take the recommendation, note it in the eventual PR body.
- **Prefer composition over abstraction.** No `BasePanel` generic until you've built three panels and seen the shape repeat.
- **No premature features.** Build only what's in the phase's exit criteria. Skip anything labeled "low priority" or "if time."
- **No background dev server** while writing code. Only spin it up briefly for smoke checks; close before next phase.
- **Use sub-agents for fan-out work**: when a phase has independent panels, use the `general-purpose` agent in parallel for routine panel implementations. Reserve main loop for orchestration, architectural decisions, and integration.

---

## Phase 0 — Scaffold

**Branch:** `dashboard/phase-0-scaffold`

1. Scaffold TanStack Start: `bunx create-tanstack@latest .` — accept Tailwind + Router. Verify React Query is included; if not, `bun add @tanstack/react-query`.
2. `npx shadcn@latest init` — style `base-vega`, base color `mist`, icon library `lucide`.
3. Install: `bun add lightweight-charts recharts zod zustand date-fns`. Add `clsx` + `tailwind-merge` if not already provided.
4. Set up the design tokens from PRD §7 in `src/styles.css`. Include `:root` palette, dark-mode default, `tabular-nums` utility, motion vars, CVD-safe overrides scaffolded but not wired.
5. **`src/lib/api.ts`** — thin fetch wrapper hitting `http://127.0.0.1:7474/api/v1/*`. Zod-validate every response. TanStack Query hooks in `src/lib/queries.ts` per endpoint. Honor `VITE_USE_MOCK=true` to return fixtures from `src/lib/fixtures/`.
6. **`src/lib/ws.ts`** — WebSocket client to `ws://127.0.0.1:7474/ws`. Reconnect with exp backoff (1s → 30s cap). Per-channel `seq` tracking + gap detection per `API_SERVER_SPEC.md` §6. `useWsEvents(channels[])` React hook that mutates query cache on events.
7. **`src/lib/fixtures/`** — realistic mock data for every endpoint listed in `API_SERVER_SPEC.md`. Pull shape/values from the bot's JSON files.
8. **`src/components/layout/`** — `StatusStrip.tsx`, `LeftNav.tsx`, `ReplDrawer.tsx` (empty drawer for now), `__root.tsx` shell.
9. **Empty routes** for every section in PRD §4: `overview`, `positions/{index,$address}`, `pools/{index,$address}`, `decisions/{index,$id}`, `candidates`, `lessons`, `llm`, `health`, `config`, `audit`, `alerts`. Each route renders a `<PlaceholderCard name="…" />`.
10. **`src/components/common/`** — stub the shared primitives that Phase 1 will need: `KpiCard.tsx`, `Sparkline.tsx`, `PnlBadge.tsx`, `ConfirmModal.tsx` (Tier-1 + Tier-2 variants), `StalenessIndicator.tsx`, `ActorPill.tsx`.

**Phase 0 exit criteria:**
- `bun dev` renders the shell with left nav and empty status strip.
- Navigating to every route works and shows the placeholder card.
- `bun typecheck` clean. `bun lint` clean.
- WS client opens against the mock URL without crashing (skip on failure when in mock mode).

**Before Phase 1:** run `react-doctor` (see "Phase-end checklist" below) on the whole repo. Fix everything it flags. Commit. Then continue.

---

## Phase 1 — MVP

**Branch:** `dashboard/phase-1-mvp`. Branch off `dashboard/phase-0-scaffold` after merging it to a working state locally (no remote push yet).

Ship enough that the operator stops checking Telegram for desk-bound use. From PRD §5 + §13:

1. **Live Status Strip** (PRD §5.1) — WS-driven. Pills, heartbeat, cycle clock, wallet, positions, 24h badge, `[PAUSE]` / `[KILL]` / `[READ-ONLY]` controls (KILL and READ-ONLY behind Tier-2; non-functional in Phase 1 is fine, but UI present).
2. **Overview page** (PRD §6.1 layout):
   - Equity Curve (PRD §5.2) — `lightweight-charts`, 24h/7d/30d/all toggle.
   - Drawdown / Underwater (PRD §5.3) — `lightweight-charts` area, same X axis.
   - Open Positions Table (PRD §5.4) — full columns; sortable; row state colors; 1Hz debounced PnL cells; sparkline per row.
   - Decision Log compact (PRD §5.6) — last 10 entries, expand inline.
3. **Positions page** (`/positions`) — tabs `Open (n)` / `History (m)`. Full table on Open. History sortable by close_reason, PnL, hold time, with filter.
4. **Position detail** (`/positions/$address`) — header KPIs (Value / Unclaimed / Fee-to-IL / TIR%), bin-distribution placeholder, Ticks tab only (other tabs Phase 2).
5. **Decisions page** (`/decisions`) — full feed + inline expand (rejected[] candidates shown collapsed — anti-pattern PRD §12.12).
6. **Pools page** (`/pools`) — table only (5.7). Pool detail page is Phase 2.
7. **Health page** (`/health`) — cron heartbeats grid + RPC latency p50/p99 + `_busy` flag states. Subset of PRD §5.9; full LLM/HiveMind metrics in Phase 2.
8. **Config page** (`/config`) — read-only key list with current/default/type/section. Edit is Phase 2.
9. **Mutations** — Pause / Resume / Close-one / Claim. All with Tier-1 confirmation modal per PRD §10. Idempotency key per action. Optimistic UI per PRD §9.

**Apply throughout Phase 1:**
- Staleness indicator on every panel.
- Tabular numerals everywhere.
- 1Hz P&L debounce.
- Every red/green pairs with sign (`+`/`−`) and glyph (`▲`/`▼`).

**Phase 1 exit criteria:**
- All five "≤10s glance" answers in PRD §1 are visible without leaving Overview.
- All five "≤2-click" actions work end-to-end against the mock.
- All 12 anti-patterns in PRD §12 verified absent (run through the list; document in commit message).
- `bun typecheck` + `bun lint` clean.

**Before Phase 2:** run `react-doctor`. Fix everything. Commit.

---

## Phase 2 — Polish + power user

**Branch:** `dashboard/phase-2-polish`. Branches from Phase 1.

1. **P&L Attribution panel** (PRD §5.5) — `recharts` stacked bar, aggregate (24h/7d/30d) + per-position toggle.
2. **Per-Pool Performance table** (PRD §5.7) + **Pool detail page** (PRD §6.5) — snapshot trend chart on detail page using `lightweight-charts`.
3. **LLM Activity panel** (PRD §5.8) — tokens-in/out per cycle, $ spend time series, per-role split, per-tool latency, fallback-model trigger count. Derive from `actions-YYYY-MM-DD.jsonl` shape exposed via `/api/v1/logs/actions`.
4. **Lessons & Self-Tuning panel** (PRD §5.11) — grouped by PINNED / ROLE / RECENT, `[Pin]` / `[Delete]`, `[AUTO-EVOLVED]` highlight, signal weights summary.
5. **Config edit + Audit tab** (PRD §5.12) — type-correct widgets (number stepper / toggle / select / multiselect / text), typed reason, Tier-2 confirmation on safety-relevant keys (`maxDeployAmount`, `stopLossPct`, `maxPositions`, anything `LLM_*`). Revert button until next page load. Audit tab shows every `update_config` with actor + before/after diff + reason. Filterable by actor + key.
6. **Audit page** (`/audit`) — unfiltered view of all mutations.
7. **Alerts inbox** (PRD §5.13) — `Active` / `Acknowledged` / `Silenced` tabs. `[Ack]` / `[Silence 1h]` / `[Silence 24h]`. WS-driven from `alert.fired` / `alert.acked`. Nav badge unacked count.
8. **Bin distribution chart** on position detail (PRD §6.3) using `lightweight-charts`. Active-bin marker, range overlay, price line.
9. **CVD-safe theme toggle** — swap positive→`#0EA5E9`, negative→`#F97316`. Persist in `localStorage`.
10. **Read-only mode toggle** — when on, disables every mutation button with a tooltip. Persist in `localStorage`.
11. **Optimistic UI for mutations** — PRD §9 pattern: "Closing…" overlay → `tx.submitted` → `tx.confirmed` / `tx.failed` rollback toast.
12. **Idempotency key generation** — already added in Phase 1; verify it's on every mutation and confirm dedup behavior with the mock.

**Phase 2 exit criteria:**
- All "≤4-click" success criteria in PRD §1 pass.
- All 12 anti-patterns verified absent (re-check list).
- `bun typecheck` + `bun lint` clean.

**Before Phase 3:** run `react-doctor`. Fix everything. Commit.

---

## Phase 3 — REPL + Candidates + extras

**Branch:** `dashboard/phase-3-power`. Branches from Phase 2.

1. **REPL drawer** (PRD §5.14, §6.14) — right-edge slide-out. Markdown rendering. Streaming via WS `repl_message` events. `POST /api/v1/repl` to send. `agent_type` selector (GENERAL default / SCREENER / MANAGER). Persist conversation in `localStorage` per session. `⌘K` shortcut to open.
2. **Candidates live view** (PRD §5.10, §6.7) — top-N from `getTopCandidates`. Per-row pass/reject reasons, smart wallets list, indicator preset confirmation, one-click `[Deploy]` with **Tier-2 typed confirmation** (typed string `DEPLOY <pair>`). `[Run Screening Cycle]` button kicks `POST /api/v1/screening/run` and streams progress.
3. **Wallet panel on Overview** (PRD §5.15) — SOL balance + 24h delta, top-5 tokens by USD, `autoSwapAfterClaim` toggle.
4. **Sparklines on every KPI** — status strip + KPI cards.
5. **Keyboard shortcuts** — `⌘K` (REPL), `/` (search), `P` (pause confirm).
6. **Light mode** — only if Phase 3 completes ≥30 min before time runs out. Otherwise skip.

**Phase 3 exit criteria:**
- REPL streams tool calls in real time against the mock.
- Candidates deploy flow runs end-to-end with Tier-2 confirmation.
- All keyboard shortcuts work from any route.
- `bun typecheck` + `bun lint` clean.

**Before commit/PR:** run `react-doctor` one last time. Fix everything.

---

## Phase-end checklist (run after each phase)

At the **end of every phase**, in order:

1. `bun typecheck` — fix every error.
2. `bun lint` — fix every error.
3. `bun test` (if any tests exist) — fix every failure.
4. **Spawn a subagent with the `react-doctor` slash command**, or if unavailable, spawn a `general-purpose` subagent with this prompt:
   > "Audit the `meridian-ui` repo as a React + TanStack Start codebase. Check for: hooks-rules violations, missing dependency arrays, unmounted-state writes, key warnings, accessibility issues (a11y), uncontrolled→controlled toggles, dangerous innerHTML, missing error boundaries, query-cache key collisions, WS resource leaks, tabular-numeral compliance per PRD §7, anti-pattern violations from PRD §12. Report each finding with file:line and a recommended fix. Return as a structured list."
5. **Apply every fix the subagent recommends** unless it conflicts with the PRD (note conflict in commit message).
6. Re-run `bun typecheck` + `bun lint`.
7. Commit. Move to next phase.

---

## Final step — commits, PRs, summary

After Phase 3 + final react-doctor pass:

1. **Decide commit/PR structure.** Default plan:
   - **PR #1**: `dashboard/phase-0-scaffold` → `main` — "Scaffold meridian-ui dashboard (Phase 0)"
   - **PR #2**: `dashboard/phase-1-mvp` → `main` (or stacked on PR #1) — "Phase 1: MVP — Overview, Positions, Decisions, Pools, Health, Config (read-only), pause/close/claim"
   - **PR #3**: `dashboard/phase-2-polish` → `main` (stacked on PR #2) — "Phase 2: Attribution, Pools detail, LLM, Lessons, Config edit + Audit, Alerts, Bin distribution, optimistic UI, CVD theme"
   - **PR #4**: `dashboard/phase-3-power` → `main` (stacked on PR #3) — "Phase 3: REPL, Candidates live deploy, Wallet panel, shortcuts"
   - If GitHub stacked-PR tooling is unavailable, target each PR at the previous branch instead of `main` so review proceeds in order.
2. **Each PR body must include:**
   - Summary of what changed (mapped to PRD sections).
   - Checklist of PRD §1 success criteria covered in this phase.
   - For Phase 1+: checklist confirming each of PRD §12's 12 anti-patterns is absent.
   - List of decisions you made for PRD §15 open questions (use the §15 recommendations as defaults).
   - List of any panels skipped + why (e.g. light mode skipped due to time).
   - `react-doctor` summary: total findings, fixes applied, anything deliberately left.
   - Test plan checklist for the operator to run locally.
3. **Do not push to `main`** or merge any PR. Stop after creating the PRs.
4. **Post a final summary** in the session output: list of PR URLs, list of PRD §15 decisions, list of any open blockers.

## Out of scope (do not build)

- Mobile responsive design beyond "doesn't break at narrow widths."
- Light mode unless Phase 3 finishes ≥30 min early.
- Multi-bot / multi-tenant.
- Public/cloud deployment.
- Arbitrary on-chain calls from the dashboard.
- LLM provider management UI (model swap is config-only).
- Discord-listener controls.
- Replacing `cli.js`.

## Defaults for PRD §15 open questions (apply these — do not stop to ask)

1. **PnL tick cadence**: push every tick from server, debounce client-side to 1Hz on visible cells.
2. **REPL streaming**: same WS as everything else, multiplexed by `repl_session_id`.
3. **`pool-memory.json` snapshot rendering**: chart on pool detail page; table only when expanded.
4. **Equity curve granularity**: per-close events for the line, daily aggregates as histogram overlay.
5. **Kill switch**: `POST /control/pause` + close-all. True process termination is the operator's job (Ctrl-C). UI says so on the modal.

---

## If you get genuinely stuck

If something blocks progress and isn't covered by PRD or this prompt:
- Make the choice consistent with the PRD's spirit (operator console; trust + explainability + control + forensics).
- Note the choice in the relevant PR body.
- Keep going.

You will not be interrupted overnight. Optimize for shipping all four phases with clean PRs by morning over getting any single phase "perfect."
