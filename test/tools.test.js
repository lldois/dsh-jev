import test from "node:test";
import assert from "node:assert/strict";
import {
  createJevEvaluateTool,
  createJevFindSkillTool,
  createJevFindToolsTool,
  renderJevEvaluateResult,
  registerJevTools
} from "../lib/tools.js";
import { shortlistSkills, findSkills } from "../lib/skills.js";
import { shortlistTools, findTools, isJevTool } from "../lib/tool-router.js";

test("tools: renderJevEvaluateResult formats output properly", () => {
  const result = renderJevEvaluateResult({
    model: "jev-1.13.0",
    elapsedMs: 250,
    answers: {
      is_billing: { type: "noul", value: 0.95 },
      category: { type: "choice", value: "billing", confidence: 0.9, distribution: { billing: 0.9, other: 0.1 } },
      severity: { type: "score", value: 2.5, confidence: 0.8 }
    },
    usage: { input_tokens: 120, output_tokens: 24 }
  });

  assert.match(result, /Jev System One Evaluation/);
  assert.match(result, /is_billing: 0.95 \(yes probability: 95.0%\)/);
  assert.match(result, /category: "billing"/);
  assert.match(result, /severity: 2.5/);
  assert.match(result, /Tokens: 120 in \/ 24 out/);
});

test("tools: shortlistSkills matches keywords correctly", () => {
  const skills = [
    { name: "git-conflicts", description: "Resolve git merge conflicts and rebase issues" },
    { name: "ui-design", description: "Design frontend UI components in CSS and React" },
    { name: "database-tuning", description: "Optimize SQL queries and database indexes" }
  ];

  const matched = shortlistSkills(skills, "how to fix git merge conflict");
  assert.equal(matched.length, 3);
  assert.equal(matched[0].name, "git-conflicts");
});

test("tools: shortlistTools filters internal tools and ranks candidates", () => {
  assert.equal(isJevTool("jev_evaluate"), true);
  assert.equal(isJevTool("jev_find_skill"), true);
  assert.equal(isJevTool("web_search"), false);

  const tools = [
    { name: "web_search", description: "Search the web for current documentation and facts" },
    { name: "read_file", description: "Read local file contents from filesystem" },
    { name: "exec_pwsh", description: "Execute powershell command in terminal" }
  ];

  const matched = shortlistTools(tools, "search web for react docs");
  assert.equal(matched[0].name, "web_search");
});

test("tools: createJevEvaluateTool executes correctly", async () => {
  const mockClient = {
    isConfigured: () => true,
    evaluate: async (req) => ({
      model: "jev-test",
      answers: {
        check: { type: "noul", value: 0.88 }
      },
      elapsedMs: 150
    })
  };

  const tool = createJevEvaluateTool({}, mockClient);
  assert.equal(tool.name, "jev_evaluate");

  const res = await tool.execute({
    state: "Testing tool execution",
    questions: { check: { type: "noul", instructions: "Is this working?" } }
  });

  assert.equal(res.answers.check.value, 0.88);
});

test("tools: findSkills and findTools handle graceful fallback when below hard threshold", async () => {
  const fakeCtx = {
    skills: {
      list: async () => [
        { name: "hatch-pet", description: "Create animated v2 pets, mascots and sprites" },
        { name: "pdf", description: "PDF generation and rendering" }
      ]
    },
    tools: {
      view: () => ({
        visible: new Map([
          ["imagegen", { name: "imagegen", description: "Generate raster images from prompt" }],
          ["git_cli", { name: "git_cli", description: "Run git commands" }]
        ])
      })
    }
  };

  // Mock Jev returning lower confidence for nuance (e.g. 0.45, below 0.65 threshold)
  const mockClient = {
    isConfigured: () => true,
    evaluate: async (req) => {
      const answers = {};
      for (const k of Object.keys(req.questions)) {
        if (k === "hatch-pet" || k === "imagegen") {
          answers[k] = { type: "noul", value: 0.45 };
        } else {
          answers[k] = { type: "noul", value: 0.05 };
        }
      }
      return { model: "jev-mock", answers, elapsedMs: 100 };
    }
  };

  // Test findSkills graceful fallback
  const skillRes = await findSkills({
    query: "create a custom pixel companion mascot",
    threshold: 0.65,
    ctx: fakeCtx,
    jevClient: mockClient
  });

  assert.equal(skillRes.isLowConfidence, true);
  assert.equal(skillRes.recommended.length, 1);
  assert.equal(skillRes.recommended[0].name, "hatch-pet");
  assert.equal(skillRes.recommended[0].probability, 0.45);

  const skillTool = createJevFindSkillTool(fakeCtx, mockClient);
  const renderedSkill = skillTool.output.render({}, skillRes);
  assert.match(renderedSkill[0].text, /No skills reached high confidence/);
  assert.match(renderedSkill[0].text, /hatch-pet/);

  // Test findTools graceful fallback
  const toolRes = await findTools({
    query: "generate an avatar portrait",
    threshold: 0.65,
    ctx: fakeCtx,
    jevClient: mockClient
  });

  assert.equal(toolRes.isLowConfidence, true);
  assert.equal(toolRes.recommended.length, 1);
  assert.equal(toolRes.recommended[0].name, "imagegen");
  assert.equal(toolRes.recommended[0].probability, 0.45);

  const toolTool = createJevFindToolsTool(fakeCtx, mockClient);
  const renderedTool = toolTool.output.render({}, toolRes);
  assert.match(renderedTool[0].text, /No tools reached high confidence/);
  assert.match(renderedTool[0].text, /imagegen/);
});

test("tools: registerJevTools registers all three tools", () => {
  const registered = [];
  const fakeCtx = {
    tools: {
      register: (t) => registered.push(t.name)
    }
  };
  const mockClient = { isConfigured: () => true };

  registerJevTools(fakeCtx, mockClient);
  assert.deepEqual(registered, ["jev_evaluate", "jev_find_skill", "jev_find_tools"]);
});
