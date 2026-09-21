/**
 * dsh-jev: DeepSeek Harness plugin for TypeSafe Jev System One decisions & semantic routing.
 */

import { JevClient, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_MODEL } from "./client.js";
import { registerJevTools } from "./tools.js";
import { registerJevCommands } from "./commands.js";
import { AutoController, installAutoHook } from "./auto.js";
import { JEV_THRESHOLD } from "./skills.js";

export const name = "jev";
export const inject = ["tools"];

export const SETTINGS_NAMESPACE = "jev";

/**
 * Cordis plugin entrypoint for DeepSeek Harness.
 * @param {object} ctx - Cordis context
 * @param {object} [config] - Plugin configuration
 */
export function apply(ctx, config = {}) {
  let currentConfig = () => config;
  let settingsUpdater = null;

  // Settings integration with Schemastery (if settings service is present)
  if (ctx.inject) {
    ctx.inject(["settings"], async (settingsCtx) => {
      try {
        const schemasteryMod = await import("@deepseek-ai/schemastery");
        const z = schemasteryMod.default || schemasteryMod;
        if (z && typeof z.object === "function") {
          const ConfigSchema = z.object({
            apiKey: z.string().role("secret").description("Optional explicit TypeSafe API key"),
            apiKeyEnv: z
              .string()
              .role("credential-ref")
              .default(DEFAULT_API_KEY_ENV)
              .description("Environment variable for TypeSafe API key"),
            baseURL: z.string().default(DEFAULT_BASE_URL).description("Base URL for TypeSafe API"),
            model: z.string().default(DEFAULT_MODEL).description("Default Jev model identifier"),
            auto: z.boolean().default(false).description("Automatically suggest matching skills on each prompt"),
            threshold: z.number().min(0).max(1).default(JEV_THRESHOLD).description("Confidence threshold for skill/tool matching"),
          });

          settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, ConfigSchema, config, {
            setSource: (source) => {
              currentConfig = source;
            },
            onChange: () => {},
          });

          settingsUpdater = (patch) => {
            if (typeof settingsCtx.settings?.update === "function") {
              return settingsCtx.settings.update(SETTINGS_NAMESPACE, patch);
            }
          };
        }
      } catch {
        // Fallback: settings schema safely skipped if schemastery is unavailable
      }
    });
  }

  const jevClient = new JevClient({
    get apiKey() {
      return currentConfig().apiKey;
    },
    get apiKeyEnv() {
      return currentConfig().apiKeyEnv || DEFAULT_API_KEY_ENV;
    },
    get baseURL() {
      return currentConfig().baseURL || DEFAULT_BASE_URL;
    },
    get defaultModel() {
      return currentConfig().model || DEFAULT_MODEL;
    },
  });

  const autoController = new AutoController({
    getEnabled: () => currentConfig().auto,
    setEnabled: (val) => {
      if (typeof currentConfig === "function" && typeof currentConfig() === "object") {
        currentConfig().auto = val;
      }
    },
    persist: async (val) => {
      if (settingsUpdater) {
        await settingsUpdater({ auto: val });
      }
    },
    get threshold() {
      return typeof currentConfig().threshold === "number" ? currentConfig().threshold : JEV_THRESHOLD;
    },
  });

  // 1. Register tools (jev_evaluate, jev_find_skill, jev_find_tools)
  registerJevTools(ctx, jevClient);

  // 2. Register slash commands (/jev) dynamically when commands service is ready
  if (ctx.inject) {
    ctx.inject(["commands"], (commandsCtx) => {
      registerJevCommands(commandsCtx, jevClient, autoController);
    });
  }

  // 3. Install AutoJev pre-step hook
  installAutoHook(ctx, jevClient, autoController);
}

export * from "./client.js";
export * from "./tools.js";
export * from "./skills.js";
export * from "./tool-router.js";
export * from "./commands.js";
export * from "./auto.js";
export * from "./gate.js";
