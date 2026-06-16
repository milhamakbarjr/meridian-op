/**
 * POST endpoints that trigger the bot's existing screening/management cycles
 * on demand. They return immediately with an accepted: true and let the cycle
 * stream progress over WS.
 */
import { idempotent } from "../middleware/idempotency.js";

let _runManagementCycle = null;
let _runScreeningCycle = null;

/** Wire from index.js at startup so we don't create a circular import. */
export function registerCycleRunners({ runManagementCycle, runScreeningCycle }) {
  _runManagementCycle = runManagementCycle;
  _runScreeningCycle = runScreeningCycle;
}

export async function registerCyclesRoutes(app) {
  app.post("/management/run", idempotent(async () => {
    if (!_runManagementCycle) return { error: "not_wired" };
    _runManagementCycle({ silent: true }).catch(() => {});
    return { ok: true, accepted: true, cycle: "management" };
  }));

  app.post("/screening/run", idempotent(async () => {
    if (!_runScreeningCycle) return { error: "not_wired" };
    _runScreeningCycle({ silent: true }).catch(() => {});
    return { ok: true, accepted: true, cycle: "screening" };
  }));
}
