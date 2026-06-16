import fs from "node:fs";
import { repoPath } from "../../repo-root.js";
import { getMyPositions } from "../../tools/dlmm.js";
import { getTrackedPosition } from "../../state.js";
import { getPerformanceHistory } from "../../lessons.js";
import { recallForPool } from "../../pool-memory.js";

const STATE_FILE = repoPath("state.json");

function loadStateFile() {
  if (!fs.existsSync(STATE_FILE)) return { positions: {} };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { positions: {} }; }
}

export async function registerPositionsRoutes(app) {
  // Live on-chain snapshot (uses bot's 5-min cache by default; ?force=true bypasses)
  app.get("/positions/open", async (req) => {
    const force = req.query?.force === "true";
    const result = await getMyPositions({ force, silent: true }).catch((e) => ({ error: e.message, positions: [] }));
    return {
      ts: new Date().toISOString(),
      positions: (result.positions || []).map((p) => ({
        ...p,
        recall: recallForPool(p.pool),
      })),
      total_value_usd: result.total_value_usd ?? null,
      total_unclaimed_fees_usd: result.total_unclaimed_fees_usd ?? null,
      error: result.error ?? null,
    };
  });

  // Local state (closed positions are only here, not on-chain)
  app.get("/positions/history", async (req) => {
    const limit = Math.min(500, Number(req.query?.limit ?? 100));
    const offset = Math.max(0, Number(req.query?.offset ?? 0));
    const since = req.query?.since ? new Date(req.query.since).getTime() : 0;

    const state = loadStateFile();
    const closed = Object.values(state.positions || {})
      .filter((p) => p.closed)
      .filter((p) => !since || new Date(p.closed_at).getTime() >= since)
      .sort((a, b) => new Date(b.closed_at).getTime() - new Date(a.closed_at).getTime());

    return {
      total: closed.length,
      offset,
      limit,
      positions: closed.slice(offset, offset + limit),
    };
  });

  // Single position (tries open first, falls back to closed history)
  app.get("/positions/:address", async (req) => {
    const { address } = req.params;
    const tracked = getTrackedPosition(address);
    if (!tracked) {
      return Object.assign({}, { not_found: true, address });
    }
    return {
      position: tracked,
      pool_memory: recallForPool(tracked.pool),
      recent_performance: getPerformanceHistory({ hours: 24 * 7, limit: 50 })
        .filter((p) => p.position === address)
        .slice(0, 20),
    };
  });
}
