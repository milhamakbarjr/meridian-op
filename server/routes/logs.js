import fs from "node:fs";
import path from "node:path";
import { repoPath } from "../../repo-root.js";

const LOGS_DIR = repoPath("logs");

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveLogFile(name) {
  const resolved = fs.realpathSync.native
    ? fs.realpathSync(path.join(LOGS_DIR, name))
    : path.resolve(LOGS_DIR, name);
  const root = fs.existsSync(LOGS_DIR) ? fs.realpathSync(LOGS_DIR) : LOGS_DIR;
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("path escape");
  }
  return resolved;
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
    if (!DATE_RE.test(date)) return { error: "invalid date" };
    let file;
    try { file = resolveLogFile(`agent-${date}.log`); }
    catch { return { error: "invalid date" }; }
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
    if (!DATE_RE.test(date)) return { error: "invalid date" };
    let file;
    try { file = resolveLogFile(`actions-${date}.jsonl`); }
    catch { return { error: "invalid date" }; }
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
