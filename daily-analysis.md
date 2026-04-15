# Meridian Daily Analysis Log

Tracks config changes, what we changed and why, and 24h performance each day.
Goal: identify the most optimum setup over time.

---

## 2026-04-14 — Morning Review (Apr 13 00:00 → Apr 14 ~02:00 UTC)

### Performance
| Metric | Value |
|--------|-------|
| Trades closed | 34 |
| Winners (>0.5%) | 18 (52.9%) |
| Losers (<-0.5%) | 1 |
| Flat | 15 |
| Total PnL | **+$2.85** |
| SOL deployed | 5.12 SOL |
| Wallet end of period | ~0.955 SOL / ~$82 |

### By Pool
| Pool | Trades | PnL | W/L | Avg Hold |
|------|--------|-----|-----|----------|
| ALONSHOUSE-SOL | 11 | +$2.92 | 7W/0L | 91m |
| BULL-SOL | 8 | +$0.45 | 4W/0L | 91m |
| Harry-SOL | 4 | +$0.41 | 3W/0L | 54m |
| DJT-SOL | 1 | +$0.37 | 1W/0L | 192m |
| Iroha-SOL | 3 | +$0.30 | 2W/0L | 91m |
| unc-SOL | 2 | +$0.01 | 0W/0L | 21m |
| BURNIE-SOL | 2 | -$0.06 | 0W/0L | 505m |
| RND-SOL | 3 | -$1.55 | 1W/1L | 116m |

### Key Observations
- **ALONSHOUSE-SOL** star performer — 11 trades, +$2.92, consistent smart wallet signal (5-7/36)
- **RND-SOL stop loss (-$1.74)** wiped 61% of day's gains in a single trade — biggest risk event
- 15 flat trades (44%) — most "pumped far above range" exits with near-zero PnL (low range efficiency)
- Ghost position (unc-SOL) looped failed close attempts all day, burning agent cycles
- Chart indicator feature merged from upstream but was disabled — not yet contributing

### Code Changes (Merged from upstream)
- `tools/chart-indicators.js` — NEW: RSI/Bollinger/Supertrend exit gating via Agent Meridian API
- `index.js` — chart indicator confirmation added to ALL exit types (stop loss, TP, trailing TP, OOR, low yield)
- `config.js` — removed `maxVolatility` and `stopLossCooldownHours` fields
- `tools/screening.js` — removed non-SOL quote token filter
- `index.js` — removed wallet sweep functionality entirely

### Config Changes Applied Today
| Setting | Before | After | Reason |
|---------|--------|-------|--------|
| maxPositions | 3 | **2** | Focus capital, reduce drag from underperforming 3rd position |
| deployAmountSol | 0.15 | **0.25** | Larger positions to maximize ALONSHOUSE-style winners |
| positionSizePct | 0.22 | **0.30** | Scale with wallet balance more aggressively |
| gasReserve | 0.20 | **0.35** | Higher reserve for safety with fewer positions |
| minSolToOpen | 0.35 | **0.55** | Guard against depleting wallet below safe operating level |
| chartIndicators.enabled | false | **true** | Enable exit confirmation to reduce premature/bad exits |
| managementIntervalMin | 60 | **30** | Faster reaction on 2 bigger positions; also halves poller cooldown |
| screeningIntervalMin | 30 | **45** | Less churn — wait longer for a quality pick instead of cycling every 30m |

### Hypothesis for Next Period
With 2 positions instead of 3:
- Capital concentrates in the best 2 pools rather than spreading thin
- Fewer positions = less drag from underperformers like RND-SOL
- Chart indicator gating should reduce false exits (pumped-above-range noise)
- Larger deploy (0.25 SOL) means winning trades return more absolute USD

---

---

## 2026-04-15 — Morning Review (Apr 14 ~02:00 → Apr 15 ~02:21 UTC)

### Performance
| Metric | Value |
|--------|-------|
| Trades closed | 17 |
| Winners (>0.5%) | 4 (23.5%) |
| Losers (<-0.5%) | 3 |
| Flat | 10 |
| Total PnL | **-$4.13** (would be +$0.82 without ALONSHOUSE stop loss) |
| SOL deployed | ~4.25 SOL (17 × 0.25 SOL) |
| Wallet end of period | ~0.908 SOL / ~$76 |

