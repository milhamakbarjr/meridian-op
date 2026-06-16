import fs from "node:fs";
import path from "node:path";
import { repoPath } from "../../repo-root.js";

const LOGS_DIR = repoPath("logs");

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function tailFile(filepath, maxLines) {
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  return lines.slice(-maxLines);
}

export async function registerLogsRoutes(app) {
  // Today's plain log file
  app.get("/logs/today", async (req) => {
    const lines = Math.min(1000, Number(req.query?.lines ?? 200));
    const level = req.query?.level || null;
    const date = req.query?.date || todayDate();
    const file = path.join(LOGS_DIR, `agent-${date}.log`);
    let tail = tailFile(file, lines * 2);
    if (level) {
      const re = new RegExp(`\\[${level.toUpperCase()}\\]`, "i");
      tail = tail.filter((l) => re.test(l));
    }
    return { date, file: path.basename(file), lines: tail.slice(-lines) };
  });

  // Audit JSONL — parsed
  app.get("/logs/actions", async (req) => {
    const lines = Math.min(2000, Number(req.query?.lines ?? 200));
    const tool = req.query?.tool || null;
    const date = req.query?.date || todayDate();
    const file = path.join(LOGS_DIR, `actions-${date}.jsonl`);
    const raw = tailFile(file, lines * 3);
    const parsed = raw
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((e) => !tool || e.tool === tool)
      .slice(-lines);
    return { date, file: path.basename(file), entries: parsed };
  });

  // List of available log dates
  app.get("/logs", async () => {
    if (!fs.existsSync(LOGS_DIR)) return { dates: [] };
    const files = fs.readdirSync(LOGS_DIR);
    const dates = [
      ...new Set(
        files
          .map((f) => f.match(/^(?:agent|actions)-(\d{4}-\d{2}-\d{2})\./)?.[1])
          .filter(Boolean),
      ),
    ].sort().reverse();
    return { dates };
  });
}
