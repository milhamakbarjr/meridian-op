import fs from "node:fs";
import { repoPath } from "../../repo-root.js";
import { redactObject } from "../lib/redact.js";

const USER_CONFIG_FILE = repoPath("user-config.json");

function loadUserConfig() {
  if (!fs.existsSync(USER_CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USER_CONFIG_FILE, "utf8")); } catch { return {}; }
}

export async function registerConfigRoutes(app) {
  // Current settings — sensitive values masked
  app.get("/config", async () => {
    const raw = loadUserConfig();
    return {
      config: redactObject(raw),
      last_evolved: raw._lastEvolved || null,
      last_agent_tune: raw._lastAgentTune || null,
    };
  });

  // Schema lookup for the dashboard's settings UI (which keys exist, what type, what section)
  // For Phase B we serve the example config as a template; richer per-key metadata
  // can be added once the dashboard needs it.
  app.get("/config/schema", async () => {
    const examplePath = repoPath("user-config.example.json");
    if (!fs.existsSync(examplePath)) return { schema: {} };
    try {
      const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
      return {
        schema: Object.entries(example).map(([key, defaultValue]) => ({
          key,
          default: defaultValue,
          type: typeof defaultValue === "boolean" ? "boolean"
            : typeof defaultValue === "number" ? "number"
            : Array.isArray(defaultValue) ? "array"
            : typeof defaultValue === "object" ? "object"
            : "string",
        })),
      };
    } catch {
      return { schema: [] };
    }
  });
}
