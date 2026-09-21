import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJevCommand, isTypeSafeEnabled, setTypeSafeEnabled } from '../lib/commands.js';

test('typesafe commands: /typesafe enable, disable, status, and calibrate', async () => {
  const mockClient = {
    isConfigured: () => true,
    getKeyOrigin: () => 'stored',
    getApiKey: () => 'typesafe_key_mock_123456789',
    defaultModel: 'jev-latest',
    baseURL: 'https://api.typesafe.ai',
    stats: { requestsCount: 2, totalTokens: 400, lastElapsedMs: 120 },
    getSpend: () => ({
      session: { requestsStarted: 2, requestsSucceeded: 2, requestsFailed: 0, inputTokens: 400, outputTokens: 0, estimatedUsd: 0.000016 },
      today: { requestsStarted: 2, requestsSucceeded: 2, requestsFailed: 0, inputTokens: 400, estimatedUsd: 0.000016 },
      caps: { maxRequests: 20 },
      usdPerMTok: 0.042,
    }),
  };

  // Test /typesafe status
  const statusRes = await executeJevCommand('/typesafe status', { jevClient: mockClient });
  assert.equal(statusRes.kind, 'success');
  assert.match(statusRes.text, /\[TypeSafe Status\]/);
  assert.match(statusRes.text, /Model: jev-latest/);

  // Test /typesafe enable
  const enableRes = await executeJevCommand('/typesafe enable', { jevClient: mockClient });
  assert.equal(enableRes.kind, 'success');
  assert.equal(isTypeSafeEnabled(), true);

  // Test /typesafe disable
  const disableRes = await executeJevCommand('/typesafe disable', { jevClient: mockClient });
  assert.equal(disableRes.kind, 'success');
  assert.equal(isTypeSafeEnabled(), false);

  // Re-enable
  setTypeSafeEnabled(true);
  assert.equal(isTypeSafeEnabled(), true);

  // Test /typesafe calibrate
  const calRes = await executeJevCommand('/typesafe calibrate', { jevClient: mockClient });
  assert.equal(calRes.kind, 'success');
  assert.match(calRes.text, /Threshold Calibration Toolkit/);

  // Test /typesafe help
  const helpRes = await executeJevCommand('/typesafe help', { jevClient: mockClient });
  assert.equal(helpRes.kind, 'success');
  assert.match(helpRes.text, /\[TypeSafe Help\]/);
  assert.match(helpRes.text, /\/typesafe login/);
});

