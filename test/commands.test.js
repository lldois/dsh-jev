import test from "node:test";
import assert from "node:assert/strict";
import { registerJevCommands, executeJevCommand } from "../lib/commands.js";
import { AutoController, installAutoHook } from "../lib/auto.js";

test("commands: /jev status and help return proper text", async () => {
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
  assert.match(statusRes.text, /TypeSafe Jev System One Status/);
  assert.match(statusRes.text, /Configured: Yes/);
  assert.match(statusRes.text, /Session Requests: 5/);
  assert.match(statusRes.text, /Auto Mode: OFF/);

  // Test help
  const helpRes = await registeredDef.handler({ rawInput: "help" });
  assert.equal(helpRes.kind, "success");
  assert.match(helpRes.text, /Available options:/);
  assert.match(helpRes.text, /\/jev status/);
  assert.match(helpRes.text, /\/jev test/);

  // Test auto toggle
  const autoOn = await registeredDef.handler({ rawInput: "auto on" });
  assert.equal(autoOn.kind, "success");
  assert.match(autoOn.text, /Auto Mode enabled/);
  assert.equal(autoController.enabled, true);

  const autoOff = await registeredDef.handler({ rawInput: "auto off" });
  assert.equal(autoOff.kind, "success");
  assert.match(autoOff.text, /Auto Mode disabled/);
  assert.equal(autoController.enabled, false);

  // Test invalid subcommand
  const errRes = await registeredDef.handler({ rawInput: "unknown_cmd" });
  assert.equal(errRes.kind, "error");
  assert.match(errRes.text, /Unknown command/);
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
  assert.match(res1.text, /TypeSafe Jev System One Status/);

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
  assert.match(reminder.content[0].text, /TypeSafe Jev System One Status/);
});
