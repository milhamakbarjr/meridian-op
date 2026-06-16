import fs from "node:fs";
import { repoPath } from "../../repo-root.js";
import { listLessons, getPerformanceHistory, getPerformanceSummary } from "../../lessons.js";

const LESSONS_FILE = repoPath("lessons.json");

function loadLessonsFile() {
  if (!fs.existsSync(LESSONS_FILE)) return { lessons: [], performance: [] };
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")); } catch { return { lessons: [], performance: [] }; }
}

export async function registerLessonsRoutes(app) {
  app.get("/lessons", async (req) => {
    const role = req.query?.role || null;
    const pinned = req.query?.pinned === "true" ? true : req.query?.pinned === "false" ? false : null;
    const tag = req.query?.tag || null;
    const limit = Math.min(500, Number(req.query?.limit ?? 100));

    const result = listLessons({ role, pinned, tag, limit });
    const file = loadLessonsFile();
    return {
      total: (file.lessons || []).length,
      returned: result.lessons.length,
      lessons: result.lessons,
    };
  });

  app.get("/performance", async (req) => {
    const hours = Math.min(24 * 365, Number(req.query?.hours ?? 24 * 7));
    const limit = Math.min(2000, Number(req.query?.limit ?? 500));
    return {
      window_hours: hours,
      performance: getPerformanceHistory({ hours, limit }),
    };
  });

  app.get("/performance/summary", async () => ({
    summary: getPerformanceSummary() || null,
  }));

  // Cumulative equity curve derived from the closed-position performance log.
  // Each point: { ts, cumulative_pnl_usd, cumulative_fees_usd, closed_position }
  app.get("/performance/equity-curve", async (req) => {
    const hours = Math.min(24 * 365, Number(req.query?.hours ?? 24 * 30));
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const perf = (loadLessonsFile().performance || [])
      .filter((p) => p.recorded_at && new Date(p.recorded_at).getTime() >= cutoff)
      .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());

    let cumPnl = 0;
    let cumFees = 0;
    const series = perf.map((p) => {
      cumPnl += p.pnl_usd || 0;
      cumFees += p.fees_earned_usd || 0;
      return {
        ts: p.recorded_at,
        pnl_usd: p.pnl_usd || 0,
        fees_earned_usd: p.fees_earned_usd || 0,
        cumulative_pnl_usd: Math.round(cumPnl * 1000) / 1000,
        cumulative_fees_usd: Math.round(cumFees * 1000) / 1000,
        pool_name: p.pool_name,
        close_reason: p.close_reason,
      };
    });

    return { window_hours: hours, points: series.length, series };
  });
}
