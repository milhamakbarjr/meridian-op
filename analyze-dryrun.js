#!/usr/bin/env node
/**
 * Post-hoc DRY_RUN analyzer.
 * Reads locally-collected dryrun-*.jsonl/json files and generates a markdown report.
 *
 * Usage:
 *   node analyze-dryrun.js --since 2026-04-27 --until 2026-05-31
 *   node analyze-dryrun.js --since 2026-04-27  (until = today)
 */

import fs from "fs";
import path from "path";

const CLOSED_FILE = "./dryrun-closed.jsonl";
const POSITIONS_FILE = "./dryrun-positions.json";
const SNAPSHOTS_FILE = "./dryrun-snapshots.jsonl";
const ACTIONS_LOGS_DIR = "./logs";

// ── Arg parsing ───────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const since = getArg("--since") ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const until = getArg("--until") ?? new Date().toISOString().slice(0, 10);
const untilEnd = until + "T23:59:59Z";

console.log(`Analyzing DRY_RUN period: ${since} → ${until}`);

// ── Load data ─────────────────────────────────────────────
function loadJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function inPeriod(ts) {
  return ts >= since && ts <= untilEnd;
}

const closed = loadJsonl(CLOSED_FILE).filter(r => inPeriod(r.deployed_at ?? r.closed_at));
const snapshots = loadJsonl(SNAPSHOTS_FILE).filter(r => inPeriod(r.timestamp));

// Open sim positions still running at report time
let stillOpen = [];
try {
  const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  stillOpen = Object.values(data.positions).filter(p => inPeriod(p.deployed_at));
} catch { /* no open positions */ }

// Would-deploy entries from actions log (sanity check)
let wouldDeployCount = 0;
try {
  for (const f of fs.readdirSync(ACTIONS_LOGS_DIR).filter(n => n.startsWith("actions-") && n.endsWith(".jsonl"))) {
    const date = f.replace("actions-", "").replace(".jsonl", "");
    if (date >= since && date <= until) {
      const lines = loadJsonl(path.join(ACTIONS_LOGS_DIR, f));
      wouldDeployCount += lines.filter(l => l.tool === "deploy_position" && l.result?.dry_run).length;
    }
  }
} catch { /* logs may not span full period */ }

// ── Math helpers ──────────────────────────────────────────
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "n/a"; }
function fix(n, d = 2) { return n != null ? Number(n).toFixed(d) : "n/a"; }
function sign(n) { return n >= 0 ? "+" : ""; }

// April live baseline for comparison
const APRIL_BASELINE = { fees: 148.02, pnl: -10.66, positions: 400, days: 24 };

// ── Headline stats ────────────────────────────────────────
const allPositions = [...closed, ...stillOpen.map(p => ({
  ...p, pnl_pct: p.pnl_pct ?? 0, pnl_usd: p.sim_current_value_usd - p.initial_value_usd,
  total_fees_accrued_usd: p.total_fees_accrued_usd, close_reason: "still-open (incomplete)"
}))];

const totalPositions = allPositions.length;
const simTotalPnl = sum(allPositions.map(p => p.pnl_usd ?? 0));
const simTotalFees = sum(allPositions.map(p => p.total_fees_accrued_usd ?? 0));
const simTotalIl = sum(allPositions.map(p => p.estimated_il_usd ?? 0));
const winners = allPositions.filter(p => (p.pnl_pct ?? 0) > 0).length;
const losers = allPositions.filter(p => (p.pnl_pct ?? 0) < 0).length;
const winRate = pct(winners, totalPositions);
const meanPnlPct = avg(allPositions.map(p => p.pnl_pct ?? 0));
const daysInPeriod = Math.max(1, Math.round((new Date(until) - new Date(since)) / 86400000));

// April baseline per-position comparison
const aprilMeanPnl = APRIL_BASELINE.pnl / APRIL_BASELINE.positions; // ≈ −$0.027
const simMeanPnlUsd = totalPositions > 0 ? simTotalPnl / totalPositions : 0;
const improvementVsApril = simMeanPnlUsd - aprilMeanPnl;

// ── P&L distribution ──────────────────────────────────────
function bucket(pct) {
  if (pct <= -20) return "rug (≤−20%)";
  if (pct < -5) return "big loss (−5% to −20%)";
  if (pct < -1) return "small loss (−1% to −5%)";
  if (pct < 1) return "flat (−1% to +1%)";
  if (pct < 5) return "small win (+1% to +5%)";
  return "winner (>+5%)";
}
const BUCKET_ORDER = ["rug (≤−20%)", "big loss (−5% to −20%)", "small loss (−1% to −5%)", "flat (−1% to +1%)", "small win (+1% to +5%)", "winner (>+5%)"];
const buckets = {};
for (const b of BUCKET_ORDER) buckets[b] = 0;
for (const p of allPositions) {
  const b = bucket(p.pnl_pct ?? 0);
  buckets[b] = (buckets[b] ?? 0) + 1;
}

