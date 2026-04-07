# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Commands

```bash
npm start                   # Run agent (autonomous mode)
npm run dev                 # Run with DRY_RUN=true (no on-chain transactions)
npm run test:screen         # Test pool discovery API (no wallet required)
npm run test:agent          # Test ReAct agent loop (DRY_RUN=true)
npm run setup               # Interactive setup wizard (.env + user-config.json)
```

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees) — 44 tools total
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
  okx.js            OKX DEX smart money signals

cli.js              Direct CLI — every tool as subcommand with JSON output (no LLM)
signal-tracker.js   Discord signal tracking
signal-weights.js   Signal weight calculations
dev-blocklist.js    Development blocklist utilities

discord-listener/   Separate selfbot process for Discord signal ingestion
.claude/
  agents/           Sub-agents: screener.md, manager.md
  commands/         Slash commands: /screen, /manage, /balance, /positions,
                    /candidates, /study-pool, /pool-ohlcv, /pool-compare
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | Intent-based subset (14 patterns) — not all tools |

Sets defined in `agent.js:6-7`. GENERAL role uses intent matching to pick a relevant tool subset per goal (e.g. "close" goals get close/claim tools, "deploy" goals get screener tools). If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| maxBotHoldersPct | screening | — |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| stopLossPct | management | — |
| takeProfitFeePct | management | — |
| minFeePerTvl24h | management | — |
| trailingTakeProfit | management | false |
| trailingTriggerPct / trailingDropPct | management | — |
| solMode | management | false |
| strategy | strategy | "bid_ask" |
| binsBelow | strategy | — |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → deterministic rule checks → LLM only if action required → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

**Management cycle deterministic checks** (index.js `runManagementCycle()`):
- Stop loss: PnL below `stopLossPct` → CLOSE
- Take profit: fee income above `takeProfitFeePct` → CLOSE
- Trailing take profit: peak-then-drop pattern → CLOSE
- Out of range: OOR longer than `outOfRangeWaitMinutes` → CLOSE
- Low yield: fee/TVL below `minFeePerTvl24h` → CLOSE or CLAIM
- LLM is only invoked when an action is warranted; it receives the actionMap with pre-computed signals

---

## Screener Safety Checks (executor.js + index.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- If `amount_x > 0`: strip `amount_y` and `amount_sol` (tokenX-only deploy — no SOL needed)
- SOL balance must cover `amount_y + gasReserve` (skipped for tokenX-only)

**Hard filters in `runScreeningCycle()` before LLM sees candidates:**
- `blockedLaunchpads` — drops matching launchpad tokens
- `maxBotHoldersPct` — drops tokens where Jupiter `bot_holders_pct` exceeds threshold (new)

---

## bins_below Calculation (SCREENER)

Linear formula based on pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(35 + (volatility / 5) * 34), clamped to [35, 69]
```

- Low volatility (0) → 35 bins
- High volatility (5+) → 69 bins
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Tool Safety Model (executor.js + agent.js)

Two special tool categories prevent destructive double-execution:
- **`NO_RETRY_TOOLS`** (`deploy_position`): locked after first attempt regardless of outcome — prevents double-deploy on retry
- **`ONCE_PER_SESSION`** (`deploy_position`, `swap_token`, `close_position`): locked after first success — prevents repeat destructive actions within one agent session

These locks are in-memory per `agentLoop()` call; they reset between cron invocations.

**Hallucination guard** (`requireTool` option in `agentLoop`): All REPL and Telegram free-form inputs now pass `{ requireTool: true }`. When the goal matches `TOOL_REQUIRED_INTENTS` (a broad regex covering deploy/close/screen/study/etc.), the loop:
1. Forces `tool_choice: "required"` on step 0
2. Rejects any final answer where no tool was called (up to 2 retries with a system nudge)
3. Returns a failure message if the LLM still won't call a tool after 2 attempts

MANAGER cron cycles are exempt (they use pre-computed actionMaps, not free-form goals).

---

## closePosition() Return Shape (dlmm.js)

`close_position` now returns `claim_txs` and `close_txs` as separate arrays (in addition to `txs` which combines both):
```js
{ success, position, pool, pool_name, claim_txs: [...], close_txs: [...], txs: [...], pnl_usd, pnl_pct, base_mint }
```

**Post-close verification**: after sending close transactions, the function polls `getMyPositions()` up to 4 times (3s apart) to confirm the position is gone. Returns `success: false` if the position is still visible after the verification window.

**Bin range**: close now uses the actual `lowerBinId`/`upperBinId` from position data rather than hardcoded ±887272.

**Empty positions**: uses `pool.closePosition()` (not `closePositionIfEmpty()`).

---

## Position Fields — True USD vs. solMode Fields (dlmm.js)

Positions returned by `getMyPositions()` now include always-USD shadow fields alongside the `solMode`-aware display fields:

| Field | Meaning |
|-------|---------|
| `total_value_usd` | Display value — SOL or USD depending on `solMode` |
| `total_value_true_usd` | Always USD — used for lesson recording |
| `collected_fees_usd` | Display value |
| `collected_fees_true_usd` | Always USD |
| `pnl_usd` | Display value |
| `pnl_true_usd` | Always USD |
| `unclaimed_fees_true_usd` | Always USD |

When `closePosition()` falls back to cache for PnL, it uses the `*_true_usd` fields to prevent SOL/USD unit mixing in lesson records.

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **Unit-mix guard**: `recordPerformance()` skips records where `final_value_usd` looks like a SOL value (i.e. `≤ amount_sol × 2` when both are present) — prevents corrupted performance history from SOL/USD confusion
- `evolveThresholds()` evolves `maxVolatility`, `minFeeActiveTvlRatio`, and `minOrganic` — all keys match config.js
- Lesson derivation thresholds: good >= 2%, bad < -2% (tuned for typical meme-token LP returns)

---

## Hive Mind (hive-mind.js)

Optional feature. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`.
Syncs lessons/deploys to a shared server, queries consensus patterns.
Not required for normal operation.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |
| `LPAGENT_API_KEY` | No | LPAgent live PnL/value/fees for open positions (falls back to Meteora if unset) |

