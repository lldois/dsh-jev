import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fanOut,
  chunkEvaluationRequest,
  evaluateMany,
  evaluateAll
} from '../lib/batch.js';

test('batch: fanOut executes items with bounded concurrency preserving order', async () => {
  const items = [1, 2, 3, 4, 5];
  const results = await fanOut(items, async (item) => item * 2, { concurrency: 2 });
  
  assert.equal(results.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(results[i].ok, true);
    assert.equal(results[i].index, i);
    assert.equal(results[i].value, (i + 1) * 2);
  }
});

test('batch: chunkEvaluationRequest splits large requests', () => {
  const questions = {};
  for (let i = 0; i < 50; i++) {
    questions[`q_${i}`] = { type: 'noul', instructions: `Q ${i}` };
  }

  const req = { state: 'test state', questions };
  const chunks = chunkEvaluationRequest(req, { maxQuestions: 32 });
  assert.equal(chunks.length, 2);
  assert.equal(Object.keys(chunks[0].questions).length, 32);
  assert.equal(Object.keys(chunks[1].questions).length, 18);
});

test('batch: evaluateMany and evaluateAll merge answers across requests', async () => {
  const mockClient = {
    evaluate: async (req) => {
      const answers = {};
      for (const k of Object.keys(req.questions)) {
        answers[k] = { type: 'noul', value: 0.9 };
      }
      return {
        answers,
        model: 'jev-test',
        usage: { input_tokens: 10, output_tokens: 0 },
        elapsedMs: 50,
      };
    },
  };

  const req1 = { state: 's1', questions: { a: { type: 'noul' } } };
  const req2 = { state: 's2', questions: { b: { type: 'noul' } } };

  const res = await evaluateMany(mockClient, [req1, req2]);
  assert.equal(res.ok, true);
  assert.equal(res.usage.input_tokens, 20);
  assert.ok(res.answers.a);
  assert.ok(res.answers.b);
});

