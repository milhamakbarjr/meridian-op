import Fastify from "fastify";
import cors from "@fastify/cors";
import { log } from "../logger.js";
import { localhostOnly } from "./middleware/localhost-only.js";
import { bus } from "./bus.js";

import { registerStateRoutes } from "./routes/state.js";

/**
 * Start the dashboard HTTP/WS server. Idempotent — multiple calls return the
 * same instance. Designed to be invoked lazily from index.js only when the
 * DASHBOARD_ENABLED env flag is set, so the bot can run with zero overhead
 * when the dashboard isn't in use.
 */
let _instance = null;

export async function startServer({ port = 7474, host = "127.0.0.1", origin = "http://localhost:3000" } = {}) {
  if (_instance) return _instance;

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
  });

  await app.register(cors, {
    origin: [origin, "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173"],
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Idempotency-Key", "X-Confirm-Token"],
  });

  // Lock all routes to loopback origin
  app.addHook("preHandler", localhostOnly);

  // Liveness probe — no auth, no route prefix
  app.get("/healthz", async () => ({ ok: true, ts: new Date().toISOString(), seq: bus.currentSeq() }));

  // Versioned API routes
  await app.register(
    async (instance) => {
      await registerStateRoutes(instance);
    },
    { prefix: "/api/v1" },
  );

  try {
    await app.listen({ port, host });
    log("dashboard", `Listening on http://${host}:${port}`);
    _instance = app;
    return app;
  } catch (err) {
    log("dashboard_warn", `Failed to bind ${host}:${port} — ${err.message}`);
    throw err;
  }
}

export async function stopServer() {
  if (_instance) {
    await _instance.close();
    _instance = null;
  }
}
