import fs from "node:fs";
import { repoPath } from "../../repo-root.js";
import { getHiveMindPullMode, isHiveMindEnabled } from "../../hivemind.js";

const CACHE_FILE = repoPath("hivemind-cache.json");

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return null; }
}

export async function registerHivemindRoutes(app) {
  app.get("/hivemind/status", async () => {
    const cache = loadCache();
    return {
      enabled: isHiveMindEnabled(),
      pull_mode: getHiveMindPullMode(),
      cache: cache
        ? {
            pulled_at: cache.pulledAt,
            shared_lessons_count: (cache.sharedLessons || []).length,
            presets_count: (cache.presets || []).length,
          }
        : null,
    };
  });
}
