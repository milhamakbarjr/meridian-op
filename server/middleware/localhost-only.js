/**
 * Fastify preHandler that rejects requests not originating from localhost.
 * The bot listens on 127.0.0.1 only, but this provides defense-in-depth in
 * case the user binds to 0.0.0.0 by accident.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function localhostOnly(request, reply, done) {
  const ip = request.ip || request.socket?.remoteAddress;
  if (!LOOPBACK.has(ip)) {
    reply.code(403).send({ error: "forbidden", reason: "localhost-only" });
    return;
  }
  done();
}
