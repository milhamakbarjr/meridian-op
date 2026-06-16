import fs from "node:fs";
import { repoPath } from "../../repo-root.js";

const DECISION_LOG_FILE = repoPath("decision-log.json");

function loadDecisions() {
  if (!fs.existsSync(DECISION_LOG_FILE)) return { decisions: [] };
  try { return JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8")); } catch { return { decisions: [] }; }
}

export async function registerDecisionsRoutes(app) {
  app.get("/decisions", async (req) => {
    const limit = Math.min(500, Number(req.query?.limit ?? 100));
    const type = req.query?.type || null;
    const actor = req.query?.actor || null;
    const since = req.query?.since ? new Date(req.query.since).getTime() : 0;

    const all = loadDecisions().decisions || [];
    const filtered = all
      .filter((d) => !type || d.type === type)
      .filter((d) => !actor || d.actor === actor)
      .filter((d) => !since || new Date(d.ts).getTime() >= since)
      .slice(0, limit);

    return { total: all.length, returned: filtered.length, decisions: filtered };
  });

  app.get("/decisions/:id", async (req) => {
    const decisions = loadDecisions().decisions || [];
    const entry = decisions.find((d) => d.id === req.params.id);
    if (!entry) return { not_found: true, id: req.params.id };
    return { decision: entry };
  });
}
