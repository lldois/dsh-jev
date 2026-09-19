import test from 'node:test';
import assert from 'node:assert/strict';
import { registerJevCommands } from '../lib/commands.js';
import { AutoController } from '../lib/auto.js';

test('commands: /jev status and help return proper text', async () => {
  let registeredDef = null;
  const fakeCtx = {
    commands: {
      register: (def) => {
        registeredDef = def;
        return () => {};
      }
    },
    tools: {
      view: () => ({ visible: new Map([['web_search', { name: 'web_search', description: 'search' }]]) })
    }
  };

  const mockClient = {
    isConfigured: () => true,
    getKeyOrigin: () => '$TYPESAFE_API_KEY',
    defaultModel: 'jev-latest',
    baseURL: 'https://api.typesafe.ai',
    stats: { requestsCount: 5, totalTokens: 1200, lastElapsedMs: 320, lastError: null }
  };

  const autoController = new AutoController({ enabled: false });

  registerJevCommands(fakeCtx, mockClient, autoController);
  assert.equal(registeredDef.name, 'jev');

  // Test status
  const statusRes = await registeredDef.handler({ rawInput: 'status' });
  assert.equal(statusRes.kind, 'success');
  assert.match(statusRes.text, /TypeSafe Jev System One Status/);
  assert.match(statusRes.text, /Configured: Yes/);
  assert.match(statusRes.text, /Session Requests: 5/);
  assert.match(statusRes.text, /Auto Mode: OFF/);

  // Test help
  const helpRes = await registeredDef.handler({ rawInput: 'help' });
  assert.equal(helpRes.kind, 'success');
  assert.match(helpRes.text, /Available options:/);
  assert.match(helpRes.text, /\/jev status/);
  assert.match(helpRes.text, /\/jev test/);

  // Test auto toggle
  const autoOn = await registeredDef.handler({ rawInput: 'auto on' });
  assert.equal(autoOn.kind, 'success');
  assert.match(autoOn.text, /Auto Mode enabled/);
  assert.equal(autoController.enabled, true);

  const autoOff = await registeredDef.handler({ rawInput: 'auto off' });
  assert.equal(autoOff.kind, 'success');
  assert.match(autoOff.text, /Auto Mode disabled/);
  assert.equal(autoController.enabled, false);

  // Test invalid subcommand
  const errRes = await registeredDef.handler({ rawInput: 'unknown_cmd' });
  assert.equal(errRes.kind, 'error');
  assert.match(errRes.text, /Unknown command/);
});