---

## Smart Wallet Strategy

Smart wallets (`smart-wallets.json`) are alpha LP wallets whose pool presence boosts screening confidence via `check_smart_wallets_on_pool`.

### Data Sources

| Source | For LP wallets? | Notes |
|--------|----------------|-------|
| **LPAgent** | **Best — use this** | LP win rate, ROI, hold time, PnL per position. Purpose-built for Meteora DLMM |
| **OKX** | Indirect only | `smartMoneyBuy` token tag + cluster KOL flag — signals smart money on a *token*, not wallet LP history |
| **GMGN.AI** | Wrong tool | Token trader analytics, not LP tracking |
| **Jupiter** | Wrong tool | Token metadata only |

### How to Find New Smart Wallets

**Best method — mine from top pools:**
Run `/study-pool <pool_address>` on your best-performing pools. LPAgent's `top-lpers` endpoint filters for wallets with ≥15 positions, ≥65% win rate, ≥$1k inflow — that's where real alpha wallets surface.

**Evaluating a wallet manually** (LPAgent historical endpoint):
```
GET /open-api/v1/lp-positions/historical?owner=<address>&page=1&limit=50
```
Key signals to look for:
- Win rate ≥ 65% (on ≥10 closed positions)
- Positive net PnL (not just high fees masking losses)
- Diversified pairs — single-token wallets are unreliable signals
- Avg hold ≤ 4h = scalper; ≥ 4h = holder. Both are valid but scalpers give faster entry signals.

**Red flags:**
- Concentrated in 1-2 tokens (could be insider, not generalist alpha)
- High fees but negative PnL (fee farming, not profitable LP)
- Fewer than 10 positions (sample too small)
- Win rate ≥ 70% but PnL near zero (winning small, losing big)

### Wallet Grades (2026-04-03 research)

| Wallet | WR | PnL | Hold | Status |
|--------|----|-----|------|--------|
| `FMukQuz3...` | 90% | +$138 | 1.2h | **Active — best performer** |
| `GgpU7afh...` | 70% | +$14 | 1.5h | **Active** |
| `Bb2Rt2W2...` | 70% | +$59 | 0.2h | **Active — HF scalper** |
| `HgfAwZ1a...` | 70% | +$42 | 0.6h | **Active** |
| `GkFKcymc...` | 60% | +$13 | 9.1h | Borderline — monitor |
| `62ZSNw4k...` | 70% | -$21 | 0.6h | Dropped — negative PnL |
| `9mCErMPf...` | 50% | -$26 | 0.2h | Dropped |
| `A2yFVDJv...` | 50% | -$19 | 0.1h | Dropped — ROCKET-only |
| `AtGK6qek...` | 60% | +$7 | 0.2h | Dropped — micro/irrelevant |
| `3MrM6bC8...` | 30% | -$126 | 7.4h | Dropped — worst performer |

> Note: LPAgent API caps history at ~10 positions per query. Re-evaluate wallets monthly as more data accumulates.

---

## Known Issues / Tech Debt

- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
- `studyTopLPers()` now always returns a result per LPer even on API failure (summary-only, no positions). The `owner` field is now the full wallet address; `owner_short` is the truncated display version. The `study` GENERAL intent now also grants `add_smart_wallet` / `list_smart_wallets` so top-LPer wallets can be tracked in the same session.
- REPL deploy requests (`/deploy` intent) now use `screeningModel` instead of `generalModel`.
