/**
 * Human slash commands for dsh-jev:
 * - /jev status: View Jev configuration, session stats, and active tool/skill counts
 * - /jev test [prompt]: Run smoke test or dynamic evaluation on a prompt
 * - /jev skills [query]: Semantically search and rank available skills using Jev
 * - /jev tools [query]: Semantically search and rank available tools using Jev
 * - /jev auto [on|off]: Toggle automatic skill suggestion on each user prompt
 * - /jev help: Display usage guide
 */

import { findSkills, getAvailableSkills } from "./skills.js";
import { findTools, getAvailableTools } from "./tool-router.js";

export const JEV_COMMAND_USAGE = [
  "Available options:",
  "  /jev status           View Jev configuration, session metrics, and tool/skill counts",
  "  /jev test [prompt]    Run connectivity test or evaluate a prompt with Jev",
  "  /jev skills [query]   Semantically discover matching skills in the session",
  "  /jev tools [query]    Semantically discover matching tools in the session",
  "  /jev auto [on|off]    Toggle automatic per-prompt skill suggestions",
  "  /jev help             Show this help message",
].join("\n");

/**
 * Execute a Jev slash command or text prompt equivalent.
 * @param {string} rawInput
 * @param {object} [env]
 * @returns {Promise<{ kind: "success" | "error", text: string }>}
 */
