import fastifyWebsocket from "@fastify/websocket";
import { bus } from "../bus.js";
import { log } from "../../logger.js";

/**
 * WebSocket fan-out. One subscription to `bus` at server start; every
 * connected client gets every frame. Clients can `subscribe`/`unsubscribe`
 * to filter, but the default is firehose.
 *
 * Frame shape (set by bus.publish):
 *   { type: string, ts: ISO8601, seq: number, data: object }
 *
 * Client → server messages (JSON, one per line):
 *   { type: "ping" }                                  → { type: "pong", ts, seq }
 *   { type: "subscribe",   types: ["pnl_tick", ...] } → echoes the filter
 *   { type: "unsubscribe", types: [...] }
 *   anything else                                      → ignored
 */
export async function registerWsRoutes(app) {
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1_048_576 },
  });

  const clients = new Set();

  // Single bus subscription, fans to all clients
  bus.on("event", (frame) => {
    if (clients.size === 0) return;
    const payload = JSON.stringify(frame);
    for (const client of clients) {
      const filter = client.__filter;
      if (filter && !filter.has(frame.type)) continue;
      try {
        if (client.readyState === 1) client.send(payload);
      } catch (e) {
        // Best-effort; drop on failure (close handler will remove)
      }
    }
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    clients.add(socket);
    socket.__filter = null;

    // Hello frame on connect — includes current seq so client can detect gaps if it reconnects
    try {
      socket.send(JSON.stringify({
        type: "hello",
        ts: new Date().toISOString(),
        seq: bus.currentSeq(),
        data: {
          server_version: "1.0.0",
          dry_run: process.env.DRY_RUN === "true",
        },
      }));
    } catch { /* swallow */ }

    // Periodic server ping (auto-pong by the client lib; this is a JSON heartbeat for the app layer)
    const heartbeat = setInterval(() => {
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "heartbeat", ts: new Date().toISOString(), seq: bus.currentSeq(), data: {} }));
        }
      } catch { /* swallow */ }
    }, 30_000);

    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "ping") {
        try {
          socket.send(JSON.stringify({ type: "pong", ts: new Date().toISOString(), seq: bus.currentSeq(), data: {} }));
        } catch { /* swallow */ }
      } else if (msg.type === "subscribe" && Array.isArray(msg.types)) {
        socket.__filter = new Set(msg.types.filter((t) => typeof t === "string"));
      } else if (msg.type === "unsubscribe") {
        socket.__filter = null;
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(socket);
    });

    socket.on("error", () => {
      clearInterval(heartbeat);
      clients.delete(socket);
    });
  });

  log("dashboard", "WebSocket endpoint registered at /ws");
}
