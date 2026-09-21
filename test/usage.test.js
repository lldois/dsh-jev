import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  openUsageLedger,
  estimateUsd,
  capsFromEnvironment,
  mergeCaps,
  DEFAULT_USD_PER_MTOK
} from '../lib/usage.js';

test('usage: estimateUsd calculates micro-dollar pricing accurately', () => {
  // $0.042 per million input tokens = $0.000042 per 1k tokens
  assert.equal(estimateUsd(0), 0);
  assert.equal(estimateUsd(1_000_000, 0.042), 0.042);
  assert.equal(estimateUsd(100_000, 0.042), 0.0042);
});

test('usage: ledger records requests, tokens, and checks caps', () => {
  const tmpFile = path.join(os.tmpdir(), 'dsh-jev-usage-test-' + Date.now() + '.json');
  try {
    const ledger = openUsageLedger({ path: tmpFile, usdPerMTok: DEFAULT_USD_PER_MTOK });
    
    assert.equal(ledger.today().requestsStarted, 0);
    ledger.recordStart();
    ledger.recordSuccess(1000, 20);
    assert.equal(ledger.today().requestsStarted, 1);
    assert.equal(ledger.today().requestsSucceeded, 1);
    assert.equal(ledger.today().inputTokens, 1000);

    // Check cap blocking
    const blockedUnderLimit = ledger.blocked({ maxRequestsPerDay: 5 });
    assert.equal(blockedUnderLimit, undefined);

    const blockedOverLimit = ledger.blocked({ maxRequestsPerDay: 1 });
    assert.ok(blockedOverLimit);
    assert.equal(blockedOverLimit.cap, 'requestsPerDay');
    assert.equal(blockedOverLimit.used, 1);

    // Check token cap
    const blockedToken = ledger.blocked({ maxInputTokensPerDay: 500 });
    assert.ok(blockedToken);
    assert.equal(blockedToken.cap, 'inputTokensPerDay');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('usage: capsFromEnvironment reads environment limits', () => {
  const customEnv = {
    PI_TYPESAFE_MAX_REQUESTS_PER_DAY: '50',
    PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY: '100000',
    PI_TYPESAFE_MAX_USD_PER_DAY: '2.50',
  };
  const caps = capsFromEnvironment(customEnv);
  assert.equal(caps.maxRequestsPerDay, 50);
  assert.equal(caps.maxInputTokensPerDay, 100000);
  assert.equal(caps.maxUsdPerDay, 2.5);

  const merged = mergeCaps({ maxRequests: 20 }, caps);
  assert.equal(merged.maxRequests, 20);
  assert.equal(merged.maxRequestsPerDay, 50);
});

