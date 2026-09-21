/**
 * Human slash commands for dsh-jev and pi-typesafe:
 * - /typesafe or /jev status: View Jev configuration, session stats, spend caps, and active tool/skill counts
 * - /typesafe or /jev login [key]: Save and verify TypeSafe API key in ~/.pi/agent/pi-typesafe/auth.json
 * - /typesafe or /jev logout: Remove stored key and clear auth state
 * - /typesafe or /jev enable: Enable TypeSafe evaluation tool calls
 * - /typesafe or /jev disable: Disable TypeSafe evaluation tool calls
 * - /typesafe or /jev test [prompt]: Run sample bug-triage evaluation or evaluate custom prompt
 * - /typesafe or /jev playground [json]: Directly evaluate custom state & typed questions JSON
 * - /typesafe or /jev skills [query]: Semantically search and rank available skills using Jev
 * - /typesafe or /jev tools [query]: Semantically search and rank available tools using Jev
 * - /typesafe or /jev auto [on|off]: Toggle automatic skill suggestion on each user prompt
 * - /typesafe or /jev calibrate: Threshold calibration toolkit for historical samples
 * - /typesafe or /jev help: Display usage guide
 */

import { findSkills, getAvailableSkills } from "./skills.js";
import { findTools, getAvailableTools } from "./tool-router.js";
import { authState, describeAuth, clearAuthState } from "./auth.js";
import { storeApiKey, clearStoredApiKey, credentialsPath } from "./credentials.js";
import { calibrate, formatCalibration } from "./calibrate.js";

const SUBCOMMAND_ALIASES = {
  status: ["status", "stat", "stauts", "info", "ping", "check", "state", "version", "v", ""],
  login: ["login", "auth", "signin", "key"],
  logout: ["logout", "signout", "clear-key", "clearkey"],
  enable: ["enable", "on", "start"],
  disable: ["disable", "off", "stop"],
  test: ["test", "tset", "eval", "evaluate", "evaluation", "t", "probe", "run"],
  playground: ["playground", "play", "json"],
  skills: ["skills", "skill", "skil", "s", "find-skill", "findskill", "find-skills", "findskills"],
  tools: ["tools", "tool", "tol", "tols", "find-tools", "findtools", "find-tool", "findtool"],
  auto: ["auto", "toggle", "a", "aut"],
  calibrate: ["calibrate", "cal", "calibration", "tune"],
  help: ["help", "h", "?", "-h", "--help", "man", "doc", "docs"],
};

function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export function resolveSubcommand(inputSub) {
  const sub = (inputSub || "").trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(SUBCOMMAND_ALIASES)) {
    if (aliases.includes(sub)) {
      return { resolved: canonical, suggestion: null };
    }
  }

  const canonicals = Object.keys(SUBCOMMAND_ALIASES);
  let closest = null;
  let minDistance = 999;
  for (const c of canonicals) {
    const d = levenshtein(sub, c);
    if (d < minDistance) {
      minDistance = d;
      closest = c;
    }
  }

  return {
    resolved: null,
    suggestion: minDistance <= 2 ? closest : null,
  };
}

let sessionToolEnabled =
  process.env.PI_TYPESAFE_ENABLED === "1" ||
  process.env.DSH_JEV_ENABLED === "1" ||
  process.env.DSH_TYPESAFE_ENABLED === "1";

export function isTypeSafeEnabled() {
  return sessionToolEnabled;
}

export function setTypeSafeEnabled(val) {
  sessionToolEnabled = Boolean(val);
}

