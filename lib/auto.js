/**
 * AutoJev controller for DeepSeek Harness (DSH).
 * When enabled, automatically runs Jev semantic skill discovery on each incoming user turn.
 */

import { findSkills, JEV_THRESHOLD } from "./skills.js";
import { executeJevCommand } from "./commands.js";

let createUserMessageFn = null;
try {
  const llmMod = await import("@deepseek-ai/dsh-llm");
  createUserMessageFn = llmMod.createUserMessage;
} catch {
  createUserMessageFn = (opts) => ({
    role: "user",
    id: `jev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content: opts.content,
    source: opts.source || { kind: "user" },
  });
}

export class AutoController {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.threshold = typeof options.threshold === "number" ? options.threshold : JEV_THRESHOLD;
    this.running = false;
  }
}

/**
 * Extract latest direct user prompt text from message history.
 * @param {Array<any>} messages
 * @returns {string}
 */
export function extractLatestUserPrompt(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && msg.source?.kind === "user" && Array.isArray(msg.content)) {
      const texts = msg.content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text.trim())
        .filter(Boolean);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return "";
}

/**
 * Install the AutoJev pre-step hook on Cordis context.
 * @param {object} ctx - Cordis context
 * @param {object} jevClient
 * @param {AutoController} autoController
 */
export function installAutoHook(ctx, jevClient, autoController) {
  if (!ctx.on) return;

  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;

    const promptText = extractLatestUserPrompt(decision.messages || messages || []);

    // Intercept slash commands sent as direct prompt text (e.g. from blank new session page or fast input)
    if (promptText && /^\s*\/jev(?:\s+.*)?$/i.test(promptText)) {
      try {
        const rawLine = promptText.trim().replace(/^\/jev\s*/i, "");
        const cmdResult = await executeJevCommand(rawLine, { ctx, agent, jevClient, autoController, signal });
        if (cmdResult) {
          const isError = cmdResult.kind === "error";
          const reminderMsg = createUserMessageFn({
            content: [{
              type: "text",
              text: [
                "<system-reminder>",
                `TypeSafe Jev System One Command: "${promptText.trim()}"`,
                `Output (${isError ? "Error" : "Success"}):`,
                cmdResult.text,
                "",
                "Output this exact response clearly and completely to the user.",
                "</system-reminder>",
              ].join("\n"),
            }],
            source: { kind: "jev-command-interceptor", form: "command-result" },
          });
          return {
            ...decision,
            messages: [...decision.messages, reminderMsg],
          };
        }
      } catch {}
    }

    if (!autoController.enabled || autoController.running) return decision;
    if (!jevClient.isConfigured()) return decision;
    if (!promptText || promptText.startsWith("/")) return decision;

    autoController.running = true;
    try {
      signal?.throwIfAborted();
      const result = await findSkills({
        query: promptText,
        threshold: autoController.threshold,
        ctx,
        agent,
        jevClient,
        signal,
      });

      if (result.recommended && result.recommended.length > 0 && !result.fallbackUsed) {
        const skillLines = result.recommended
          .map((s) => `- \`${s.name}\` (relevance P=${s.probability.toFixed(2)}): ${s.description}`)
          .join("\n");

        const reminderText = [
          "<system-reminder>",
          "TypeSafe Jev System One semantically detected specialized skills matching the user request:",
          skillLines,
          "",
          `Before taking actions, invoke the matching skill instructions using the \`skill\` tool, e.g. skill(name: "${result.recommended[0].name}").`,
          "</system-reminder>",
        ].join("\n");

        const reminderMsg = createUserMessageFn({
          content: [{ type: "text", text: reminderText }],
          source: { kind: "jev-auto-skill", form: "recommendation" },
        });

        return {
          ...decision,
          messages: [...decision.messages, reminderMsg],
        };
      }
    } catch {
      // Automatic routing must never break the main agent loop
    } finally {
      autoController.running = false;
    }

    return decision;
  });
}