// ── Filter signal correlation ─────────────────────────────
const META_KEYS = ["organic_score", "volatility", "fee_tvl_ratio", "bin_step"];
function correlationTable() {
  const rows = [];
  for (const key of META_KEYS) {
    const pairs = allPositions
      .map(p => ({ v: p.screener_meta?.[key], pnl: p.pnl_pct ?? 0 }))
      .filter(x => x.v != null);
    if (pairs.length < 3) { rows.push({ key, corr: "n/a (insufficient data)", n: pairs.length }); continue; }
    const n = pairs.length;
    const meanV = avg(pairs.map(x => x.v));
    const meanP = avg(pairs.map(x => x.pnl));
    const num = sum(pairs.map(x => (x.v - meanV) * (x.pnl - meanP)));
    const den = Math.sqrt(sum(pairs.map(x => (x.v - meanV) ** 2)) * sum(pairs.map(x => (x.pnl - meanP) ** 2)));
    const r = den > 0 ? (num / den).toFixed(3) : "0.000";
    rows.push({ key, corr: r, n });
  }
  return rows;
}

// ── Time-in-range stats ───────────────────────────────────
const posSnapGroups = {};
for (const s of snapshots) {
  if (!posSnapGroups[s.position]) posSnapGroups[s.position] = [];
  posSnapGroups[s.position].push(s);
}

const inRangeStats = allPositions.map(p => {
  const snaps = posSnapGroups[p.position] ?? [];
  if (!snaps.length) return null;
  const inRangeCount = snaps.filter(s => s.in_range === true).length;
  return inRangeCount / snaps.length;
}).filter(Boolean);
const avgInRangePct = inRangeStats.length ? avg(inRangeStats) * 100 : null;

// ── Close reason breakdown ────────────────────────────────
const closeReasons = {};
for (const p of closed) {
  const key = p.close_reason ?? "unknown";
  closeReasons[key] = (closeReasons[key] ?? 0) + 1;
}

// ── Data quality ──────────────────────────────────────────
const degradedSnaps = snapshots.filter(s => s.data_quality !== "ok").length;
const dataQualityPct = snapshots.length > 0 ? ((degradedSnaps / snapshots.length) * 100).toFixed(1) : "0";
const dataQualityWarning = parseFloat(dataQualityPct) > 10
  ? `⚠️ ${dataQualityPct}% of snapshots had degraded data (API unavailable). Numbers above may understate IL.`
  : null;

// ── Build report ──────────────────────────────────────────
const correlations = correlationTable();

const report = `# DRY_RUN Performance Report
**Period:** ${since} → ${until} (${daysInPeriod} days)
**Generated:** ${new Date().toISOString().slice(0, 16)}Z

${dataQualityWarning ? `> ${dataQualityWarning}\n` : ""}
---

## Headline

| Metric | This DRY_RUN | April 2026 live (baseline) |
|---|---|---|
| Positions | ${totalPositions} (+ ${stillOpen.length} still open) | ~400 |
| Win rate | ${winRate} | ~60% |
| Total simulated P&L | ${sign(simTotalPnl)}$${fix(simTotalPnl)} | −$10.66 |
| Mean P&L per position | ${sign(simMeanPnlUsd)}$${fix(simMeanPnlUsd, 4)} | −$0.027 |
| Total fees accrued | +$${fix(simTotalFees)} | +$148.02 |
| Total estimated IL | −$${fix(simTotalIl)} | −$158.68 |
| Improvement vs baseline | ${sign(improvementVsApril)}$${fix(improvementVsApril, 4)}/position | — |

Screener registered ${wouldDeployCount} would-deploy decisions; ${totalPositions} made it into the sim tracker (${wouldDeployCount - totalPositions} may have been skipped or registered before the collector started).

---

## P&L Distribution

| Bucket | Count | % |
|---|---|---|
${BUCKET_ORDER.map(b => `| ${b} | ${buckets[b]} | ${pct(buckets[b], totalPositions)} |`).join("\n")}

---

## Filter Signal Correlation (with P&L %)

Higher absolute value = stronger signal. Positive = higher value → better P&L. Negative = lower value → better P&L.

| Screener metric | Pearson r | Positions with data |
|---|---|---|
${correlations.map(c => `| \`${c.key}\` | ${c.corr} | ${c.n} |`).join("\n")}

