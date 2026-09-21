import test from "node:test";
import assert from "node:assert/strict";
import { registerJevCommands, executeJevCommand, resolveSubcommand } from "../lib/commands.js";
import { AutoController, installAutoHook } from "../lib/auto.js";

test("commands: resolveSubcommand handles aliases, case, and typos", () => {
  assert.equal(resolveSubcommand("stat").resolved, "status");
  assert.equal(resolveSubcommand("stauts").resolved, "status");
  assert.equal(resolveSubcommand("INFO").resolved, "status");
  assert.equal(resolveSubcommand("tset").resolved, "test");
  assert.equal(resolveSubcommand("eval").resolved, "test");
  assert.equal(resolveSubcommand("skill").resolved, "skills");
  assert.equal(resolveSubcommand("tool").resolved, "tools");
  assert.equal(resolveSubcommand("aut").resolved, "auto");
  assert.equal(resolveSubcommand("?").resolved, "help");

  // Unknown with close suggestion
  const typo = resolveSubcommand("statu");
  assert.equal(typo.resolved, null);
  assert.equal(typo.suggestion, "status");

  // Far unknown
  const far = resolveSubcommand("xyz123");
  assert.equal(far.resolved, null);
  assert.equal(far.suggestion, null);
});

test("commands: /jev status and help return proper text with headline summaries", async () => {
  let registeredDef = null;
  const fakeCtx = {
    commands: {
      register: (def) => {
        registeredDef = def;
        return () => {};
      }
    },
    tools: {
      view: () => ({ visible: new Map([["web_search", { name: "web_search", description: "search" }]]) })
    }
  };

  const mockClient = {
    isConfigured: () => true,
    getKeyOrigin: () => "\$TYPESAFE_API_KEY",
    defaultModel: "jev-latest",
    baseURL: "https://api.typesafe.ai",
    stats: { requestsCount: 5, totalTokens: 1200, lastElapsedMs: 320, lastError: null }
  };

  const autoController = new AutoController({ enabled: false });

  registerJevCommands(fakeCtx, mockClient, autoController);
  assert.equal(registeredDef.name, "jev");

  // Test status
  const statusRes = await registeredDef.handler({ rawInput: "status" });
  assert.equal(statusRes.kind, "success");
  assert.match(statusRes.text, /\[Jev Status\] Ready/);
  assert.match(statusRes.text, /Configured: Yes/);
  assert.match(statusRes.text, /Session Requests: 5/);
  assert.match(statusRes.text, /Auto Mode: OFF/);

  // Test alias
  const aliasRes = await registeredDef.handler({ rawInput: "stat" });
  assert.equal(aliasRes.kind, "success");
  assert.match(aliasRes.text, /\[Jev Status\] Ready/);

  // Test help
  const helpRes = await registeredDef.handler({ rawInput: "help" });
  assert.equal(helpRes.kind, "success");
  assert.match(helpRes.text, /\[Jev Help\]/);
  assert.match(helpRes.text, /\/jev status/);
  assert.match(helpRes.text, /\/jev test/);

  // Test auto toggle
  const autoOn = await registeredDef.handler({ rawInput: "auto on" });
  assert.equal(autoOn.kind, "success");
  assert.match(autoOn.text, /\[Jev Auto\] Enabled/);
  assert.equal(autoController.enabled, true);

  const autoOff = await registeredDef.handler({ rawInput: "auto off" });
  assert.equal(autoOff.kind, "success");
  assert.match(autoOff.text, /\[Jev Auto\] Disabled/);
  assert.equal(autoController.enabled, false);

  // Test typo with suggestion
  const typoRes = await registeredDef.handler({ rawInput: "statu" });
  assert.equal(typoRes.kind, "error");
  assert.match(typoRes.text, /Did you mean "\/jev status"/);

  // Test completely unknown subcommand
  const errRes = await registeredDef.handler({ rawInput: "unknown_cmd" });
  assert.equal(errRes.kind, "error");
  assert.match(errRes.text, /\[Jev Error\] Unknown command/);
});

test("commands: direct execution and pre-step prompt interception for blank session", async () => {
  const mockClient = {
    isConfigured: () => true,
    getKeyOrigin: () => "\$TYPESAFE_API_KEY",
    defaultModel: "jev-latest",
    baseURL: "https://api.typesafe.ai",
    stats: { requestsCount: 0, totalTokens: 0, lastElapsedMs: 0, lastError: null }
  };
  const autoController = new AutoController({ enabled: false });

  // Test direct executeJevCommand with leading slash or without
  const res1 = await executeJevCommand("/jev status", { jevClient: mockClient, autoController });
  assert.equal(res1.kind, "success");
  assert.match(res1.text, /\[Jev Status\]/);

  // Test with full-width slash
  const res2 = await executeJevCommand("／jev info", { jevClient: mockClient, autoController });
  assert.equal(res2.kind, "success");
  assert.match(res2.text, /\[Jev Status\]/);

  // Test pre-step hook intercepting /jev command in user message
  let hookHandler = null;
  const fakeCtx = {
    on: (evt, fn) => {
      if (evt === "agent/pre-step") hookHandler = fn;
    }
  };

  installAutoHook(fakeCtx, mockClient, autoController);
  assert.ok(hookHandler);

  const initialDecision = {
    kind: "enter",
    messages: [
      {
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "/jev status" }]
      }
    ]
  };

  const intercepted = await hookHandler(
    { agent: {}, messages: initialDecision.messages, signal: new AbortController().signal },
    async () => initialDecision
  );

  assert.equal(intercepted.kind, "enter");
  assert.equal(intercepted.messages.length, 2);
  const reminder = intercepted.messages[1];
  assert.equal(reminder.source.kind, "jev-command-interceptor");
  assert.match(reminder.content[0].text, /\[Jev Status\]/);
});