function getHelpText(cmdName, brand) {
  return [
    `ℹ️ [${brand} Help] TypeSafe Jev System One Slash Commands`,
    "",
    "Available commands:",
    `  /${cmdName} status           View Jev configuration, session metrics, and tool/skill counts`,
    `  /${cmdName} login [key]      Verify and save API key to ~/.pi/agent/pi-typesafe/auth.json`,
    `  /${cmdName} logout           Remove stored key and reset auth state`,
    `  /${cmdName} enable           Enable TypeSafe evaluation tool calls for this session`,
    `  /${cmdName} disable          Disable TypeSafe evaluation tool calls`,
    `  /${cmdName} test [prompt]    Run connectivity test or evaluate a prompt with Jev`,
    `  /${cmdName} playground [json] Evaluate custom state and typed questions JSON`,
    `  /${cmdName} skills [query]   Semantically discover matching skills in the session`,
    `  /${cmdName} tools [query]    Semantically discover matching tools in the session`,
    `  /${cmdName} auto [on|off]    Toggle automatic per-prompt skill suggestions`,
    `  /${cmdName} calibrate        Show threshold calibration information for historical samples`,
    `  /${cmdName} help             Show this help message`,
  ].join("\n");
}

/**
 * Execute a Jev/TypeSafe slash command or text prompt equivalent.
 * @param {string} rawInput
 * @param {object} [env]
 * @returns {Promise<{ kind: "success" | "error", text: string }>}
 */