### By Pool
| Pool | Trades | PnL | W/L | Avg Hold |
|------|--------|-----|-----|----------|
| unc-SOL | 5 | +$0.43 | 1W/2L | 63m |
| Harry-SOL | 1 | +$0.07 | 1W/0L | 44m |
| Iroha-SOL | 3 | ~$0.00 | 0W/0L | 60m |
| Goku-SOL | 3 | -$0.30 | 1W/1L | 76m |
| BURNIE-SOL | 1 | -$0.03 | 0W/0L | 59m |
| BULL-SOL | 1 | -$0.10 | 0W/0L | 134m |
| ALONSHOUSE-SOL | 3 | **-$3.88** | 2W/1L | 127m |

### Key Observations
- **ALONSHOUSE-SOL stop loss disaster**: -22.98% in a single trade wiped $4.95 — turned a profitable day (+$0.82) into -$4.13. Token had vol 5.36 (just above maxVolatility 5 — slipped through). The position ran well for 3 hours before a fast market shift; this is the nature of meme tokens, not a controllable event. The real problem: 30-min management interval meant the -15% stop loss triggered at -22.98% (8% slippage between checks)
- **Ghost position paralysis (again)**: Harry-SOL failed deploy at 18:25 created an empty on-chain position. Bot spent 30+ management cycles (8+ hours, all of Apr 15) trying to close it — "LPAgent close order returned no transactions" every time. 0 new positions deployed on Apr 15. This is the second consecutive day this happened (Apr 13 and Apr 14 overnight). **Needs a code fix — not a config issue**
- **OOR dominance**: 9/17 closes (53%) were out-of-range exits. `bins_above = 0` means any upward price movement = instant OOR. This is structural — the SOL-only bid_ask strategy by design has zero upside tolerance
- **Pumped above range**: 5/17 positions. Same structural root cause — with bins_above=0, Rule 3 triggers after just 11 bins upward. Reframe: SOL stays intact when pumped OOR, so this is a neutral/missed-opportunity outcome, not a loss
- **Trailing TP worked**: unc-SOL +2.20% caught by trailing TP (3% trigger, 1.5% drop) — validates the mechanism
- **Range efficiency bimodal**: positions are either 80-100% RE or <20% RE with no middle ground. The under-20% RE positions go OOR within minutes of deploy
- **Ghost consumed all cycles**: because the ghost counted as 1 of 2 positions, only 1 new deploy slot was available. Combined with ALONSHOUSE cooldown, unc-SOL cooldown, and DUMBMONEY wash-trade filter, the bot had almost no valid deploy options in the final 8 hours

### Config Changes Applied Today
| Setting | Before | After | Reason |
|---------|--------|-------|--------|
| minBinStep | 80 | **100** | Every bin_step=80 position in lessons.json failed. 100 gives ~1%/bin = wider coverage per bin |
| minVolume | 1000 | **5000** | 5x below research minimum — low volume pools are fee deserts |
| bins_below floor (code) | 35 | **55** | Minimum floor in screener formula — prevents narrow range positions on low-volatility deploys |

### Code Changes Implemented Today
- **Ghost position failsafe**: `state.js` tracks `close_failure_count` per position. After 3 failed closes, position is marked ghost. Ghost positions are excluded from `maxPositions` count in both `executor.js` and `runScreeningCycle()`, and skipped in management cycle. Deploy path now attempts cleanup of empty position accounts on Phase 2 failure. Telegram alert fires on first ghost detection
- **5-min price-drop monitor**: new `runPriceMonitor()` loop checks open positions every 5 minutes for stop-loss-level drops — no LLM, purely deterministic. Triggers emergency close immediately instead of waiting for the 30-min management cycle

### Hypothesis for Next Period
- Ghost fix unblocks the bot from the overnight paralysis pattern — should recover full 2-position capacity immediately when a deploy fails
- Faster stop loss response (5-min monitor vs 30-min cycle) should dramatically reduce slippage between configured -15% and actual trigger level
- minBinStep=100 filters out narrow-coverage pools; minVolume=5000 filters fee deserts — fewer but better quality entries
- Two bigger positions with better pool quality = more meaningful wins and fewer wasted cycles

---

*Template for future entries:*

## YYYY-MM-DD — Morning Review (YYYY-MM-DD 00:00 → YYYY-MM-DD ~HH:MM UTC)

### Performance
| Metric | Value |
|--------|-------|
| Trades closed | |
| Winners (>0.5%) | |
| Losers (<-0.5%) | |
| Flat | |
| Total PnL | |
| SOL deployed | |
| Wallet end of period | |

### By Pool
| Pool | Trades | PnL | W/L | Avg Hold |
|------|--------|-----|-----|----------|

### Key Observations
- 

### Config Changes Applied
| Setting | Before | After | Reason |
|---------|--------|-------|--------|

### Hypothesis for Next Period