**How to use:** Any |r| > 0.2 is worth acting on. If \`organic_score\` has r > +0.2, raise \`minOrganic\`. If \`volatility\` has r < −0.2, lower \`maxVolatility\`.

---

## Time-in-Range Stats

${avgInRangePct != null
  ? `Average time in range: **${avgInRangePct.toFixed(1)}%** across ${inRangeStats.length} positions with snapshots.`
  : "Insufficient snapshot data for time-in-range analysis."}

${avgInRangePct != null && avgInRangePct < 40
  ? "> ⚠️ Low in-range time suggests bin ranges are too narrow or volatility is too high for the configured strategy. Consider wider `bins_below` or tighter vol filters."
  : ""}

---

## Close Reason Breakdown

| Reason | Count |
|---|---|
${Object.entries(closeReasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => `| ${r} | ${n} |`).join("\n") || "| — | — |"}

${closeReasons["stop loss"] > (totalPositions * 0.3)
  ? "> ⚠️ High stop-loss rate. Either the screener is picking weak tokens or the stop-loss threshold is too wide — positions ride losses too long before triggering."
  : ""}
${closeReasons["OOR"] > (totalPositions * 0.4)
  ? "> ⚠️ High OOR close rate. Consider tighter `outOfRangeWaitMinutes` or a smaller `bins_below` to stay in range longer."
  : ""}

---

## Individual Positions

| Pool | Deployed | Closed | Age (min) | P&L % | P&L $ | Fees $ | IL $ | Close Reason | Organic | Vol | Fee/TVL |
|---|---|---|---|---|---|---|---|---|---|---|---|
${allPositions
  .sort((a, b) => (a.pnl_pct ?? 0) - (b.pnl_pct ?? 0))
  .map(p => {
    const m = p.screener_meta ?? {};
    const il = p.estimated_il_usd != null ? fix(p.estimated_il_usd) : "n/a";
    return `| ${p.pool_name ?? p.pool?.slice(0,8)} | ${(p.deployed_at ?? "").slice(5,16)} | ${(p.closed_at ?? "open").slice(5,16)} | ${p.age_minutes ?? "?"} | ${sign(p.pnl_pct ?? 0)}${fix(p.pnl_pct ?? 0)}% | ${sign(p.pnl_usd ?? 0)}$${fix(p.pnl_usd ?? 0)} | $${fix(p.total_fees_accrued_usd ?? 0)} | −$${il} | ${p.close_reason ?? "open"} | ${m.organic_score ?? "?"} | ${m.volatility ?? "?"} | ${m.fee_tvl_ratio ?? "?"} |`;
  }).join("\n")}

---

## Data Quality

- Total snapshots collected: **${snapshots.length}**
- Degraded snapshots (API unavailable): **${degradedSnaps}** (${dataQualityPct}%)
- Would-deploy events in action logs: **${wouldDeployCount}**
- Positions tracked: **${totalPositions}** (${closed.length} closed + ${stillOpen.length} still open)

${parseFloat(dataQualityPct) <= 5 ? "✅ Data quality: good." : parseFloat(dataQualityPct) <= 15 ? "⚠️ Data quality: moderate. IL estimates may be slightly understated." : "🔴 Data quality: poor. Treat IL estimates with caution — too many snapshots had missing API data."}

---

*Report generated by \`analyze-dryrun.js\`. Numbers are simulated — fees and IL are estimated from pool API data sampled every ~10 minutes. Not a substitute for live performance data.*
`;

// ── Write report ──────────────────────────────────────────
const outFile = `dryrun-report-${since}-${until}.md`;
fs.writeFileSync(outFile, report);
console.log(`\nReport written to: ${outFile}`);

// ── Console summary ───────────────────────────────────────
console.log(`\n=== Summary ===`);
console.log(`Period:         ${since} → ${until}`);
console.log(`Positions:      ${totalPositions} (${closed.length} closed, ${stillOpen.length} open)`);
console.log(`Win rate:       ${winRate}`);
console.log(`Total sim P&L:  ${sign(simTotalPnl)}$${fix(simTotalPnl)}`);
console.log(`Mean P&L/pos:   ${sign(simMeanPnlUsd)}$${fix(simMeanPnlUsd, 4)}`);
console.log(`Total fees:     +$${fix(simTotalFees)}`);
console.log(`Total IL est:   -$${fix(simTotalIl)}`);
console.log(`Vs April/pos:   ${sign(improvementVsApril)}$${fix(improvementVsApril, 4)}`);
if (dataQualityWarning) console.log(`\n${dataQualityWarning}`);
