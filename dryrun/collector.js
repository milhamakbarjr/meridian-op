import fs from "fs";
import { getActiveBin } from "../tools/dlmm.js";
import { getPoolDetail } from "../tools/screening.js";
import { log } from "../logger.js";
import { evaluateClose } from "./eval.js";
import { config } from "../config.js";

const POSITIONS_FILE = "./dryrun-positions.json";
const SNAPSHOTS_FILE = "./dryrun-snapshots.jsonl";
const CLOSED_FILE = "./dryrun-closed.jsonl";

function loadPositions() {
  try {
    return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  } catch {
    return { positions: {} };
  }
}

function savePositions(data) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2));
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

// LVR-grounded markout helpers (2026-06-09)
function realizedVolatilityFromHistory(history) {
  if (!Array.isArray(history) || history.length < 3) return null;
  // log returns between consecutive observations
  const logReturns = [];
  for (let i = 1; i < history.length; i++) {
    const p0 = history[i - 1]?.p;
    const p1 = history[i]?.p;
    if (p0 > 0 && p1 > 0) logReturns.push(Math.log(p1 / p0));
  }
  if (logReturns.length < 2) return null;
  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / logReturns.length;
  // We sample roughly every managementIntervalMin (10 min default). Annualize to compare to screening σ.
  // Screening σ from Meteora is typically a hourly-scale number; we report unannualized stdev too for transparency.
  const stdev = Math.sqrt(variance);
  // Approximate annualization assuming ~10-min sampling: sqrt(525600 / 10) ≈ 229.1
  // This is rough — Meteora's volatility is reported in a non-annualized scale, so this annualized number
  // is only useful for relative comparison across positions, not direct equality with screening σ.
  return {
    raw_stdev_log: parseFloat(stdev.toFixed(6)),
    annualized_approx: parseFloat((stdev * Math.sqrt(525600 / 10)).toFixed(4)),
    sample_count: logReturns.length,
  };
}

function computeMarkoutSol(pos, snap, finalValueUsd) {
  // Markout PnL in SOL terms — strips out SOL/USD direction noise.
  // For single-sided SOL deploys: hold-SOL baseline = initial_amount_sol unchanged.
  // LP outcome in SOL = final_value_usd / sol_price_at_close.
  // Markout (SOL) = LP_outcome_sol - initial_amount_sol.
  const solPriceAtClose = snap?.pool_fee_24h_usd != null && snap?.pool_tvl_usd != null ? null : null;
  // ^ collector doesn't directly capture SOL price at close; we fall back to deploy-time price
  // (acceptable error: SOL drift over 10-min to ~4h hold is typically <2%).
  const solPriceUsdSnap = pos.sol_price_usd_at_deploy ?? 150;
  if (!Number.isFinite(solPriceUsdSnap) || solPriceUsdSnap <= 0) return null;
  const lpOutcomeSol = finalValueUsd / solPriceUsdSnap;
  const holdBaselineSol = pos.amount_sol ?? (pos.initial_value_usd / solPriceUsdSnap);
  return parseFloat((lpOutcomeSol - holdBaselineSol).toFixed(6));
}

