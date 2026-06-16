import { closePosition, claimFees, getMyPositions } from "../../tools/dlmm.js";
import { swapToken } from "../../tools/wallet.js";
import { setPositionInstruction, getTrackedPosition } from "../../state.js";
import { addPoolNote } from "../../pool-memory.js";
import { executeTool } from "../../tools/executor.js";
import { idempotent } from "../middleware/idempotency.js";
import { issueConfirmToken, consumeConfirmToken } from "../middleware/confirm-token.js";
import { bus } from "../bus.js";

/**
 * Cooperative pause flag. The cron entries in index.js read this on each tick.
 * Set/cleared by /control/pause + /control/resume.
 */
const pauseState = {
  paused: false,
  reason: null,
  since: null,
};

export function isPaused() {
  return pauseState.paused;
}

export function getPauseState() {
  return { ...pauseState };
}

export async function registerControlRoutes(app) {
  // ── Pause / Resume ─────────────────────────────────────────────
  app.post("/control/pause", { preHandler: paramValidator(["reason"]) }, async (req) => {
    const { reason } = req.body || {};
    pauseState.paused = true;
    pauseState.reason = reason || "manual";
    pauseState.since = new Date().toISOString();
    bus.publish("paused", { reason: pauseState.reason, by: "dashboard" });
    return { ok: true, paused: true, since: pauseState.since };
  });

  app.post("/control/resume", async () => {
    pauseState.paused = false;
    pauseState.reason = null;
    pauseState.since = null;
    bus.publish("resumed", { by: "dashboard" });
    return { ok: true, paused: false };
  });

  app.get("/control/status", async () => ({ pause: pauseState }));

  // ── Position instruction (notes) ───────────────────────────────
  app.post("/control/set-instruction", { preHandler: paramValidator(["position_address", "instruction"]) }, async (req) => {
    const { position_address, instruction } = req.body || {};
    const ok = setPositionInstruction(position_address, instruction);
    if (!ok) return { error: "position_not_found", position_address };
    bus.publish("instruction_set", { position: position_address, instruction });
    return { ok: true, position: position_address, instruction };
  });

  app.post("/control/clear-instruction", { preHandler: paramValidator(["position_address"]) }, async (req) => {
    const { position_address } = req.body || {};
    const ok = setPositionInstruction(position_address, null);
    if (!ok) return { error: "position_not_found", position_address };
    bus.publish("instruction_cleared", { position: position_address });
    return { ok: true, position: position_address };
  });

  // ── Pool memory annotation ─────────────────────────────────────
  app.post("/pools/:address/note", { preHandler: paramValidator([]) }, async (req) => {
    const { note } = req.body || {};
    if (!note) return { error: "missing_note" };
    addPoolNote({ pool_address: req.params.address, note: String(note).slice(0, 280) });
    return { ok: true };
  });

  // ── Close position (two-step + idempotent) ─────────────────────
  app.post("/control/close-position", { preHandler: paramValidator(["position_address"]) },
    idempotent(async (req) => {
      const { position_address, reason = "Manual close from dashboard", skip_swap = false } = req.body || {};

      const confirm = consumeConfirmToken(req, "close_position");
      if (confirm?.error) return { error: confirm.error };
      if (!confirm) {
        const pos = getTrackedPosition(position_address);
        if (!pos) return { error: "position_not_found", position_address };
        return issueConfirmToken({
          action: "close_position",
          payload: { position_address, reason, skip_swap },
          summary: {
            action: "close_position",
            position: position_address,
            pool_name: pos.pool_name,
            strategy: pos.strategy,
            deployed_at: pos.deployed_at,
            peak_pnl_pct: pos.peak_pnl_pct,
            warnings: [],
          },
        });
      }

      bus.publish("close_start", { position: position_address, reason, source: "dashboard" });
      const result = await closePosition({ position_address: confirm.payload.position_address, reason: confirm.payload.reason }).catch((e) => ({ error: e.message }));
      return { ok: !result.error, result };
    }),
  );

  // ── Claim fees (two-step + idempotent) ─────────────────────────
  app.post("/control/claim-fees", { preHandler: paramValidator(["position_address"]) },
    idempotent(async (req) => {
      const { position_address } = req.body || {};
      const confirm = consumeConfirmToken(req, "claim_fees");
      if (confirm?.error) return { error: confirm.error };
      if (!confirm) {
        const pos = getTrackedPosition(position_address);
        if (!pos) return { error: "position_not_found" };
        return issueConfirmToken({
          action: "claim_fees",
          payload: { position_address },
          summary: { action: "claim_fees", position: position_address, pool_name: pos.pool_name },
        });
      }
      bus.publish("claim_start", { position: position_address, source: "dashboard" });
      const result = await claimFees({ position_address: confirm.payload.position_address }).catch((e) => ({ error: e.message }));
      return { ok: !result.error, result };
    }),
  );

  // ── Swap (two-step + idempotent) ───────────────────────────────
  app.post("/control/swap-token", { preHandler: paramValidator(["input_mint", "output_mint", "amount"]) },
    idempotent(async (req) => {
      const body = req.body || {};
      const confirm = consumeConfirmToken(req, "swap_token");
      if (confirm?.error) return { error: confirm.error };
      if (!confirm) {
        return issueConfirmToken({
          action: "swap_token",
          payload: body,
          summary: { action: "swap_token", input: body.input_mint, output: body.output_mint, amount: body.amount },
        });
      }
      bus.publish("swap_start", { input_mint: body.input_mint, output_mint: body.output_mint, amount: body.amount, source: "dashboard" });
      const result = await swapToken(confirm.payload).catch((e) => ({ error: e.message }));
      return { ok: !result.error, result };
    }),
  );

  // ── update_config — proxies through the bot's existing tool ────
  app.put("/config", { preHandler: paramValidator(["updates"]) },
    idempotent(async (req) => {
      const { updates, reason = "From dashboard" } = req.body || {};
      const confirm = consumeConfirmToken(req, "update_config");
      if (confirm?.error) return { error: confirm.error };
      if (!confirm) {
        return issueConfirmToken({
          action: "update_config",
          payload: { updates, reason },
          summary: { action: "update_config", keys: Object.keys(updates || {}), reason },
        });
      }
      const result = await executeTool("update_config", { ...confirm.payload.updates, reason: confirm.payload.reason }).catch((e) => ({ error: e.message }));
      bus.publish("config_changed", { applied: result?.applied || {}, reason: confirm.payload.reason, source: "dashboard" });
      return { ok: !result?.error, result };
    }),
  );
}

// ── helpers ─────────────────────────────────────────────────────
function paramValidator(required) {
  return async (req, reply) => {
    if (req.method !== "POST" && req.method !== "PUT") return;
    const body = req.body || {};
    const missing = required.filter((k) => body[k] == null);
    if (missing.length > 0) {
      reply.code(400).send({ error: "missing_params", missing });
      return reply;
    }
  };
}
