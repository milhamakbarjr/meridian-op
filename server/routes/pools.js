import fs from "node:fs";
import { repoPath } from "../../repo-root.js";
import { recallForPool, isPoolOnCooldown, isBaseMintOnCooldown } from "../../pool-memory.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");

function loadPoolMemory() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8")); } catch { return {}; }
}

export async function registerPoolsRoutes(app) {
  // List all pools — compact summary, snapshots stripped to keep payload small
  app.get("/pools", async (req) => {
    const sortBy = req.query?.sort || "total_deploys";
    const limit = Math.min(500, Number(req.query?.limit ?? 100));

    const memory = loadPoolMemory();
    const rows = Object.entries(memory).map(([address, m]) => {
      const cd = isPoolOnCooldown(address);
      return {
        address,
        name: m.name,
        base_mint: m.base_mint,
        total_deploys: m.total_deploys || 0,
        win_rate: m.win_rate,
        adjusted_win_rate: m.adjusted_win_rate,
        avg_pnl_pct: m.avg_pnl_pct,
        last_outcome: m.last_outcome,
        last_deployed_at: m.last_deployed_at,
        cooldown_until: m.cooldown_until,
        base_mint_cooldown_until: m.base_mint_cooldown_until,
        on_cooldown: !!cd,
        cooldown_reason: typeof cd === "object" ? cd.reason : null,
        notes_count: (m.notes || []).length,
        snapshots_count: (m.snapshots || []).length,
      };
    });

    const sorted = rows.sort((a, b) => {
      const av = a[sortBy] ?? -Infinity;
      const bv = b[sortBy] ?? -Infinity;
      return typeof av === "number" && typeof bv === "number" ? bv - av : String(bv).localeCompare(String(av));
    });

    return { total: sorted.length, returned: Math.min(limit, sorted.length), pools: sorted.slice(0, limit) };
  });

  // Full record incl. deploys, notes, snapshots
  app.get("/pools/:address", async (req) => {
    const memory = loadPoolMemory();
    const m = memory[req.params.address];
    if (!m) return { not_found: true, address: req.params.address };
    return {
      address: req.params.address,
      ...m,
      on_cooldown: !!isPoolOnCooldown(req.params.address),
      base_mint_on_cooldown: m.base_mint ? !!isBaseMintOnCooldown(m.base_mint) : false,
      recall: recallForPool(req.params.address),
    };
  });
}
