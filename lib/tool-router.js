/**
 * Semantic Tool Router for DeepSeek Harness (DSH).
 * Semantically matches and identifies the best tools registered in DSH for any task.
 */

export const JEV_TOOL_NAMES = new Set(["jev_evaluate", "typesafe_evaluate", "jev_find_skill", "jev_find_tools"]);
export const JEV_TOOL_THRESHOLD = 0.65;
export const JEV_TOOL_FALLBACK_THRESHOLD = 0.20;

export function isJevTool(name) {
  return JEV_TOOL_NAMES.has(name);
}

/**
 * Discover available callable tools in the current DSH context.
 * @param {object} ctx - Cordis context
 * @param {object} [agent] - DSH Agent
 * @returns {Array<{ name: string, description: string, parameters?: any }>}
 */
export function getAvailableTools(ctx, agent) {
  const tools = [];
  if (!ctx.tools) return tools;

  try {
    const view = ctx.tools.view(agent);
    if (view?.visible) {
      for (const def of view.visible.values()) {
        if (!isJevTool(def.name)) {
          tools.push({
            name: def.name,
            description: def.description || "",
            parameters: def.parameters,
          });
        }
      }
    }
  } catch {
    // Fallback if tools.view fails
  }

  return tools;
}

/**
 * Local lexical/token heuristic ranker for available tools.
 * @param {Array<{ name: string, description: string }>} tools
 * @param {string} query
 * @returns {Array<{ name: string, description: string, score: number }>}
 */
export function shortlistTools(tools, query) {
  const qTokens = (query || "")
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length > 2);

  return tools
    .filter((t) => !isJevTool(t.name))
    .map((t) => {
      let score = 0;
      const tName = t.name.toLowerCase();
      const tDesc = (t.description || "").toLowerCase();

      for (const tok of qTokens) {
        if (tName.includes(tok)) score += 3.0;
        if (tDesc.includes(tok)) score += 1.0;
      }

      return {
        ...t,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Semantically find and rank the most suitable tools registered in DSH using TypeSafe Jev.
 * @param {object} params
 * @param {string} params.query
 * @param {number} [params.threshold=JEV_TOOL_THRESHOLD]
 * @param {object} [params.ctx]
 * @param {object} [params.agent]
 * @param {object} params.jevClient
 * @param {AbortSignal} [params.signal]
 */
export async function findTools({
  query,
  threshold = JEV_TOOL_THRESHOLD,
  ctx,
  agent,
  jevClient,
  signal,
}) {
  const startTime = Date.now();
  const availableTools = ctx ? getAvailableTools(ctx, agent) : [];

  if (availableTools.length === 0) {
    return {
      query,
      threshold,
      recommended: [],
      candidates: [],
      elapsedMs: 0,
      fallbackUsed: false,
      message: "No registered tools found in session.",
    };
  }

  // Pre-filter with local heuristic
  const candidates = shortlistTools(availableTools, query).slice(0, 10);

  // Fallback to local heuristic if Jev is unconfigured or offline
  if (!jevClient || !jevClient.isConfigured()) {
    const fallbackRecs = candidates.filter((c) => c.score > 0).slice(0, 3);
    return {
      query,
      threshold,
      recommended: fallbackRecs.map((c) => ({
        name: c.name,
        description: c.description,
        probability: Math.min(0.99, 0.4 + c.score * 0.1),
      })),
      candidates: candidates.map((c) => c.name),
      elapsedMs: Date.now() - startTime,
      fallbackUsed: true,
    };
  }

  // Build Jev System One questions
  const questions = {};
  for (const tool of candidates) {
    questions[tool.name] = {
      type: "noul",
      instructions: `Would invoking tool '${tool.name}' help accomplish the user task: "${query}"? Tool description: ${tool.description.slice(0, 180)}`,
    };
  }

  try {
    const res = await jevClient.evaluate(
      {
        state: { userQuery: query },
        questions,
      },
      signal
    );

    const scored = candidates
      .map((t) => {
        const ans = res.answers[t.name];
        const prob = typeof ans?.value === "number" ? ans.value : 0;
        return {
          name: t.name,
          description: t.description,
          probability: prob,
        };
      })
      .sort((a, b) => b.probability - a.probability);

    const recommended = scored.filter((s) => s.probability >= threshold);

    if (recommended.length === 0 && scored.length > 0) {
      const bestCandidate = scored[0];
      if (bestCandidate.probability >= JEV_TOOL_FALLBACK_THRESHOLD) {
        return {
          query,
          threshold,
          recommended: [{ ...bestCandidate, lowConfidence: true }],
          candidates: candidates.map((c) => c.name),
          elapsedMs: res.elapsedMs,
          fallbackUsed: false,
          isLowConfidence: true,
        };
      }
    }

    return {
      query,
      threshold,
      recommended,
      candidates: candidates.map((c) => c.name),
      elapsedMs: res.elapsedMs,
      fallbackUsed: false,
      isLowConfidence: false,
    };
  } catch (err) {
    const fallbackRecs = candidates.filter((c) => c.score > 0).slice(0, 3);
    return {
      query,
      threshold,
      recommended: fallbackRecs.map((c) => ({
        name: c.name,
        description: c.description,
        probability: Math.min(0.99, 0.3 + c.score * 0.1),
      })),
      candidates: candidates.map((c) => c.name),
      elapsedMs: Date.now() - startTime,
      fallbackUsed: true,
      error: err.message,
    };
  }
}

