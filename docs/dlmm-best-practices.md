# Meteora DLMM LP Best Practices

Research compiled 2026-04-05 from Meteora docs, LP Army, Decoder Farmer, community guides, open-source bots, and practitioner posts.

---

## Strategy Selection

| Strategy | Best For | Notes |
|----------|----------|-------|
| **Bid-Ask** | Meme tokens (recommended) | Concentrates capital at range extremes, captures volatility swings, allows SOL-only deployment |
| Spot | Mid-volatility tokens | Decent middle ground, uniform distribution |
| Curve | Stablecoins only | Center concentration gets destroyed by large moves — worst for meme tokens |

## Bin Configuration

- **Bin width**: 35-69 bins per position (Meteora max is 69 per position)
- **Bin step 80**: ~0.8-1% base fee
- **Bin step 100**: ~1-2% base fee (most common for meme tokens)
- **Bin step 125**: ~1.5-2.5% base fee
- Dynamic fees can surge to 10% max during volatility
- LPs keep 95% on standard DLMM pools, 80% on launch pools

Formula for bins_below based on volatility:
```
bins_below = round(35 + (volatility / 5) * 34), clamped to [35, 69]
```

## Pool Quality Signals

### Fee/TVL Ratio (daily)
- **1%+ daily**: Strong pool
- **0.5-1%**: Decent
- **< 0.5%**: Weak — avoid
- Look for **10x volume-to-TVL ratio** (e.g., $50k TVL, $500k volume)

### Organic Score (Jupiter, 0-100)
- **80+**: High quality, real trading activity
- **65-80**: Acceptable for trending meme tokens
- **< 65**: High risk of fake/bot activity
- SOL itself scores ~99 ("high" label)

### Trading Volume
- **$5,000-10,000 minimum** recommended for meme-token pools
- Ensures real, ongoing trading activity (not just a single large swap)
- Low volume = fees dry up quickly after deploy

### Bot Holder Percentage
- **5-18%**: Normal for legitimate Solana meme tokens
- **18-30%**: Elevated but may be acceptable with other strong signals
- **30%+**: High manipulation risk
- Most Pump.fun tokens show manipulation — filter carefully

### Holder Count
- **500+ minimum** — filters pump-and-dumps
- Raw counts unreliable (bots inflate cheaply) — combine with holder concentration (top 10 holders %)

### Market Cap
- **$500k-$2M minimum** recommended for safety
- **$10M max** for meme tokens (above this, returns diminish)
- Lower mcap = higher risk but potentially higher fees

## Position Management

### Duration
- **Typical hold**: 10 minutes to 4 hours for meme-token LP
- Best performers (smart wallet data): 0.2-1.5 hours average hold
- Scalpers: avg hold <= 4h; holders: >= 4h — both valid strategies

### Profit Targets
- **Fee take-profit**: 8-12% of deployed value (some guides say 20-30% for "great sessions")
- **Trailing take-profit**: 5-8% activation, 2-5% trail drop
- **Important**: Trailing trigger should be set ABOVE or near the static fee TP to avoid conflict — if trailing fires first, fee TP never reaches

### Stop Loss
- **-15% to -25%**: Most common range in automated bots
- **-30% to -40%**: Used by some aggressive meme-token bots
- **-10%**: Aggressive/tight — may trigger on normal IL fluctuations, but defensible for small positions where capital preservation matters most
- **Note**: Concentrated liquidity amplifies IL — a 2x price move = ~23% IL (4x standard IL)

### Out-of-Range Management
- OOR = no fee earning — close or rebalance
- **15-20 minutes** is a reasonable wait before closing
- Meme tokens swing wildly — bounces within 20-30 min are common
- 15 min is slightly aggressive; 20 min gives more room for recovery

### Low Yield Detection
- Positions in-range but earning minimal fees should be closed
- **minFeePerTvl24h: 5-7%** is a reasonable floor
- Grace period of 60 minutes before evaluating (fees can be noisy early)

## Position Sizing
- **5-10% per pool** (general DeFi guidance)
- **15-22%** acceptable for small wallets with 3 positions
- With maxPositions=3 at 22%, total exposure = 66% — aggressive but manageable
- Always maintain gas reserve (0.2+ SOL) for closes and swaps

## DAMM V2 vs DLMM
- **DLMM is better for automated bots**: dynamic fees, bin precision, 92% of volume, 5% protocol fee
- **DAMM V2**: passive/launch scenarios, 20% protocol fee
- No reason to switch from DLMM for meme-token LP

## Common Mistakes
1. **Holding OOR positions too long** — dead slot time, no fees earned
2. **Not checking price sync before deploying** — can deploy at stale price
3. **Too narrow range on volatile tokens** — goes OOR immediately
4. **Annualizing daily fee/TVL snapshots** — misleading; meme pool activity is bursty
5. **Ignoring IL on 2-5x price moves** — concentrated LP amplifies losses
6. **Deploying during peak pumps** — being last to hold the bag
7. **Tight trailing TP conflicting with fee TP** — positions close at tiny profit before fees compound
8. **Low minVolume filter** — pools with $500 volume can look alive from a single swap then die

## Key Data Sources
- [Meteora DLMM Docs](https://docs.meteora.ag/overview/products/dlmm/what-is-dlmm)
- [Meteora Strategies & Use Cases](https://docs.meteora.ag/overview/products/dlmm/strategies-and-use-cases)
- [Jupiter Organic Score](https://dev.jup.ag/docs/tokens/organic-score)
- [Decoder Farmer DLMM Guide](https://decoder-1.gitbook.io/decoder-farmer/farms/meteora-dlmm)
- [LP Army Strategy Library](https://www.lparmy.com/strategies)
- [Meteora LP Army Bootcamp](https://docs.meteora.ag/user-faq/video-tutorials-to-get-started/lp-army-boot-camp)
- [GeekLad Meteora Profit Analysis](https://geeklad.github.io/meteora-profit-analysis/)
- [TrackLP - DLMM Tracker](https://tracklp.com/)
- [Dune: Meteora DLMM Fee/TVL Dashboard](https://dune.com/geeklad/meteora-dlmm-fee-to-tvl)
- [Impermanent Loss in Uniswap V3](https://medium.com/auditless/impermanent-loss-in-uniswap-v3-6c7161d3b445)