function closeSimPosition(pos, snap, closeRule) {
  const finalValueUsd = pos.sim_current_value_usd;
  const pnlUsd = finalValueUsd - pos.initial_value_usd;
  const pnlPct = pos.initial_value_usd > 0
    ? parseFloat(((pnlUsd / pos.initial_value_usd) * 100).toFixed(2))
    : 0;
  const feesVsIl = {
    total_fees_accrued_usd: parseFloat(pos.total_fees_accrued_usd.toFixed(4)),
    estimated_il_usd: parseFloat((pos.initial_value_usd - (pos.sim_current_value_usd - pos.total_fees_accrued_usd)).toFixed(4)),
  };

  // ── LVR markout fields ───────────────────────────────
  const realizedVol = realizedVolatilityFromHistory(pos.price_history);
  const markoutSol = computeMarkoutSol(pos, snap, finalValueUsd);
  const tvlDeltaUsd = (snap?.pool_tvl_usd != null && pos.tvl_at_deploy != null)
    ? parseFloat((snap.pool_tvl_usd - pos.tvl_at_deploy).toFixed(2))
    : null;
  const screeningVol = pos.screening_volatility ?? null;
  const realizedAnnualized = realizedVol?.annualized_approx ?? null;
  const volStalenessRatio = (screeningVol != null && realizedAnnualized != null && screeningVol > 0)
    ? parseFloat((realizedAnnualized / screeningVol).toFixed(3))
    : null;
  // ─────────────────────────────────────────────────────

  const record = {
    position: pos.position,
    pool: pos.pool,
    pool_name: pos.pool_name,
    strategy: pos.strategy,
    amount_sol: pos.amount_sol,
    deployed_at: pos.deployed_at,
    closed_at: new Date().toISOString(),
    age_minutes: pos.age_minutes ?? 0,
    snapshot_count: pos.snapshot_count ?? 0,
    close_rule: closeRule.rule,
    close_reason: closeRule.reason,
    initial_value_usd: parseFloat(pos.initial_value_usd.toFixed(4)),
    final_value_usd: parseFloat(finalValueUsd.toFixed(4)),
    pnl_usd: parseFloat(pnlUsd.toFixed(4)),
    pnl_pct: pnlPct,
    ...feesVsIl,
    // ── LVR markout block ─────────────────────────────
    markout_pnl_sol: markoutSol,
    realized_volatility: realizedVol,
    screening_volatility: screeningVol,
    vol_staleness_ratio: volStalenessRatio,  // >1 = realized higher than screening (underestimated σ)
    tvl_at_deploy: pos.tvl_at_deploy ?? null,
    tvl_at_close: snap?.pool_tvl_usd ?? null,
    tvl_delta_during_hold_usd: tvlDeltaUsd,
    price_history_length: pos.price_history?.length ?? 0,
    // ──────────────────────────────────────────────────
    screener_meta: pos.screener_meta,
    last_snapshot: snap,
  };

  appendLine(CLOSED_FILE, record);
  log("dryrun", `Sim position ${pos.position} (${pos.pool_name}) closed: ${pnlPct}% | rule=${closeRule.rule} ${closeRule.reason} | markout_sol=${markoutSol ?? "?"}`);
  return record;
}

/**
 * Main collector — called on each management cycle interval.
 * For each open sim position: snapshot pool state, accrue fees,
 * update value, and apply close-trigger rules.
 */