export async function executeJevCommand(rawInput, { ctx, agent, jevClient, autoController, signal } = {}) {
  const isTypesafe = /^[\/／]?typesafe/i.test((rawInput || "").trim());
  const cmdName = isTypesafe ? "typesafe" : "jev";
  const brand = isTypesafe ? "TypeSafe" : "Jev";

  // Normalize full-width slashes, colons, and leading prefixes for /jev or /typesafe
  const cleanInput = (rawInput || "")
    .trim()
    .replace(/^[\/／]?(?:jev|typesafe)[:\s]*/i, "")
    .trim();

  const tokens = cleanInput.split(/\s+/).filter(Boolean);
  const rawSub = tokens[0] || "";
  const rest = tokens.slice(1).join(" ").trim();

  const { resolved: sub, suggestion } = resolveSubcommand(rawSub);
  const usage = getHelpText(cmdName, brand);

  if (!sub) {
    const hint = suggestion
      ? `✗ [${brand} Error] Unknown subcommand "${rawSub}". Did you mean "/${cmdName} ${suggestion}"?\n\n${usage}`
      : `✗ [${brand} Error] Unknown command: "/${cmdName} ${rawSub}".\n\n${usage}`;
    return { kind: "error", text: hint };
  }

  if (sub === "status") {
    const origin = jevClient?.getKeyOrigin?.();
    const availableTools = ctx ? getAvailableTools(ctx, agent) : [];
    const availableSkills = ctx ? await getAvailableSkills(ctx, agent, signal).catch(() => []) : [];
    const isReady = jevClient?.isConfigured?.() ?? Boolean(origin);
    const autoStatus = autoController?.enabled ? "ON" : "OFF";
    const model = jevClient?.defaultModel || "jev-latest";

    const headline = isReady
      ? `✓ [${brand} Status] Ready · Model: ${model} · ${availableSkills.length} Skills · ${availableTools.length} Tools · Auto: ${autoStatus}`
      : `⚠️ [${brand} Status] Unconfigured · Model: ${model} · Auto: ${autoStatus} (set TYPESAFE_API_KEY)`;

    const statusLines = [
      headline,
      "",
      "=== TypeSafe Jev System One Details ===",
      `• Configured: ${origin ? `Yes (from ${origin})` : "No (set TYPESAFE_API_KEY)"}`,
      `• Default Model: ${model}`,
      `• API Endpoint: ${jevClient?.baseURL || "https://api.typesafe.ai"}`,
      `• Session Requests: ${jevClient?.stats?.requestsCount || 0}`,
      `• Total Tokens: ${jevClient?.stats?.totalTokens || 0} (outputs are free - Jev does not generate text)`,
      `• Last Latency: ${jevClient?.stats?.lastElapsedMs || 0}ms`,
      `• Auto Mode: ${autoStatus}`,
      `• Available Tools (${availableTools.length}): ${availableTools.map((t) => t.name).slice(0, 5).join(", ")}${availableTools.length > 5 ? "..." : ""}`,
      `• Available Skills (${availableSkills.length}): ${availableSkills.map((s) => s.name).slice(0, 5).join(", ")}${availableSkills.length > 5 ? "..." : ""}`,
    ];

    const spend = jevClient?.getSpend?.();
    if (spend) {
      const sess = spend.session;
      statusLines.push(
        `• Session Spend: ${sess.requestsStarted}/${spend.caps.maxRequests || 20} req (${sess.requestsSucceeded} ok, ${sess.requestsFailed} err), ${sess.inputTokens} in tok (~$${sess.estimatedUsd.toFixed(4)})`
      );
      const tod = spend.today;
      statusLines.push(
        `• Today Persisted: ${tod.requestsStarted} req (${tod.requestsSucceeded} ok, ${tod.requestsFailed} err), ${tod.inputTokens} tok (~$${tod.estimatedUsd.toFixed(4)})`
      );
      if (spend.blocked) {
        statusLines.push(`⚠️ CAP REACHED: ${spend.blocked.cap} (${spend.blocked.used}/${spend.blocked.limit} on ${spend.blocked.day})`);
      }
    }

    const auth = describeAuth(authState());
    statusLines.push(`• Auth State: ${auth.text}`);

    if (jevClient?.stats?.lastError) {
      statusLines.push(`• Last Error: ${jevClient.stats.lastError}`);
    }

    return { kind: "success", text: statusLines.join("\n") };
  }

  if (sub === "help") {
    return { kind: "success", text: usage };
  }

  if (sub === "login") {
    let candidateKey = rest;
    if (!candidateKey && jevClient?.isConfigured?.()) {
      candidateKey = jevClient.getApiKey();
    }
    if (!candidateKey) {
      return {
        kind: "error",
        text: `✗ [${brand} Login] Please provide your API key: /${cmdName} login <api_key>\nGet your API key at: https://console.typesafe.ai`,
      };
    }

    try {
      const savedPath = storeApiKey(candidateKey);
      sessionToolEnabled = true;
      let modelsCount = 1;
      try {
        const models = await jevClient.listModels({ signal });
        modelsCount = models.length;
      } catch {}

      return {
        kind: "success",
        text: `✓ [${brand} Login] API key verified (${modelsCount} model${modelsCount === 1 ? "" : "s"} available) and saved to ${savedPath} with owner-only permissions.\nTool calls are enabled. Run /${cmdName} test to run a sample evaluation.`,
      };
    } catch (err) {
      return {
        kind: "error",
        text: `✗ [${brand} Login Failed] ${err.message || String(err)}`,
      };
    }
  }

  if (sub === "logout") {
    const removed = clearStoredApiKey();
    clearAuthState();
    sessionToolEnabled = false;
    return {
      kind: "success",
      text: removed
        ? `✓ [${brand} Logout] Removed stored API key from ${credentialsPath()}. ${brand} tool calls disabled.`
        : `ℹ️ [${brand} Logout] No stored API key file was found. (If TYPESAFE_API_KEY is set in environment, unset it to fully disconnect.)`,
    };
  }

  if (sub === "enable") {
    if (!jevClient || !jevClient.isConfigured()) {
      return {
        kind: "error",
        text: `⚠️ [${brand} Error] No API key configured. Run /${cmdName} login <api_key> first.`,
      };
    }
    sessionToolEnabled = true;
    return {
      kind: "success",
      text: `✓ [${brand} Enable] ${brand} evaluation tools enabled for this session (typesafe_evaluate & jev_evaluate active). Use /${cmdName} disable to turn off.`,
    };
  }

  if (sub === "disable") {
    sessionToolEnabled = false;
    return {
      kind: "success",
      text: `✓ [${brand} Disable] ${brand} tool calls disabled for future agent turns. Run /${cmdName} enable to re-activate.`,
    };
  }

  if (sub === "test") {
    if (!jevClient || !jevClient.isConfigured()) {
      return {
        kind: "error",
        text: `✗ [${brand} Error] TypeSafe API key is not configured. Set TYPESAFE_API_KEY environment variable or write ~/.dsh/secrets/typesafe_api_key.`,
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
      // Default built-in bug triage sample
      request = {
        state: {
          title: "升级后无法登录",
          body: "输入密码后一直回到登录页",
        },
        questions: {
          area: {
            type: "choice",
            instructions: "这个问题属于哪个模块？",
            criteria: {
              auth: "登录与身份验证",
              ui: "界面与布局",
              other: "都不符合",
            },
          },
          blocking: {
            type: "noul",
            instructions: "这个问题是否阻止用户继续使用产品？",
          },
          severity: {
            type: "score",
            instructions: "评估这个问题的严重程度：",
            criteria: ["仅影响外观", "存在可用绕过方案", "阻止核心流程"],
          },
        },
      };
    }

    try {
      const res = await jevClient.evaluate(request, signal);
      const headline = `✓ [${brand} Test] Passed · Model: ${res.model} · Latency: ${res.elapsedMs}ms`;
      const lines = [
        headline,
        "",
        `State: ${typeof request.state === "string" ? `"${request.state}"` : JSON.stringify(request.state)}`,
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
        lines.push(`Tokens: ${res.usage.input_tokens || 0} in / ${res.usage.output_tokens || 0} out (output tokens are free)`);
      }
      return { kind: "success", text: lines.join("\n") };
    } catch (err) {
      return { kind: "error", text: `✗ [${brand} Error] Evaluation Failed: ${err.message || String(err)}` };
    }
  }

  if (sub === "playground") {
    if (!rest) {
      return {
        kind: "error",
        text: `✗ [${brand} Playground] Please provide JSON state and questions: /${cmdName} playground {"state":"...","questions":{...}}`,
      };
    }
    try {
      const parsed = JSON.parse(rest);
      const res = await jevClient.evaluate(parsed, signal);
      const lines = [
        `✓ [${brand} Playground] Success (${res.model}, ${res.elapsedMs}ms)`,
        "",
        JSON.stringify(res.answers, null, 2),
      ];
      if (res.usage) {
        lines.push(`Tokens: ${res.usage.input_tokens || 0} in / ${res.usage.output_tokens || 0} out`);
      }
      return { kind: "success", text: lines.join("\n") };
    } catch (err) {
      return { kind: "error", text: `✗ [${brand} Playground Error] ${err.message || String(err)}` };
    }
  }

  if (sub === "calibrate") {
    const demoSamples = [
      { label: true, score: 0.95, id: "case_auth_bypass" },
      { label: true, score: 0.88, id: "case_sqli_injection" },
      { label: true, score: 0.76, id: "case_xss_reflected" },
      { label: false, score: 0.22, id: "case_clean_search" },
      { label: false, score: 0.15, id: "case_clean_login" },
      { label: false, score: 0.35, id: "case_borderline_param" },
    ];
    const cal = calibrate("Sample Security Gate Calibration", demoSamples, { minPrecision: 0.9 });
    const formatted = formatCalibration(cal);
    const text = [
      `✓ [${brand} Threshold Calibration Toolkit]`,
      "Calibrate optimal decision thresholds from labeled historical samples instead of guessing cutoffs.",
      "",
      formatted,
      "",
      "API usage in code:",
      'import { calibrate, formatCalibration, replay } from "dsh-jev";',
      "const result = calibrate('my_task', scoredSamples, { minPrecision: 0.85 });",
    ].join("\n");
    return { kind: "success", text };
  }

  if (sub === "skills") {
    const query = rest;
    if (!query) {
      const available = ctx ? await getAvailableSkills(ctx, agent, signal).catch(() => []) : [];
      if (available.length === 0) {
        return { kind: "success", text: "ℹ️ [Jev Skills] No skills currently registered in session." };
      }
      const lines = [
        `✓ [Jev Skills] Registered Skills (${available.length}):`,
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
      return { kind: "success", text: `⚠️ [Jev Skills] No matching skills found for "${query}" (${res.elapsedMs}ms)` };
    }

    const prefix = res.isLowConfidence
      ? `⚠️ [Jev Skills] No high-confidence skills (P>=${(res.threshold || 0.65).toFixed(2)}). Closest ${res.recommended.length} candidate(s) for "${query}" (${res.elapsedMs}ms):`
      : `✓ [Jev Skills] Found ${res.recommended.length} matching skill(s) for "${query}" (${res.elapsedMs}ms):`;

    const lines = [
      prefix,
      ...res.recommended.map((r) => `  • /skill:${r.name} (P=${r.probability.toFixed(2)}) - ${r.description}`),
    ];
    if (res.fallbackUsed) {
      lines.push("(Note: Jev unconfigured/offline - local heuristic ranking used)");
    }
    return { kind: "success", text: lines.join("\n") };
  }

  if (sub === "tools") {
    const query = rest;
    if (!query) {
      const available = ctx ? getAvailableTools(ctx, agent) : [];
      if (available.length === 0) {
        return { kind: "success", text: "ℹ️ [Jev Tools] No tools currently registered in session." };
      }
      const lines = [
        `✓ [Jev Tools] Registered Tools (${available.length}):`,
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
      return { kind: "success", text: `⚠️ [Jev Tools] No matching tools found for "${query}" (${res.elapsedMs}ms)` };
    }

    const prefix = res.isLowConfidence
      ? `⚠️ [Jev Tools] No high-confidence tools (P>=${(res.threshold || 0.65).toFixed(2)}). Closest ${res.recommended.length} candidate(s) for "${query}" (${res.elapsedMs}ms):`
      : `✓ [Jev Tools] Found ${res.recommended.length} matching tool(s) for "${query}" (${res.elapsedMs}ms):`;

    const lines = [
      prefix,
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
      return { kind: "error", text: `✗ [Jev Error] Invalid argument for /jev auto: "${rest}". Use: /jev auto on or /jev auto off` };
    }
    const newState = arg === "on" ? true : arg === "off" ? false : !autoController?.enabled;
    if (autoController) {
      if (typeof autoController.setPersistedEnabled === "function") {
        await autoController.setPersistedEnabled(newState);
      } else {
        autoController.enabled = newState;
      }
    }
    return {
      kind: "success",
      text: newState
        ? "✓ [Jev Auto] Enabled (persisted): Jev will semantically discover and recommend matching skills before each prompt."
        : "✓ [Jev Auto] Disabled (persisted): Auto skill recommendation turned off.",
    };
  }

  return { kind: "error", text: `✗ [${brand} Error] Unknown command: "/${cmdName} ${rawSub}"\n\n${usage}` };
}

export function registerJevCommands(ctx, jevClient, autoController) {
  if (!ctx.commands || typeof ctx.commands.register !== "function") return null;

  const handler = async (invocation) => {
    return executeJevCommand(invocation.rawInput, {
      ctx,
      agent: invocation.agent,
      jevClient,
      autoController,
      signal: invocation.signal,
    });
  };

  ctx.commands.register({
    name: "typesafe",
    description: "TypeSafe Jev System One decisions, login, spend caps, sample test & playground",
    input: { hint: "status | login [key] | enable | disable | test [prompt] | playground [json] | calibrate | help" },
    handler,
  });

  return ctx.commands.register({
    name: "jev",
    description: "TypeSafe Jev System One integration (status, login, enable, test, skills, tools, auto)",
    input: { hint: "status | login [key] | enable | disable | test [prompt] | playground [json] | skills [query] | tools [query] | auto [on|off] | help" },
    handler,
  });
}

