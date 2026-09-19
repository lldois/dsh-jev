import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createJevEvaluateTool,
  createJevFindSkillTool,
  createJevFindToolsTool,
  renderJevEvaluateResult,
  registerJevTools
} from '../lib/tools.js';
import { shortlistSkills } from '../lib/skills.js';
import { shortlistTools, isJevTool } from '../lib/tool-router.js';

test('tools: renderJevEvaluateResult formats output properly', () => {
  const result = renderJevEvaluateResult({
    model: 'jev-1.13.0',
    elapsedMs: 250,
    answers: {
      is_billing: { type: 'noul', value: 0.95 },
      category: { type: 'choice', value: 'billing', confidence: 0.9, distribution: { billing: 0.9, other: 0.1 } },
      severity: { type: 'score', value: 2.5, confidence: 0.8 }
    },
    usage: { input_tokens: 120, output_tokens: 24 }
  });

  assert.match(result, /Jev System One Evaluation/);
  assert.match(result, /is_billing: 0.95 \(yes probability: 95.0%\)/);
  assert.match(result, /category: "billing"/);
  assert.match(result, /severity: 2.5/);
  assert.match(result, /Tokens: 120 in \/ 24 out/);
});

test('tools: shortlistSkills matches keywords correctly', () => {
  const skills = [
    { name: 'git-conflicts', description: 'Resolve git merge conflicts and rebase issues' },
    { name: 'ui-design', description: 'Design frontend UI components in CSS and React' },
    { name: 'database-tuning', description: 'Optimize SQL queries and database indexes' }
  ];

  const matched = shortlistSkills(skills, 'how to fix git merge conflict');
  assert.equal(matched.length, 3);
  assert.equal(matched[0].name, 'git-conflicts');
});

test('tools: shortlistTools filters internal tools and ranks candidates', () => {
  assert.equal(isJevTool('jev_evaluate'), true);
  assert.equal(isJevTool('jev_find_skill'), true);
  assert.equal(isJevTool('web_search'), false);

  const tools = [
    { name: 'web_search', description: 'Search the web for current documentation and facts' },
    { name: 'read_file', description: 'Read local file contents from filesystem' },
    { name: 'exec_pwsh', description: 'Execute powershell command in terminal' }
  ];

  const matched = shortlistTools(tools, 'search web for react docs');
  assert.equal(matched[0].name, 'web_search');
});

test('tools: createJevEvaluateTool executes correctly', async () => {
  const mockClient = {
    isConfigured: () => true,
    evaluate: async (req) => ({
      model: 'jev-test',
      answers: {
        check: { type: 'noul', value: 0.88 }
      },
      elapsedMs: 150
    })
  };

  const tool = createJevEvaluateTool({}, mockClient);
  assert.equal(tool.name, 'jev_evaluate');

  const res = await tool.execute({
    state: 'Testing tool execution',
    questions: { check: { type: 'noul', instructions: 'Is this working?' } }
  });

  assert.equal(res.answers.check.value, 0.88);
});

test('tools: registerJevTools registers all three tools', () => {
  const registered = [];
  const fakeCtx = {
    tools: {
      register: (t) => registered.push(t.name)
    }
  };
  const mockClient = { isConfigured: () => true };

  registerJevTools(fakeCtx, mockClient);
  assert.deepEqual(registered, ['jev_evaluate', 'jev_find_skill', 'jev_find_tools']);
});

