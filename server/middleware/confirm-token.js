import crypto from "node:crypto";

/**
 * Two-step confirmation. Client first calls a mutation endpoint without a
 * confirm token; we return a summary + token. Client re-calls with the
 * token in X-Confirm-Token to actually execute. Tokens are one-shot, 60s TTL.
 */
const TTL_MS = 60 * 1000;
const pending = new Map(); // token -> { expires, action, payload }

function gc() {
  const now = Date.now();
  for (const [k, v] of pending.entries()) {
    if (v.expires < now) pending.delete(k);
  }
}

setInterval(gc, 30_000).unref();

export function issueConfirmToken({ action, payload, summary }) {
  const token = `ct_${crypto.randomBytes(12).toString("hex")}`;
  pending.set(token, { expires: Date.now() + TTL_MS, action, payload });
  return { pending: true, confirm_token: token, expires_in_sec: 60, summary };
}

/**
 * If client supplied X-Confirm-Token, validate it matches the action + return
 * the original payload (for the handler to execute against). Otherwise returns
 * null — handler should issue a token.
 */
export function consumeConfirmToken(req, expectedAction) {
  const token = req.headers["x-confirm-token"];
  if (!token) return null;
  const entry = pending.get(token);
  if (!entry || entry.expires < Date.now()) return { error: "invalid_or_expired_token" };
  if (entry.action !== expectedAction) return { error: "token_action_mismatch" };
  pending.delete(token); // one-shot
  return { payload: entry.payload };
}
