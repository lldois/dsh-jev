import test from 'node:test';
import assert from 'node:assert/strict';
import { JevClient } from '../lib/client.js';

test('live-probe: TypeSafe Jev real API responds with valid choices, nouls, and scores', async (t) => {
  const client = new JevClient();
  if (!client.isConfigured()) {
    t.skip('Skipping live probe: TYPESAFE_API_KEY not configured');
    return;
  }

  const res = await client.evaluate({
    state: 'Customer requested a refund for order #1082 because shipment was delayed by 3 weeks.',
    questions: {
      is_refund_request: {
        type: 'noul',
        instructions: 'Is the customer asking for a refund?',
      },
      reason: {
        type: 'choice',
        instructions: 'What is the primary reason for customer dissatisfaction?',
        criteria: {
          shipping_delay: 'Late delivery or shipping delay',
          damaged_item: 'Product arrived broken or defective',
          wrong_item: 'Received wrong product',
          buyer_remorse: 'No longer wants item',
        },
      },
      urgency: {
        type: 'score',
        instructions: 'How urgent is resolving this customer complaint?',
        criteria: ['low', 'medium', 'high', 'immediate'],
      },
    },
  });

  assert.ok(res.model, 'response contains model name');
  assert.ok(res.elapsedMs > 0, 'response tracks elapsed time');

  // Verify noul
  assert.equal(res.answers.is_refund_request.type, 'noul');
  assert.ok(res.answers.is_refund_request.value >= 0.8, 'is_refund_request probability should be high');

  // Verify choice
  assert.equal(res.answers.reason.type, 'choice');
  assert.equal(res.answers.reason.value, 'shipping_delay');
  assert.ok(res.answers.reason.confidence > 0.5, 'confidence should be high for clear shipping delay');

  // Verify score
  assert.equal(res.answers.urgency.type, 'score');
  assert.ok(typeof res.answers.urgency.value === 'number', 'score should be numeric');

  // Verify usage
  assert.ok(res.usage, 'usage object returned');
  assert.ok(res.usage.input_tokens > 0, 'input tokens counted');
});

