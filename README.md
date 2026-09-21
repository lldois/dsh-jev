# dsh-jev

Semantic tool routing and typed System One decisions for **DeepSeek Harness (DSH)** powered by [TypeSafe](https://typesafe.ai) Jev.

Modeled after [pi-typesafe](https://github.com/DevMortimer/pi-typesafe), this plugin integrates TypeSafe Jev into DeepSeek Harness with Cordis service injection, DSH tool definitions, slash commands (`/typesafe` and `/jev`), threshold calibration, spend caps, and pre-turn lifecycle hooks.

---

## Why Jev in Coding Agents?

Most coding agents spend expensive, slow frontier LLM reasoning tokens on "small mechanical decisions":
- Which category or module does this bug belong to?
- Is this issue blocking user workflows?
- Is the modification risk low, medium, or high?
- Does this PR require human review or can it continue automatically?

**TypeSafe Jev** provides a fast, structured judgment model: you provide a `state` and typed `questions`, and it returns calibrated probabilities, option distributions, and rubric scores in well under a second for a fraction of a cent ($0.042 per million input tokens; output tokens are free).

1. **Free the main model from mechanical triage**: Let DeepSeek / frontier models focus on deep reasoning, code generation, and complex debugging.
2. **Deterministic thresholds in code**: Jev outputs real probability distributions instead of prose so your workflow can branch with concrete cutoffs:
   ```js
   if (riskProbability > 0.85) {
     requireHumanReview();
   } else {
     continueAutomatically();
   }
   ```
3. **Independent batched questions**: Evaluate Choice, Score, and Noul questions concurrently without question contamination.

---

## Features

- **Typed Judgments (`typesafe_evaluate` / `jev_evaluate` tools)**: Run fast, calibrated System One decisions directly from any LLM turn in DSH using `choice` (categorical selection), `noul` (0-1 truth probability), and `score` (rubric scale).
- **Skill Discovery (`jev_find_skill` tool)**: Semantically matches and suggests the most relevant specialized agent skills (`SKILL.md`) for any task without cluttering prompt context.
- **Tool Discovery (`jev_find_tools` tool)**: Semantically evaluates and identifies relevant registered tools in DeepSeek Harness for a user task.
- **Human Slash Commands (`/typesafe` & `/jev`)**:
  - `/typesafe status` — Displays TypeSafe configuration, auth state, session usage, daily spend caps, and registered tool/skill counts.
  - `/typesafe login [key]` — Validates and saves API key to `~/.pi/agent/pi-typesafe/auth.json` (with owner-only permissions).
  - `/typesafe logout` — Clears stored API key and resets auth state.
  - `/typesafe enable` — Enables TypeSafe agent evaluation tool calls for this session.
  - `/typesafe disable` — Disables TypeSafe agent evaluation tool calls.
  - `/typesafe test [prompt]` — Run live connectivity test or evaluate prompt against Jev (defaults to built-in bug triage sample).
  - `/typesafe playground [json]` — Run direct JSON state & questions without polluting agent context.
  - `/typesafe calibrate` — Historical sample threshold calibration toolkit (AUC, precision, recall sweep).
  - `/typesafe skills [query]` — Semantically search and rank available skills directly from chat.
  - `/typesafe tools [query]` — Semantically search and rank available tools directly from chat.
  - `/typesafe auto [on|off]` — Toggle automatic per-prompt skill suggestions.
  - `/typesafe help` — Display help message.
- **Spend & Cost Tracking**:
  - Session request limit (default 20 attempts).
  - Daily request, token, and USD caps (`PI_TYPESAFE_MAX_REQUESTS_PER_DAY`, `PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY`, `PI_TYPESAFE_MAX_USD_PER_DAY`).
  - Cross-process 31-day persisted usage ledger at `~/.pi/agent/pi-typesafe/usage.json`.
- **Threshold Calibration Toolkit**: Calibrate optimal decision thresholds from labeled historical samples with Mann-Whitney rank AUC, precision, recall, and optimal F1 picking (`calibrate`, `replay`, `formatCalibration`).
- **Post-Run Gate CLI (`dsh-jev-gate` / `jev-gate`)**: Standalone binary for CI/CD pipelines, subagents, or verification gates. Checks git diff, files, or stdin against natural language acceptance criteria using Jev probability.
- **Graceful Fallback & Fail-Open**: Fails open to local keyword heuristic shortlists when Jev is unconfigured or offline.

---

## Installation in DeepSeek Harness

In your DSH profile directory (e.g. `~/.dsh/profiles/web`):

```bash
# Install via GitHub or link local workspace
pnpm add file:C:/Users/lldois/workspace/dsh-jev
```

In `~/.dsh/profiles/web/package.json`, add `"dsh-jev"` to `dsh.profile.bundles`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-jev"
      ]
    }
  }
}
```

---

## Setup & Credentials

You can configure your TypeSafe API key via:

1. **Slash Command**:
   ```text
   /typesafe login your_api_key_here
   ```
   Saved securely to `~/.pi/agent/pi-typesafe/auth.json`.
2. **Environment variable**:
   ```bash
   export TYPESAFE_API_KEY=your_key_here
   export PI_TYPESAFE_ENABLED=1
   ```
3. **Secret files**:
   - `~/.pi/agent/pi-typesafe/auth.json`
   - `~/.dsh/secrets/typesafe_api_key`
   - `~/.pi/agent/secrets/typesafe_api_key`

Verify your setup by running:
```text
/typesafe status
```

---

## Tools

### 1. `typesafe_evaluate` / `jev_evaluate`
Used by the model or code to get structured decisions, classifications, triage, and scoring.

```json
{
  "state": {
    "title": "升级后无法登录",
    "body": "输入密码后一直回到登录页"
  },
  "questions": {
    "area": {
      "type": "choice",
      "instructions": "这个问题属于哪个模块？",
      "criteria": {
        "auth": "登录与身份验证",
        "ui": "界面与布局",
        "other": "都不符合"
      }
    },
    "blocking": {
      "type": "noul",
      "instructions": "这个问题是否阻止用户继续使用产品？"
    },
    "severity": {
      "type": "score",
      "instructions": "评估这个问题的严重程度：",
      "criteria": [
        "仅影响外观",
        "存在可用绕过方案",
        "阻止核心流程"
      ]
    }
  }
}
```

---

## Running Tests

```bash
npm test
```

---

## License

MIT © [lldois](https://github.com/lldois)

