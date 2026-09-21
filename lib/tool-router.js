/**
 * Semantic Tool Router for DeepSeek Harness (DSH).
 * Semantically matches and identifies the best tools registered in DSH for any task.
 */

export const JEV_TOOL_NAMES = new Set(["jev_evaluate", "jev_find_skill", "jev_find_tools"]);
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
      return tools;
    }
  } catch {}

  // Fallback to schemas() if view() is structured differently
  try {
    if (typeof ctx.tools.schemas === "function") {
      const schemas = ctx.tools.schemas(agent) || [];
      for (const s of schemas) {
        if (s.name && !isJevTool(s.name)) {
          tools.push({
            name: s.name,
            description: s.description || "",
            parameters: s.parameters,
          });
        }
      }
    }
  } catch {}

  return tools;
}

/**
 * Heuristically shortlist candidate tools for a query.
 * @param {Array<{ name: string, description: string }>} tools
 * @param {string} query
 * @param {number} [limit=8]
 * @returns {Array<{ name: string, description: string }>}
 */
export function shortlistTools(tools, query, limit = 8) {
  const terms = (query || "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
  if (terms.length === 0) {
    return tools.slice(0, limit);
  }

  const scored = tools.map((tool) => {
    const text = `${tool.name} ${tool.description || ""}`.toLowerCase();
    let matchCount = 0;
    for (const term of terms) {
      if (text.includes(term)) matchCount += 1;
    }
    return { tool, score: matchCount };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.tool);
}

/**
 * Find tools matching a task query using TypeSafe Jev System One evaluation.
 * @param {object} params
 * @param {string} params.query
 * @param {number} [params.threshold=JEV_TOOL_THRESHOLD]
 * @param {object} params.ctx
 * @param {object} [params.agent]
 * @param {object} params.jevClient
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ query: string, threshold: number, candidates: string[], recommended: Array<{ name: string, description: string, probability: number, lowConfidence?: boolean }>, isLowConfidence: boolean, fallbackUsed: boolean, message?: string, elapsedMs: number }>}
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
  const allTools = getAvailableTools(ctx, agent);
  const candidates = shortlistTools(allTools, query, 10);
  const candidateNames = candidates.map((c) => c.name);

  if (candidates.length === 0) {
    return {
      query: query || "",
      threshold,
      candidates: [],
      recommended: [],
      isLowConfidence: false,
      fallbackUsed: false,
      elapsedMs: Date.now() - startTime,
    };
  }

  const trimmed = (query || "").trim();
  if (!trimmed) {
    return {
      query: "",
      threshold,
      candidates: candidateNames,
      recommended: [],
      isLowConfidence: false,
      fallbackUsed: false,
      message: `No search query specified. Registered tools in session: ${candidateNames.join(", ")}`,
      elapsedMs: Date.now() - startTime,
    };
  }

  const recommended = [];
  let isLowConfidence = false;
  let fallbackUsed = false;

  if (jevClient && jevClient.isConfigured()) {
    try {
      const questions = {};
      for (const t of candidates) {
        questions[t.name] = {
          type: "noul",
          instructions: `Does the tool '${t.name}' (${t.description || "no description"}) directly help accomplish this task: "${trimmed}"?`,
        };
      }

      const res = await jevClient.evaluate({
        state: { task: trimmed, available_tools: candidates.map((c) => ({ name: c.name, description: c.description })) },
        questions,
      }, signal);

      const evaluated = [];
      for (const t of candidates) {
        const ans = res.answers[t.name];
        const prob = typeof ans?.value === "number" ? ans.value : 0;
        evaluated.push({
          name: t.name,
          description: t.description,
          probability: prob,
        });
      }

      evaluated.sort((a, b) => b.probability - a.probability);

      for (const t of evaluated) {
        if (t.probability >= threshold) {
          recommended.push(t);
        }
      }

      // Graceful secondary fallback when no tools meet primary threshold
      if (recommended.length === 0 && evaluated.length > 0) {
        const topCandidates = evaluated.filter((t) => t.probability >= (threshold > 0.3 ? JEV_TOOL_FALLBACK_THRESHOLD : 0.1));
        if (topCandidates.length > 0) {
          isLowConfidence = true;
          for (const t of topCandidates.slice(0, 2)) {
            recommended.push({
              ...t,
              lowConfidence: true,
            });
          }
        }
      }
    } catch {
      fallbackUsed = true;
    }
  } else {
    fallbackUsed = true;
  }

  if (fallbackUsed) {
    for (const c of candidates.slice(0, 3)) {
      recommended.push({
        name: c.name,
        description: c.description,
        probability: 1.0,
      });
    }
  }

  return {
    query: trimmed,
    threshold,
    candidates: candidateNames,
    recommended,
    isLowConfidence,
    fallbackUsed,
    elapsedMs: Date.now() - startTime,
  };
}
