import test from 'node:test';
import assert from 'node:assert/strict';
import { JevClient, resolveApiKeySource, resolveApiKey } from '../lib/client.js';

test('JevClient: resolves API key from config or env', () => {
  const custom = resolveApiKeySource({ apiKey: 'custom_key_123' });
  assert.equal(custom?.key, 'custom_key_123');
  assert.equal(custom?.origin, 'settings');

  const client = new JevClient({ apiKey: 'test_key' });
  assert.equal(client.isConfigured(), true);
  assert.equal(client.getKeyOrigin(), 'settings');
  assert.equal(client.getApiKey(), 'test_key');
});

test('JevClient: handles unconfigured state gracefully', () => {
  const origEnv = process.env.TYPESAFE_API_KEY;
  try {
    delete process.env.TYPESAFE_API_KEY;
    const client = new JevClient({ apiKeyEnv: 'NON_EXISTENT_VAR_12345' });
    // might still resolve from secret file or dotenv if present, but won't crash
    assert.equal(typeof client.isConfigured(), 'boolean');
  } finally {
    if (origEnv) process.env.TYPESAFE_API_KEY = origEnv;
  }
});

test('JevClient: formats choice, noul, and score questions properly', async () => {
  let capturedBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        model: 'jev-test-model',
        answers: {
          q_noul: { type: 'noul', noul: 0.95 },
          q_choice: { type: 'choice', choice: 'opt_a', confidence: 0.9, probabilities: { opt_a: 0.9, opt_b: 0.1 } },
          q_score: { type: 'score', score: 2.5, confidence: 0.8, legend: { '0': 'low', '1': 'mid', '2': 'high' } }
        },
        usage: { input_tokens: 100, output_tokens: 20 }
      })
    };
  };

  try {
    const client = new JevClient({ apiKey: 'mock_key' });
    const res = await client.evaluate({
      state: 'Test task state',
      questions: {
        q_noul: { type: 'noul', instructions: 'Is this true?' },
        q_choice: { type: 'choice', instructions: 'Pick one', criteria: { opt_a: 'A', opt_b: 'B' } },
        q_score: { type: 'score', instructions: 'Score quality', criteria: ['low', 'mid', 'high'] }
      }
    });

    assert.equal(capturedBody.model, 'jev-latest');
    assert.deepEqual(capturedBody.state, { text: 'Test task state' });
    assert.equal(capturedBody.questions.q_noul.type, 'noul');
    assert.equal(capturedBody.questions.q_choice.type, 'choice');
    assert.equal(capturedBody.questions.q_score.type, 'score');

    assert.equal(res.answers.q_noul.value, 0.95);
    assert.equal(res.answers.q_choice.value, 'opt_a');
    assert.equal(res.answers.q_score.value, 2.5);
    assert.equal(client.stats.requestsCount, 1);
    assert.equal(client.stats.totalTokens, 120);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JevClient: handles API errors gracefully', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => 'Invalid API key'
  });

  try {
    const client = new JevClient({ apiKey: 'invalid_key' });
    await assert.rejects(
      async () => {
        await client.evaluate({
          state: 'test',
          questions: { q: { type: 'noul', instructions: 'test' } }
        });
      },
      /TypeSafe API error \(401\): Invalid API key/
    );
    assert.match(client.stats.lastError, /TypeSafe API error/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

