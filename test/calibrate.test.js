import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auc,
  metricsAt,
  sweep,
  defaultThresholds,
  pickThreshold,
  calibrate,
  formatCalibration,
  replay,
  samplesOf,
} from '../lib/calibrate.js';

test('calibrate: calculates AUC and metrics accurately', () => {
  const perfectSamples = [
    { label: true, score: 0.9 },
    { label: true, score: 0.8 },
    { label: false, score: 0.2 },
    { label: false, score: 0.1 },
  ];
  assert.equal(auc(perfectSamples), 1.0);

  const invertedSamples = [
    { label: true, score: 0.1 },
    { label: false, score: 0.9 },
  ];
  assert.equal(auc(invertedSamples), 0.0);

  const m = metricsAt(perfectSamples, 0.5);
  assert.equal(m.tp, 2);
  assert.equal(m.fp, 0);
  assert.equal(m.precision, 1.0);
  assert.equal(m.recall, 1.0);
});

test('calibrate: calibrate and pickThreshold select optimal boundary', () => {
  const samples = [
    { label: true, score: 0.95, id: 's1' },
    { label: true, score: 0.85, id: 's2' },
    { label: true, score: 0.70, id: 's3' },
    { label: false, score: 0.65, id: 's4' },
    { label: false, score: 0.30, id: 's5' },
    { label: false, score: 0.10, id: 's6' },
  ];

  const cal = calibrate('TestCal', samples, { minPrecision: 0.9 });
  assert.ok(cal.auc > 0.8);
  assert.ok(cal.recommended);
  assert.equal(cal.recommended.threshold, 0.70);
  assert.equal(cal.missed.length, 0);

  const text = formatCalibration(cal);
  assert.match(text, /TestCal:/);
  assert.match(text, /recommended 0.70:/);
});

test('calibrate: replay runs bounded concurrency scorer', async () => {
  const cases = [
    { id: 'c1', label: true, data: 'fast' },
    { id: 'c2', label: false, data: 'slow' },
  ];

  const results = await replay(cases, async (data) => {
    return data === 'fast' ? 0.9 : 0.1;
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].score, 0.9);
  assert.equal(results[1].score, 0.1);

  const { samples, errors } = samplesOf(results);
  assert.equal(samples.length, 2);
  assert.equal(errors, 0);
});

