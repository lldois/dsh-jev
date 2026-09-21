import * as fs from "node:fs";
import { findSkills, JEV_THRESHOLD } from "./skills.js";
import { findTools, JEV_TOOL_THRESHOLD } from "./tool-router.js";

function compileParameterSchema(params) {
  if (!params || typeof params !== "object") return { type: "object", properties: {} };
  if (params.type === "object" && params.properties) return params;

  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(params)) {
    properties[key] = { ...spec };
    if (spec.required === true) {
      required.push(key);
    }
    delete properties[key].required;
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

let defineTool = null;
try {
  const mod = await import("@deepseek-ai/dsh-tools");
  defineTool = mod.defineTool;
} catch {
  try {
    const dshMod = await import("file:///C:/Users/lldois/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js");
    defineTool = dshMod.defineTool;
  } catch {
    defineTool = (opts) => ({
      name: opts.name,
      description: opts.description,
      parameters: compileParameterSchema(opts.parameters),
      output: opts.output,
      execute: opts.execute,
      presentCall: opts.presentCall,
    });
  }
}

function toLosslessJson(val) {
  return val === undefined ? null : JSON.parse(JSON.stringify(val));
}

export function renderJevEvaluateResult(value) {
  if (!value || !value.answers) return JSON.stringify(value, null, 2);
  const lines = [`Jev System One Evaluation (${value.model || "jev-latest"}, ${value.elapsedMs || 0}ms):`];
  for (const [id, ans] of Object.entries(value.answers)) {
    if (ans.type === "noul") {
      const prob = typeof ans.value === "number" ? (ans.value * 100).toFixed(1) + "%" : ans.value;
      lines.push(`  • ${id}: ${ans.value} (yes probability: ${prob})`);
    } else if (ans.type === "choice") {
      const conf = ans.confidence !== undefined ? ` [confidence: ${ans.confidence}]` : "";
      const dist = ans.distribution
        ? ` [dist: ${Object.entries(ans.distribution).map(([k, v]) => `${k}=${(Number(v) * 100).toFixed(0)}%`).join(", ")}]`
        : "";
      lines.push(`  • ${id}: "${ans.value}"${conf}${dist}`);
    } else if (ans.type === "score") {
      const conf = ans.confidence !== undefined ? ` [confidence: ${ans.confidence}]` : "";
      lines.push(`  • ${id}: ${ans.value}${conf}`);
    } else {
      lines.push(`  • ${id}: ${JSON.stringify(ans.value ?? ans)}`);
    }
  }
  if (value.usage) {
    lines.push(`\nTokens: ${value.usage.input_tokens || 0} in / ${value.usage.output_tokens || 0} out (output tokens are free - Jev does not generate text)`);
  }
  return lines.join("\n");
}

export function createJevEvaluateTool(ctx, jevClient) {
  return defineTool({
    name: "jev_evaluate",
    description:
      "Ask TypeSafe Jev System One typed questions (choice, noul, score) about structured state or text. Returns fast, calibrated probabilities, categories, or scores rather than text generation.",
    parameters: {
      state: {
        oneOf: [
          { type: "string", description: "Context or text" },
          { type: "object", additionalProperties: true, description: "Structured JSON state" },
        ],
        required: true,
        description: "Target context, text, or structured JSON to evaluate.",
      },
      questions: {
        type: "object",
        additionalProperties: true,
        required: true,
        description:
          "Map of question IDs to question definitions. Each question must specify 'type' ('choice' | 'noul' | 'score') and 'instructions'. For 'choice', specify 'criteria' mapping options to descriptions. For 'score', specify 'criteria' as an array of rubric levels.",
      },
      model: {
        type: "string",
        description: "Optional Jev model identifier (default: jev-latest).",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [
        {
          type: "text",
          text: renderJevEvaluateResult(value),
        },
      ],
      presentationMeta: (_args, value) => ({
        card: "generic",
        title: "Jev Evaluate",
        kind: "decision",
        summary: `${Object.keys(value?.answers || {}).length} question(s) evaluated (${value?.elapsedMs || 0}ms)`,
      }),
    },
    async execute(args, exec) {
      if (!jevClient.isConfigured()) {
        throw new Error(
          "TypeSafe Jev API key is not configured. Set TYPESAFE_API_KEY environment variable or write ~/.dsh/secrets/typesafe_api_key."
        );
      }
      return toLosslessJson(
        await jevClient.evaluate(
          {
            state: args.state,
            questions: args.questions,
            model: args.model,
          },
          exec?.signal
        )
      );
    },
    presentCall(args) {
      const qCount = args.questions && typeof args.questions === "object" ? Object.keys(args.questions).length : 0;
      return {
        card: "generic",
        title: `Jev Evaluate (${qCount} questions)`,
        kind: "decision",
        rawInput: typeof args.state === "string" ? args.state.slice(0, 100) : JSON.stringify(args.state).slice(0, 100),
      };
    },
  });
}

export function createJevFindSkillTool(ctx, jevClient) {
  return defineTool({
    name: "jev_find_skill",
    description:
      "Find and recommend the best matching agent skills for a specific task using TypeSafe Jev semantic evaluation.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "The task, domain, or technology you need specialized skills for.",
      },
      threshold: {
        type: "number",
        description: "Match confidence threshold between 0.0 and 1.0 (default 0.65).",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => {
        if (value.message) {
          return [{ type: "text", text: value.message }];
        }
        let summaryText = "";
        if (value.recommended && value.recommended.length > 0) {
          const isLowConf = value.isLowConfidence || value.recommended.some((r) => r.lowConfidence);
          const header = isLowConf
            ? `No skills reached high confidence (P >= ${(value.threshold || JEV_THRESHOLD).toFixed(2)}). Closest matching skill(s):`
            : "Recommended skill(s):";
          const lines = value.recommended.map(
            (r) => `• /skill:${r.name} (P=${r.probability.toFixed(2)})${r.location ? ` - ${r.location}` : ""}\n  ${r.description}`
          );
          summaryText = `${header}\n${lines.join("\n")}\n\nTo use a skill, call the 'skill' tool with its exact name, e.g. skill(name: "${value.recommended[0].name}").`;
        } else if (value.candidates && value.candidates.length > 0) {
          summaryText = `No skills met the confidence threshold among candidates: ${value.candidates.join(", ")}`;
        } else {
          summaryText = "No registered skills found in session.";
        }

        if (value.fallbackUsed) {
          summaryText += "\n(Note: local heuristic shortlist used due to Jev unconfigured/offline)";
        }

        return [{ type: "text", text: summaryText }];
      },
      presentationMeta: (_args, value) => ({
        card: "generic",
        title: "Jev Skill Discovery",
        kind: "discovery",
        summary: `Found ${value.recommended?.length || 0} matching skill(s)`,
      }),
    },
    async execute(args, exec) {
      return toLosslessJson(
        await findSkills({
          query: args.query,
          threshold: args.threshold ?? JEV_THRESHOLD,
          ctx,
          agent: exec?.agent,
          jevClient,
          signal: exec?.signal,
        })
      );
    },
    presentCall(args) {
      return {
        card: "generic",
        title: `Find skill for "${args.query}"`,
        kind: "discovery",
        rawInput: args.query,
      };
    },
  });
}

export function createJevFindToolsTool(ctx, jevClient) {
  return defineTool({
    name: "jev_find_tools",
    description:
      "Semantically search and identify the most relevant tools registered in DeepSeek Harness for a user task using TypeSafe Jev.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "The action, capability, or user task you need tools for.",
      },
      threshold: {
        type: "number",
        description: "Confidence threshold between 0.0 and 1.0 (default 0.65).",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => {
        if (value.message) {
          return [{ type: "text", text: value.message }];
        }
        let summaryText = "";
        if (value.recommended && value.recommended.length > 0) {
          const isLowConf = value.isLowConfidence || value.recommended.some((r) => r.lowConfidence);
          const header = isLowConf
            ? `No tools reached high confidence (P >= ${(value.threshold || JEV_TOOL_THRESHOLD).toFixed(2)}). Closest matching tool(s):`
            : "Recommended tool(s) for task:";
          const lines = value.recommended.map(
            (r) => `• ${r.name} (P=${r.probability.toFixed(2)}): ${r.description || "no description"}`
          );
          summaryText = `${header}\n${lines.join("\n")}`;
        } else if (value.candidates && value.candidates.length > 0) {
          summaryText = `No tools met the activation threshold among candidates: ${value.candidates.join(", ")}`;
        } else {
          summaryText = "No matching tools found in session.";
        }

        if (value.fallbackUsed) {
          summaryText += "\n(Note: local heuristic shortlist used due to Jev unconfigured/offline)";
        }

        return [{ type: "text", text: summaryText }];
      },
      presentationMeta: (_args, value) => ({
        card: "generic",
        title: "Jev Tool Discovery",
        kind: "discovery",
        summary: `Found ${value.recommended?.length || 0} matching tool(s)`,
      }),
    },
    async execute(args, exec) {
      return toLosslessJson(
        await findTools({
          query: args.query,
          threshold: args.threshold ?? JEV_TOOL_THRESHOLD,
          ctx,
          agent: exec?.agent,
          jevClient,
          signal: exec?.signal,
        })
      );
    },
    presentCall(args) {
      return {
        card: "generic",
        title: `Find tools for "${args.query}"`,
        kind: "discovery",
        rawInput: args.query,
      };
    },
  });
}

export function registerJevTools(ctx, jevClient) {
  if (!ctx.tools || typeof ctx.tools.register !== "function") return [];
  const evalTool = createJevEvaluateTool(ctx, jevClient);
  const skillTool = createJevFindSkillTool(ctx, jevClient);
  const toolFinderTool = createJevFindToolsTool(ctx, jevClient);

  ctx.tools.register(evalTool);
  ctx.tools.register(skillTool);
  ctx.tools.register(toolFinderTool);

  return [evalTool, skillTool, toolFinderTool];
}
