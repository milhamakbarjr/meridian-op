/**
 * Idempotency key middleware. Clients pass `X-Idempotency-Key: <uuid>` on
 * mutation requests; if the same key is replayed within the TTL window, the
 * cached response is returned instead of re-executing the handler. Prevents
 * the "double-click closes twice" footgun.
 */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { expires, response }

function gc() {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (v.expires < now) cache.delete(k);
  }
}

setInterval(gc, 60_000).unref();

/**
 * Wraps a route handler with idempotency-key dedup. The wrapped handler is
 * called only on first sight of a key; subsequent calls return the cached
 * JSON response.
 */
export function idempotent(handler) {
  return async (req, reply) => {
    const key = req.headers["x-idempotency-key"];
    if (!key) {
      return reply.code(400).send({ error: "missing_idempotency_key", reason: "Mutation requires X-Idempotency-Key header" });
    }
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) {
      reply.header("X-Idempotency-Cached", "true");
      return cached.response;
    }
    const response = await handler(req, reply);
    cache.set(key, { expires: Date.now() + TTL_MS, response });
    return response;
  };
}
