/**
 * Pure close-trigger evaluator for simulated DRY_RUN positions.
 * Mirrors getDeterministicCloseRule() in index.js but operates on
 * a sim position record + snapshot, with no side-effects.
 */

export function evaluateClose(pos, snap, managementConfig) {
  const pnlPct = pos.pnl_pct ?? null;

  if (pnlPct != null && managementConfig.stopLossPct != null && pnlPct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (pnlPct != null && managementConfig.takeProfitPct != null && pnlPct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    snap.active_bin != null &&
    pos.upper_bin != null &&
    managementConfig.outOfRangeBinsToClose != null &&
    snap.active_bin > pos.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    snap.active_bin != null &&
    pos.upper_bin != null &&
    snap.active_bin > pos.upper_bin &&
    (pos.minutes_out_of_range ?? 0) >= (managementConfig.outOfRangeWaitMinutes ?? 30)
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    snap.fee_tvl_24h != null &&
    managementConfig.minFeePerTvl24h != null &&
    snap.fee_tvl_24h < managementConfig.minFeePerTvl24h &&
    (pos.age_minutes ?? 0) >= (managementConfig.minAgeBeforeYieldCheck ?? 60)
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}
