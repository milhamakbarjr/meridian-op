import fs from "fs";
import { randomUUID } from "crypto";
import { getActiveBin } from "../tools/dlmm.js";
import { getPoolDetail } from "../tools/screening.js";
import { config } from "../config.js";
import { log } from "../logger.js";

const POSITIONS_FILE = "./dryrun-positions.json";

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

/**
 * Called from executor.js after a deploy_position DRY_RUN result.
 * Fire-and-forget — does not block the executor return.
 */
export async function registerDryRunDeploy(args, result) {
  try {
    const poolAddress = args.pool_address;
    if (!poolAddress) return;

    // Use the screening timeframe (default 30m) for consistency with the filter
    // and deploy-time threshold check. Hardcoding 5m made fee/TVL look 6x lower
    // than the configured floor on first comparison.
    const screeningTimeframe = config.screening.timeframe || "5m";
    const [binData, poolData] = await Promise.allSettled([
      getActiveBin({ pool_address: poolAddress }),
      getPoolDetail({ pool_address: poolAddress, timeframe: screeningTimeframe }),
    ]);

    const bin = binData.status === "fulfilled" ? binData.value : null;
    const pool = poolData.status === "fulfilled" ? poolData.value : null;

    const activeBinAtDeploy = bin?.binId ?? null;
    const priceAtDeploy = bin?.price ?? null;
    const amountSol = args.amount_y ?? args.amount_sol ?? result.would_deploy?.amount_y ?? 0.5;
    const binsBelow = args.bins_below ?? result.would_deploy?.bins_below ?? 35;
    const binsAbove = args.bins_above ?? result.would_deploy?.bins_above ?? 0;

    const lowerBin = activeBinAtDeploy != null ? activeBinAtDeploy - binsBelow : null;
    const upperBin = activeBinAtDeploy != null ? activeBinAtDeploy + binsAbove : null;

    // Estimate initial USD value (SOL amount × SOL price from pool if available)
    const solPriceUsd = pool?.token_y?.price ?? pool?.price_y ?? null;
    const initialValueUsd = solPriceUsd != null ? amountSol * solPriceUsd : amountSol * 150; // fallback $150/SOL

    // LVR-grounded markout instrumentation (2026-06-09)
    const screeningVolatility = pool?.volatility ?? null;
    const tvlAtDeploy = pool?.active_tvl ?? pool?.tvl ?? null;

    const id = `DRYRUN-${randomUUID().slice(0, 8).toUpperCase()}`;

    const record = {
      position: id,
      pool: poolAddress,
      pool_name: args.pool_name ?? pool?.name ?? poolAddress.slice(0, 8),
      strategy: args.strategy ?? result.would_deploy?.strategy ?? "bid_ask",
      amount_sol: amountSol,
      bins_below: binsBelow,
      bins_above: binsAbove,
      lower_bin: lowerBin,
      upper_bin: upperBin,
      active_bin_at_deploy: activeBinAtDeploy,
      price_at_deploy: priceAtDeploy,
      last_price: priceAtDeploy,
      initial_value_usd: initialValueUsd,
      sim_current_value_usd: initialValueUsd,
      total_fees_accrued_usd: 0,
      pnl_pct: 0,
      deployed_at: new Date().toISOString(),
      last_snapshot_at: new Date().toISOString(),
      out_of_range_since: null,
      minutes_out_of_range: 0,
      age_minutes: 0,
      snapshot_count: 0,
      // ── LVR markout instrumentation ─────────────────
      sol_price_usd_at_deploy: solPriceUsd,
      screening_volatility: screeningVolatility,  // σ used to make the deploy decision
      tvl_at_deploy: tvlAtDeploy,
      price_history: priceAtDeploy != null ? [{ t: new Date().toISOString(), p: priceAtDeploy }] : [],
      // ────────────────────────────────────────────────
      screener_meta: {
        organic_score: pool?.token_x?.organic_score ?? pool?.organic ?? null,
        volatility: screeningVolatility,
        fee_tvl_ratio: pool?.fee_active_tvl_ratio ?? null,
        bin_step: pool?.dlmm_params?.bin_step ?? pool?.bin_step ?? null,
        tvl_usd: tvlAtDeploy,
      },
    };

    const data = loadPositions();
    data.positions[id] = record;
    savePositions(data);

    log("dryrun", `Registered sim position ${id} for ${record.pool_name} (${amountSol} SOL)`);
  } catch (e) {
    log("dryrun_warn", `Failed to register sim position: ${e.message}`);
  }
}
