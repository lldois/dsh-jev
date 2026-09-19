# dsh-jev

Semantic tool routing and typed System One decisions for **DeepSeek Harness (DSH)** powered by [TypeSafe](https://typesafe.ai) Jev.

Modeled after the Pi Jev extension (`pi-jev`), this plugin natively integrates TypeSafe Jev into DeepSeek Harness using Cordis service injection, DSH tool definitions, human slash commands, and pre-turn lifecycle hooks.

---

## Features

- **Typed Judgments (`jev_evaluate` tool)**: Run fast, calibrated System One decisions directly from any LLM turn in DSH using `choice` (categorical selection), `noul` (yes/no probability), and `score` (rubric scale).
- **Skill Discovery (`jev_find_skill` tool)**: Semantically matches and suggests the most relevant specialized agent skills (`SKILL.md`) for any task without cluttering prompt context.
- **Tool Discovery (`jev_find_tools` tool)**: Semantically evaluates and identifies relevant registered tools in DeepSeek Harness for a user task.
- **Human Slash Commands (`/jev`)**:
  - `/jev status` — Displays TypeSafe Jev configuration, key origin, session metrics (requests, tokens, latency), and tool/skill counts.
  - `/jev test [prompt]` — Run live connectivity test or evaluate a prompt against Jev.
  - `/jev skills [query]` — Semantically search and rank available skills directly from the chat box.
  - `/jev tools [query]` — Semantically search and rank available tools directly from the chat box.
  - `/jev auto [on|off]` — Toggle automatic per-prompt skill suggestions.
  - `/jev help` — Display help.
- **Auto Mode Hook (`agent/pre-step`)**: Opt-in background evaluation that semantically detects matching skills for incoming user prompts and injects guidance to invoke the relevant `skill` tool before executing actions.
- **Post-Run Gate CLI (`dsh-jev-gate` / `jev-gate`)**: Standalone binary for CI/CD pipelines, subagents, or verification gates. Checks git diff (`HEAD` or cached), file, or stdin against natural language acceptance criteria using Jev probability (exits `0` on pass, `1` on reject, `2` on error).
- **Graceful Fallback & Zero Crash**: Fails open to local keyword heuristic shortlists when Jev is unconfigured or offline, ensuring uninterrupted agent execution.

### Architectural Differences from Pi Jev

In keeping with DeepSeek Harness's design:
- **Subagents**: DSH possesses its own first-party native subagent service (`@deepseek-ai/dsh-subagent` with typert protocol and session trees); external RPC workflow scripts from `pi-subagents` are omitted in favor of DSH's native architecture.
- **Model Selection**: DSH manages model presets and reasoning effort via `agent-default-model` and `settings.yaml`; auto-model switching per prompt is omitted to prevent overriding user-configured preset pipelines.
- **Compaction**: DSH's session log projection is handled natively by `@deepseek-ai/dsh-compaction`.

---

## Installation in DeepSeek Harness

### 1. Link or Install the Plugin

In your DSH profile directory (e.g. `~/.dsh/profiles/web`):

```bash
# Install via GitHub or local link
pnpm add github:lldois/dsh-jev
# or link local workspace
pnpm add file:C:/Users/lldois/workspace/dsh-jev
```

### 2. Register in Profile Bundles

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

The bundled `cordis.patch.yml` will automatically insert `id: jev` into the Cordis plugin loader.

---

## Setup & Credentials

Set your TypeSafe API key via any of the following methods:

1. **Environment variable**:
   ```bash
   export TYPESAFE_API_KEY=your_key_here
   ```
2. **DSH secret file**:
   Write the key to `~/.dsh/secrets/typesafe_api_key`.
3. **Cross-agent secret file**:
   Write to `~/.pi/agent/secrets/typesafe_api_key`.
4. **Workspace `.env`**:
   Located in `workspace/chat/typesafe-eval/.env`.
5. **DSH Settings**:
   Configured in `~/.dsh/settings.yaml` under the `jev:` namespace.

Verify your setup by running:
```text
/jev status
```

---

## Tools

### 1. `jev_evaluate`
Used by the model to get structured decisions, classifications, triage, and scoring.

```json
{
  "state": "The user reported an unexpected 500 error on /api/checkout",
  "questions": {
    "is_incident": {
      "type": "noul",
      "instructions": "Is this message reporting a production incident?"
    },
    "category": {
      "type": "choice",
      "instructions": "Which service does this error belong to?",
      "criteria": {
        "checkout": "Payments and checkout flow",
        "auth": "User authentication and tokens",
        "search": "Catalog search service"
      }
    },
    "severity": {
      "type": "score",
      "instructions": "Rate severity of the issue",
      "criteria": ["minor", "major", "critical"]
    }
  }
}
```

### 2. `jev_find_skill`
Used by the agent or user to semantically find specialized workflows and instructions for complex tasks.

```json
{
  "query": "build accessible modal component in React",
  "threshold": 0.65
}
```

### 3. `jev_find_tools`
Used by the agent to find the most relevant tools registered in the current session.

```json
{
  "query": "query database table schema and row count"
}
```

---

## CLI Gate Checker (`dsh-jev-gate` / `jev-gate`)

Check git changes or command output against natural language criteria:

```bash
# Check git diff against acceptance criteria
dsh-jev-gate -c "All exports have TypeScript type annotations" -d

# Check piped test/lint output
npm test 2>&1 | dsh-jev-gate -c "Zero test failures and no unhandled rejections"

# JSON output with custom threshold
dsh-jev-gate -c "Documentation updated" -f ./README.md -p 0.85 --json
```

Exits with `0` on pass, `1` on reject, `2` on error (or `0` with `--fail-open`).

---

## Running Tests

```bash
node --test test/*.test.js
```

---

## License

MIT © [lldois](https://github.com/lldois)

