import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGateArgs, evaluateGate } from '../lib/gate.js';

test('gate: parses CLI arguments correctly', () => {
  const args = parseGateArgs(['-c', 'All tests pass', '-p', '0.85', '-d', '--json', '--fail-open']);
  assert.equal(args.criteria, 'All tests pass');
  assert.equal(args.threshold, 0.85);
  assert.equal(args.diff, true);
  assert.equal(args.json, true);
  assert.equal(args.failOpen, true);
});

test('gate: evaluates pass/fail based on probability and threshold', async () => {
  const mockClientPass = {
    isConfigured: () => true,
    evaluate: async () => ({
      model: 'jev-latest',
      elapsedMs: 210,
      answers: {
        gate_passed: { type: 'noul', value: 0.92, confidence: 0.92 }
      }
    })
  };

  const passRes = await evaluateGate(
    { criteria: 'Code is clean', threshold: 0.8, state: 'function add(a, b) { return a + b; }' },
    mockClientPass
  );
  assert.equal(passRes.passed, true);
  assert.equal(passRes.probability, 0.92);

  const mockClientFail = {
    isConfigured: () => true,
    evaluate: async () => ({
      model: 'jev-latest',
      elapsedMs: 190,
      answers: {
        gate_passed: { type: 'noul', value: 0.35, confidence: 0.35 }
      }
    })
  };

  const failRes = await evaluateGate(
    { criteria: 'Code is clean', threshold: 0.8, state: 'broken code' },
    mockClientFail
  );
  assert.equal(failRes.passed, false);
  assert.equal(failRes.probability, 0.35);
});

test('gate: fail-open works when Jev is unconfigured', async () => {
  const unconfiguredClient = {
    isConfigured: () => false
  };

  const res = await evaluateGate(
    { criteria: 'Acceptance test', threshold: 0.7, state: 'test', failOpen: true },
    unconfiguredClient
  );
  assert.equal(res.passed, true);
  assert.match(res.error, /fail-open enabled/);
});

