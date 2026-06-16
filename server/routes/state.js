import { config } from "../../config.js";
import { getStateSummary, getTrackedPositions } from "../../state.js";
import { getPerformanceSummary } from "../../lessons.js";
import { bus } from "../bus.js";

/**
 * `/state/*` routes — cheap snapshots derived from local JSON state and live
 * cycle timers. No on-chain calls here; for that, see `/positions/open` which
 * forces a fresh getMyPositions().
 */
export async function registerStateRoutes(app) {
  app.get("/state/summary", async () => {
    const stateSummary = getStateSummary();
    const tracked = getTrackedPositions(true);
    const perf = getPerformanceSummary();

    return {
      server: {
        seq: bus.currentSeq(),
        started_at: _startedAt,
        version: "1.0.0",
      },
      bot: {
        dry_run: process.env.DRY_RUN === "true",
        paused: false, // wired in Phase D
      },
      cycles: {
        management_interval_min: config.schedule.managementIntervalMin,
        screening_interval_min: config.schedule.screeningIntervalMin,
        pnl_poll_interval_sec: config.pnl?.pollIntervalSec ?? 3,
      },
      positions: {
        open: tracked.length,
        closed: stateSummary.closed_positions,
        max: config.risk.maxPositions,
      },
      performance: perf || null,
      state: {
        last_updated: stateSummary.last_updated,
        recent_events: stateSummary.recent_events,
      },
    };
  });
}

const _startedAt = new Date().toISOString();
