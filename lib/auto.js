/**
 * AutoJev controller for DeepSeek Harness (DSH).
 * When enabled, automatically runs Jev semantic skill discovery on each incoming user turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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

/**
 * Persist jev configuration directly into ~/.dsh/settings.yaml as a fallback.
 * @param {object} patch
 * @param {string} [customPath]
 * @returns {boolean}
 */
export function persistSettingsToFile(patch, customPath) {
  try {
    const settingsPath = customPath || path.join(os.homedir(), ".dsh", "settings.yaml");
    if (!fs.existsSync(settingsPath)) {
      const dir = path.dirname(settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, `jev:\n  auto: ${Boolean(patch.auto)}\n`, "utf8");
      return true;
    }

    const lines = fs.readFileSync(settingsPath, "utf8").split(/\r?\n/);
    let jevIndex = -1;
    let autoIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^jev:\s*$/.test(line)) {
        jevIndex = i;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\S/.test(lines[j])) {
            break;
          }
          if (/^\s+auto:\s*/.test(lines[j])) {
            autoIndex = j;
          }
        }
        break;
      }
    }

    if (jevIndex === -1) {
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      lines.push("jev:", `  auto: ${Boolean(patch.auto)}`, "");
    } else if (autoIndex !== -1) {
      lines[autoIndex] = `  auto: ${Boolean(patch.auto)}`;
    } else {
      lines.splice(jevIndex + 1, 0, `  auto: ${Boolean(patch.auto)}`);
    }

    fs.writeFileSync(settingsPath, lines.join("\n"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Load persisted jev configuration from ~/.dsh/settings.yaml as a fallback.
 * @param {string} [customPath]
 * @returns {object | null}
 */
export function loadPersistedSettings(customPath) {
  try {
    const settingsPath = customPath || path.join(os.homedir(), ".dsh", "settings.yaml");
    if (!fs.existsSync(settingsPath)) return null;
    const content = fs.readFileSync(settingsPath, "utf8");
    const lines = content.split(/\r?\n/);
    let insideJev = false;
    for (const line of lines) {
      if (/^jev:\s*$/.test(line)) {
        insideJev = true;
        continue;
      }
      if (insideJev) {
        if (/^\S/.test(line)) {
          break;
        }
        const autoMatch = line.match(/^\s+auto:\s*(true|false)\s*$/);
        if (autoMatch) {
          return { auto: autoMatch[1] === "true" };
        }
      }
    }
  } catch {}
  return null;
}

export class AutoController {
  constructor(options = {}) {
    this._getter = typeof options.getEnabled === "function" ? options.getEnabled : null;
    this._setter = typeof options.setEnabled === "function" ? options.setEnabled : null;
    this._persistHook = typeof options.persist === "function" ? options.persist : null;
    this._customSettingsPath = options.settingsPath || null;

    const persisted = loadPersistedSettings(this._customSettingsPath);
    this._fallbackEnabled = persisted && typeof persisted.auto === "boolean" ? persisted.auto : Boolean(options.enabled);
    this.threshold = typeof options.threshold === "number" ? options.threshold : JEV_THRESHOLD;
    this.running = false;
  }

  get enabled() {
    if (this._getter) {
      const val = this._getter();
      if (typeof val === "boolean") return val;
    }
    return this._fallbackEnabled;
  }

  set enabled(val) {
    const boolVal = Boolean(val);
    this._fallbackEnabled = boolVal;
    if (this._setter) {
      this._setter(boolVal);
    }
  }

  async setPersistedEnabled(val) {
    this.enabled = val;
    let persisted = false;
    if (this._persistHook) {
      try {
        await this._persistHook(val);
        persisted = true;
      } catch {}
    }
    const filePersisted = persistSettingsToFile({ auto: val }, this._customSettingsPath);
    return persisted || filePersisted;
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
    if (!msg) continue;
    if (typeof msg === "string") {
      if (msg.trim()) return msg.trim();
      continue;
    }
    if (msg.role === "user" || !msg.role) {
      if (typeof msg.content === "string") {
        if (msg.content.trim()) return msg.content.trim();
      } else if (Array.isArray(msg.content)) {
        const texts = msg.content
          .map((c) => {
            if (typeof c === "string") return c.trim();
            if (c && c.type === "text" && typeof c.text === "string") return c.text.trim();
            return "";
          })
          .filter(Boolean);
        if (texts.length > 0) return texts.join("\n");
      } else if (typeof msg.text === "string" && msg.text.trim()) {
        return msg.text.trim();
      }
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
    if (promptText && /^\s*[\/／]?jev(?:[:\s]+.*)?$/i.test(promptText)) {
      try {
        const rawLine = promptText.trim().replace(/^[\/／]?jev[:\s]*/i, "");
        const cmdResult = await executeJevCommand(rawLine, { ctx, agent, jevClient, autoController, signal });
        if (cmdResult) {
          const commandId = "cmd-jev-" + Date.now();
          if (agent?.session && typeof agent.session.append === "function") {
            try {
              agent.session.append("command/run", {
                commandId,
                name: "jev",
                args: rawLine,
                source: { kind: "user" },
              });
              agent.session.append("command/done", {
                commandId,
                kind: cmdResult.kind,
                text: cmdResult.text,
              });
              return { kind: "reject" };
            } catch {}
          }

          // Fallback if session.append is not available
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
            interceptorResult: cmdResult,
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

      if (result.recommended && result.recommended.length > 0 && !result.fallbackUsed && !result.isLowConfidence) {
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