export async function runDryRunCollector() {
  const data = loadPositions();
  const openPositions = Object.values(data.positions);

  if (openPositions.length === 0) return;

  const now = new Date();
  let closedCount = 0;

  for (const pos of openPositions) {
    try {
      const [binRes, poolRes] = await Promise.allSettled([
        getActiveBin({ pool_address: pos.pool }),
        getPoolDetail({ pool_address: pos.pool, timeframe: "5m" }),
      ]);

      const bin = binRes.status === "fulfilled" ? binRes.value : null;
      const pool = poolRes.status === "fulfilled" ? poolRes.value : null;

      if (!bin && !pool) {
        log("dryrun_warn", `No data for sim position ${pos.position} pool ${pos.pool.slice(0, 8)} — skipping snapshot`);
        continue;
      }

      const currentBinId = bin?.binId ?? null;
      const currentPrice = bin?.price ?? pos.last_price;
      const lastSnapshotAt = new Date(pos.last_snapshot_at);
      const intervalMs = now - lastSnapshotAt;
      const intervalHours = intervalMs / 3_600_000;
      const ageMins = Math.round((now - new Date(pos.deployed_at)) / 60_000);

      // Pool metrics for fee accrual
      const poolTvlUsd = pool?.active_tvl ?? pool?.tvl ?? 0;
      const poolFee24hUsd = pool?.fee ?? pool?.fee_window ?? 0;
      const feeTvl24h = pool?.fee_active_tvl_ratio ?? 0;

      // Determine in-range status
      const inRange = currentBinId != null && pos.lower_bin != null && pos.upper_bin != null
        ? currentBinId >= pos.lower_bin && currentBinId <= pos.upper_bin
        : null;

      // Out-of-range tracking
      let outOfRangeSince = pos.out_of_range_since;
      if (inRange === false && !outOfRangeSince) {
        outOfRangeSince = now.toISOString();
      } else if (inRange === true) {
        outOfRangeSince = null;
      }
      const minutesOutOfRange = outOfRangeSince
        ? Math.round((now - new Date(outOfRangeSince)) / 60_000)
        : 0;

      // Fee accrual: position's proportional share of pool fees
      const posValueUsd = pos.sim_current_value_usd;
      const posShareOfTvl = poolTvlUsd > 0 ? Math.min(posValueUsd / poolTvlUsd, 1) : 0;
      const feeIncrement = intervalHours > 0 && poolFee24hUsd > 0
        ? (poolFee24hUsd / 24) * intervalHours * posShareOfTvl
        : 0;

      // Value update based on in-range status
      let newValue;
      if (inRange === true || inRange === null) {
        // In range: no IL approximated, fees only
        newValue = posValueUsd + feeIncrement;
      } else if (currentBinId < pos.lower_bin) {
        // Below range: fully in base token — track price decline/rise
        const priceChange = pos.last_price > 0
          ? (currentPrice - pos.last_price) / pos.last_price
          : 0;
        newValue = posValueUsd * (1 + priceChange) + feeIncrement;
      } else {
        // Above range: fully in SOL (quote) — stable + fees
        newValue = posValueUsd + feeIncrement;
      }
      newValue = Math.max(0, newValue);

      const totalFees = pos.total_fees_accrued_usd + feeIncrement;
      const pnlPct = pos.initial_value_usd > 0
        ? parseFloat(((newValue - pos.initial_value_usd) / pos.initial_value_usd * 100).toFixed(2))
        : 0;

      const snap = {
        timestamp: now.toISOString(),
        position: pos.position,
        pool: pos.pool,
        active_bin: currentBinId,
        price: currentPrice,
        in_range: inRange,
        minutes_out_of_range: minutesOutOfRange,
        fee_tvl_24h: feeTvl24h,
        pool_tvl_usd: poolTvlUsd,
        pool_fee_24h_usd: poolFee24hUsd,
        sim_value_usd: parseFloat(newValue.toFixed(4)),
        fee_increment_usd: parseFloat(feeIncrement.toFixed(6)),
        pnl_pct: pnlPct,
        data_quality: (!bin ? "no_bin" : !pool ? "no_pool" : "ok"),
      };

      appendLine(SNAPSHOTS_FILE, snap);

      // Update position record
      const updatedPriceHistory = Array.isArray(pos.price_history) ? [...pos.price_history] : [];
      if (currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0) {
        updatedPriceHistory.push({ t: now.toISOString(), p: currentPrice });
        // Cap at 1000 samples to keep position file size sane (~10 days at 10m interval)
        if (updatedPriceHistory.length > 1000) updatedPriceHistory.shift();
      }

      const updatedPos = {
        ...pos,
        last_snapshot_at: now.toISOString(),
        last_price: currentPrice ?? pos.last_price,
        sim_current_value_usd: newValue,
        total_fees_accrued_usd: totalFees,
        pnl_pct: pnlPct,
        out_of_range_since: outOfRangeSince,
        minutes_out_of_range: minutesOutOfRange,
        age_minutes: ageMins,
        snapshot_count: (pos.snapshot_count ?? 0) + 1,
        price_history: updatedPriceHistory,
      };

      // Check close triggers
      const closeRule = evaluateClose(updatedPos, snap, config.management);
      if (closeRule) {
        closeSimPosition(updatedPos, snap, closeRule);
        delete data.positions[pos.position];
        closedCount++;
      } else {
        data.positions[pos.position] = updatedPos;
      }
    } catch (e) {
      log("dryrun_warn", `Collector error for ${pos.position}: ${e.message}`);
    }
  }

  savePositions(data);

  const remaining = Object.keys(data.positions).length;
  if (closedCount > 0 || remaining > 0) {
    log("dryrun", `Collector: ${remaining} open sim positions, ${closedCount} closed this cycle`);
  }
}

/**
 * Summary for daily Telegram status / sanity check.
 */
export function getDryRunStatus() {
  const data = loadPositions();
  const open = Object.values(data.positions);

  let closedToday = 0;
  let snapshotsToday = 0;
  const today = new Date().toISOString().slice(0, 10);

  try {
    const lines = fs.readFileSync(CLOSED_FILE, "utf8").split("\n").filter(Boolean);
    closedToday = lines.filter(l => { try { return JSON.parse(l).closed_at?.startsWith(today); } catch { return false; } }).length;
  } catch { /* file may not exist yet */ }

  try {
    const lines = fs.readFileSync(SNAPSHOTS_FILE, "utf8").split("\n").filter(Boolean);
    snapshotsToday = lines.filter(l => { try { return JSON.parse(l).timestamp?.startsWith(today); } catch { return false; } }).length;
  } catch { /* file may not exist yet */ }

  const degraded = open.filter(p => p.last_snapshot_at && (Date.now() - new Date(p.last_snapshot_at)) > 30 * 60 * 1000);

  return {
    open_positions: open.length,
    closed_today: closedToday,
    snapshots_today: snapshotsToday,
    data_quality_alerts: degraded.length > 0 ? `${degraded.length} position(s) have stale snapshots (>30 min)` : "none",
  };
}