export async function executeJevCommand(rawInput, { ctx, agent, jevClient, autoController, signal } = {}) {
  const cleanInput = (rawInput || "").trim().replace(/^\/jev\s*/i, "");
  const tokens = cleanInput.split(/\s+/).filter(Boolean);
  const sub = (tokens[0] || "").toLowerCase();
  const rest = tokens.slice(1).join(" ");

  if (sub === "status" || sub === "") {
    const origin = jevClient?.getKeyOrigin?.();
    const availableTools = ctx ? getAvailableTools(ctx, agent) : [];
    const availableSkills = ctx ? await getAvailableSkills(ctx, agent, signal).catch(() => []) : [];

    const statusLines = [
      "=== TypeSafe Jev System One Status ===",
      `• Configured: ${origin ? `Yes (from ${origin})` : "No (set TYPESAFE_API_KEY)"}`,
      `• Default Model: ${jevClient?.defaultModel || "jev-latest"}`,
      `• API Endpoint: ${jevClient?.baseURL || "https://api.typesafe.ai"}`,
      `• Session Requests: ${jevClient?.stats?.requestsCount || 0}`,
      `• Total Tokens: ${jevClient?.stats?.totalTokens || 0} (outputs are free - Jev does not generate text)`,
      `• Last Latency: ${jevClient?.stats?.lastElapsedMs || 0}ms`,
      `• Auto Mode: ${autoController?.enabled ? "ON" : "OFF"}`,
      `• Available Tools: ${availableTools.length}`,
      `• Available Skills: ${availableSkills.length}`,
    ];
    if (jevClient?.stats?.lastError) {
      statusLines.push(`• Last Error: ${jevClient.stats.lastError}`);
    }
    return { kind: "success", text: statusLines.join("\n") };
  }

  if (sub === "help") {
    return { kind: "success", text: JEV_COMMAND_USAGE };
  }

  if (sub === "test" || sub === "eval" || sub === "evaluate") {
    if (!jevClient || !jevClient.isConfigured()) {
      return {
        kind: "error",
        text: "Cannot run evaluation: TypeSafe API key is not configured. Set TYPESAFE_API_KEY environment variable or write ~/.dsh/secrets/typesafe_api_key.",
      };
    }

    let request;
    if (rest) {
      request = {
        state: rest,
        questions: {
          relevance: {
            type: "noul",
            instructions: "Is this prompt related to software engineering or code modification?",
          },
          intent: {
            type: "choice",
            instructions: "What is the primary intent of this prompt?",
            criteria: {
              code_fix: "Fix a bug or error in code",
              feature_add: "Implement a new feature or capability",
              question: "General technical question or explanation",
              refactor: "Refactor or reorganize existing code",
            },
          },
          complexity: {
            type: "score",
            instructions: "Estimate the complexity of accomplishing this task.",
            criteria: ["trivial", "moderate", "complex", "architectural"],
          },
        },
      };
    } else {
      request = {
        state: "Payment processing service returned HTTP 500 during checkout.",
        questions: {
          is_incident: {
            type: "noul",
            instructions: "Does this message report an operational or production incident?",
          },
          category: {
            type: "choice",
            instructions: "Which subsystem is responsible for this issue?",
            criteria: {
              payments: "Payments gateway or transaction processor",
              database: "Database connection or persistence error",
              network: "DNS or external routing failure",
            },
          },
          severity: {
            type: "score",
            instructions: "How severe is this issue for end users?",
            criteria: ["low", "medium", "high", "critical"],
          },
        },
      };
    }

    try {
      const res = await jevClient.evaluate(request, signal);
      const lines = [
        `Jev Evaluation Successful (${res.model}, ${res.elapsedMs}ms):`,
        `State: "${typeof request.state === "string" ? request.state : JSON.stringify(request.state)}"`,
      ];
      for (const [id, ans] of Object.entries(res.answers)) {
        if (ans.type === "noul") {
          lines.push(`  • ${id}: ${ans.value} (yes prob: ${(Number(ans.value) * 100).toFixed(0)}%)`);
        } else if (ans.type === "choice") {
          const conf = ans.confidence !== undefined ? ` [conf: ${ans.confidence}]` : "";
          lines.push(`  • ${id}: "${ans.value}"${conf}`);
        } else if (ans.type === "score") {
          const conf = ans.confidence !== undefined ? ` [conf: ${ans.confidence}]` : "";
          lines.push(`  • ${id}: ${ans.value}${conf}`);
        } else {
          lines.push(`  • ${id}: ${JSON.stringify(ans.value ?? ans)}`);
        }
      }
      if (res.usage) {
        lines.push(`Tokens: ${res.usage.input_tokens || 0} in / ${res.usage.output_tokens || 0} out`);
      }
      return { kind: "success", text: lines.join("\n") };
    } catch (err) {
      return { kind: "error", text: `Jev Evaluation Failed: ${err.message || String(err)}` };
    }
  }

  if (sub === "skills" || sub === "skill") {
    const query = rest;
    if (!query) {
      const available = ctx ? await getAvailableSkills(ctx, agent, signal).catch(() => []) : [];
      if (available.length === 0) {
        return { kind: "success", text: "No skills currently registered in session." };
      }
      const lines = [
        `Registered Skills (${available.length}):`,
        ...available.map((s) => `  • ${s.name}: ${s.description.slice(0, 100)}`),
      ];
      return { kind: "success", text: lines.join("\n") };
    }

    const res = await findSkills({
      query,
      ctx,
      agent,
      jevClient,
      signal,
    });

    if (res.recommended.length === 0) {
      return { kind: "success", text: `No skills matched "${query}".` };
    }

    const lines = [
      `Matching Skills for "${query}" (${res.elapsedMs}ms):`,
      ...res.recommended.map((r) => `  • /skill:${r.name} (P=${r.probability.toFixed(2)}) - ${r.description}`),
    ];
    if (res.fallbackUsed) {
      lines.push("(Note: Jev unconfigured/offline - local heuristic ranking used)");
    }
    return { kind: "success", text: lines.join("\n") };
  }

  if (sub === "tools" || sub === "tool") {
    const query = rest;
    if (!query) {
      const available = ctx ? getAvailableTools(ctx, agent) : [];
      if (available.length === 0) {
        return { kind: "success", text: "No tools currently registered in session." };
      }
      const lines = [
        `Registered Tools (${available.length}):`,
        ...available.map((t) => `  • ${t.name}: ${t.description.slice(0, 80)}`),
      ];
      return { kind: "success", text: lines.join("\n") };
    }

    const res = await findTools({
      query,
      ctx,
      agent,
      jevClient,
      signal,
    });

    if (res.recommended.length === 0) {
      return { kind: "success", text: `No tools matched "${query}".` };
    }

    const lines = [
      `Matching Tools for "${query}" (${res.elapsedMs}ms):`,
      ...res.recommended.map((r) => `  • ${r.name} (P=${r.probability.toFixed(2)}): ${r.description}`),
    ];
    if (res.fallbackUsed) {
      lines.push("(Note: Jev unconfigured/offline - local heuristic ranking used)");
    }
    return { kind: "success", text: lines.join("\n") };
  }

  if (sub === "auto") {
    const arg = rest.toLowerCase();
    if (arg !== "" && arg !== "on" && arg !== "off") {
      return { kind: "error", text: `Invalid argument for /jev auto: "${rest}". Use: /jev auto on or /jev auto off` };
    }
    const newState = arg === "on" ? true : arg === "off" ? false : !autoController?.enabled;
    if (autoController) {
      autoController.enabled = newState;
    }
    return {
      kind: "success",
      text: newState
        ? "Jev Auto Mode enabled: Jev will semantically discover and recommend matching skills before each prompt."
        : "Jev Auto Mode disabled.",
    };
  }

  return { kind: "error", text: `Unknown command /jev ${sub}.\n${JEV_COMMAND_USAGE}` };
}

export function registerJevCommands(ctx, jevClient, autoController) {
  if (!ctx.commands || typeof ctx.commands.register !== "function") return null;

  return ctx.commands.register({
    name: "jev",
    description: "TypeSafe Jev System One integration (status, test, skills, tools, auto)",
    input: { hint: "status | test [prompt] | skills [query] | tools [query] | auto [on|off] | help" },
    handler: async (invocation) => {
      return executeJevCommand(invocation.rawInput, {
        ctx,
        agent: invocation.agent,
        jevClient,
        autoController,
        signal: invocation.signal,
      });
    },
  });
}
