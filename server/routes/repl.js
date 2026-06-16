import crypto from "node:crypto";
import { agentLoop } from "../../agent.js";
import { config } from "../../config.js";
import { bus } from "../bus.js";

/**
 * POST /repl — start a free-form GENERAL-agent conversation. Returns a session
 * id immediately; the agent runs in the background and streams its tool calls
 * and final response over WebSocket as `repl_*` events tagged with the session id.
 *
 * Body: { goal: string, agent_type?: "GENERAL"|"SCREENER"|"MANAGER", max_steps?: number }
 *
 * WS events emitted under the session:
 *   repl_started        { repl_session_id, agent_type, goal }
 *   repl_tool_start     { repl_session_id, tool }
 *   repl_tool_finish    { repl_session_id, tool, success }
 *   repl_message        { repl_session_id, content }    // final assistant text
 *   repl_finished       { repl_session_id, success, duration_ms }
 */
export async function registerReplRoutes(app) {
  app.post("/repl", async (req, reply) => {
    const { goal, agent_type = "GENERAL", max_steps } = req.body || {};
    if (!goal || typeof goal !== "string") {
      reply.code(400);
      return { error: "missing_goal" };
    }
    if (!["GENERAL", "SCREENER", "MANAGER"].includes(agent_type)) {
      reply.code(400);
      return { error: "invalid_agent_type" };
    }

    const repl_session_id = `repl_${crypto.randomBytes(8).toString("hex")}`;
    const start = Date.now();
    bus.publish("repl_started", { repl_session_id, agent_type, goal: goal.slice(0, 500) });

    // Fire-and-forget; the client receives progress over WS
    (async () => {
      try {
        const steps = Math.min(20, Math.max(1, Number(max_steps ?? config.llm.maxSteps)));
        const result = await agentLoop(
          goal,
          steps,
          [],
          agent_type,
          null,
          null,
          {
            onToolStart: async ({ name }) => {
              bus.publish("repl_tool_start", { repl_session_id, tool: name });
            },
            onToolFinish: async ({ name, success }) => {
              bus.publish("repl_tool_finish", { repl_session_id, tool: name, success });
            },
          },
        );
        bus.publish("repl_message", { repl_session_id, content: (result?.content || "").slice(0, 8000) });
        bus.publish("repl_finished", { repl_session_id, success: true, duration_ms: Date.now() - start });
      } catch (e) {
        bus.publish("repl_finished", { repl_session_id, success: false, error: e.message, duration_ms: Date.now() - start });
      }
    })();

    return { ok: true, repl_session_id, agent_type, started_at: new Date().toISOString() };
  });
}
