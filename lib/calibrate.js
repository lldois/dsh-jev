import { fanOut } from './batch.js';

/**
 * A judge-tuning toolkit: label a set of cases, score them with Jev, and read off AUC and threshold behavior.
 */

/**
 * Compute Mann-Whitney U rank-based AUC.
 * Ties count half. Undefined when one class is empty.
 * @param {Array<{ label: boolean, score: number }>} samples
 * @returns {number | undefined}
 */
export function auc(samples) {
  const positives = samples.filter((s) => s.label).map((s) => s.score);
  const negatives = samples.filter((s) => !s.label).map((s) => s.score);
  if (!positives.length || !negatives.length) return undefined;

  let wins = 0;
  for (const pos of positives) {
    for (const neg of negatives) {
      wins += pos > neg ? 1 : pos === neg ? 0.5 : 0;
    }
  }
  return wins / (positives.length * negatives.length);
}

function ratio(num, den) {
  return den ? num / den : undefined;
}

/**
 * Counts at one threshold: a case is flagged when score >= threshold.
 * @param {Array<{ label: boolean, score: number }>} samples
 * @param {number} threshold
 */
export function metricsAt(samples, threshold) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const s of samples) {
    const flagged = s.score >= threshold;
    if (flagged && s.label) tp++;
    else if (flagged) fp++;
    else if (s.label) fn++;
    else tn++;
  }
  const flagged = tp + fp;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    threshold,
    flagged,
    tp,
    fp,
    fn,
    tn,
    ...(precision === undefined ? {} : { precision }),
    ...(recall === undefined ? {} : { recall }),
    flagRate: samples.length ? flagged / samples.length : 0,
  };
}

/**
 * Sweep metrics across a grid of thresholds.
 * @param {Array<{ label: boolean, score: number }>} samples
 * @param {Array<number>} thresholds
 */
export function sweep(samples, thresholds) {
  return thresholds.map((t) => metricsAt(samples, t));
}

/**
 * Ascending distinct scores as threshold grid (max limit rows).
 * @param {Array<{ label: boolean, score: number }>} samples
 * @param {number} [limit=64]
 * @returns {Array<number>}
 */
export function defaultThresholds(samples, limit = 64) {
  const distinct = [...new Set(samples.map((s) => s.score))].sort((a, b) => a - b);
  if (distinct.length <= limit) return distinct;
  const step = (distinct.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, idx) => distinct[Math.round(idx * step)]);
}

/**
 * Pick optimal threshold meeting precision and recall floors, or best F1.
 * @param {Array<object>} rows
 * @param {{ minPrecision?: number, minRecall?: number }} [options]
 */
export function pickThreshold(rows, options = {}) {
  const { minPrecision, minRecall } = options;
  if (minPrecision === undefined && minRecall === undefined) {
    let best = undefined;
    let bestF1 = -1;
    for (const row of rows) {
      if (row.precision === undefined || row.recall === undefined) continue;
      const f1 = row.precision + row.recall === 0 ? 0 : (2 * row.precision * row.recall) / (row.precision + row.recall);
      if (f1 > bestF1) {
        bestF1 = f1;
        best = row;
      }
    }
    return best;
  }

  const candidates = rows
    .filter(
      (r) =>
        (minPrecision === undefined || (r.precision ?? 0) >= minPrecision) &&
        (minRecall === undefined || (r.recall ?? 0) >= minRecall)
    )
    .sort((a, b) => a.threshold - b.threshold);

  return candidates[0];
}

/**
 * Calibrate a classifier over labeled samples.
 * @param {string} name
 * @param {Array<{ label: boolean, score: number, id?: string }>} samples
 * @param {object} [options]
 */
export function calibrate(name, samples, options = {}) {
  const thresholds = options.thresholds || defaultThresholds(samples);
  const rows = sweep(samples, thresholds);
  const recommendation = pickThreshold(rows, {
    minPrecision: options.minPrecision,
    minRecall: options.minRecall,
  });
  const rank = auc(samples);
  const threshold = recommendation?.threshold;

  return {
    name,
    scored: samples.length,
    positives: samples.filter((s) => s.label).length,
    negatives: samples.filter((s) => !s.label).length,
    errors: options.errors || 0,
    ...(rank === undefined ? {} : { auc: rank }),
    rows,
    ...(recommendation === undefined ? {} : { recommended: recommendation }),
    missed: threshold === undefined ? [] : samples.filter((s) => s.label && s.score < threshold),
    flagged: threshold === undefined ? [] : samples.filter((s) => !s.label && s.score >= threshold),
  };
}

const percent = (v) => (v === undefined ? '-' : `${(v * 100).toFixed(0)}%`);

/**
 * Render calibration results as plain text table.
 * @param {object} cal
 * @returns {string}
 */
export function formatCalibration(cal) {
  const lines = [
    `${cal.name}: ${cal.scored} scored, ${cal.positives} positives, ${cal.negatives} negatives${cal.errors ? `, ${cal.errors} errors` : ''}`,
    `AUC ${cal.auc === undefined ? '-' : cal.auc.toFixed(3)}`,
    'threshold  flagged  TP  FP  FN  TN  precision  recall',
  ];
  for (const row of cal.rows) {
    lines.push(
      `${row.threshold.toFixed(2).padStart(9)}  ${String(row.flagged).padStart(7)}  ${String(row.tp).padStart(2)}  ${String(row.fp).padStart(2)}  ${String(row.fn).padStart(2)}  ${String(row.tn).padStart(2)}  ${percent(row.precision).padStart(9)}  ${percent(row.recall).padStart(6)}`
    );
  }
  const rec = cal.recommended;
  lines.push(
    rec === undefined
      ? 'recommended: none (no threshold clears the floors)'
      : `recommended ${rec.threshold.toFixed(2)}: precision ${percent(rec.precision)}, recall ${percent(rec.recall)}, flags ${percent(rec.flagRate)}`
  );
  if (cal.missed.length) {
    lines.push(`missed positives (${cal.missed.length}): ${cal.missed.map((s) => s.id ?? s.score.toFixed(2)).join(', ').slice(0, 300)}`);
  }
  if (cal.flagged.length) {
    lines.push(`flagged negatives (${cal.flagged.length}): ${cal.flagged.map((s) => s.id ?? s.score.toFixed(2)).join(', ').slice(0, 300)}`);
  }
  return lines.join('\n');
}

/**
 * Replay labeled cases through an async scorer with bounded concurrency.
 * @param {Array<{ id: string, label: boolean, data: any }>} cases
 * @param {(data: any, index: number) => Promise<number>} scoreFn
 * @param {object} [options]
 */
export async function replay(cases, scoreFn, options = {}) {
  const settled = await fanOut(cases, (item, index) => scoreFn(item.data, index), {
    concurrency: options.concurrency,
    signal: options.signal,
    stopOn: options.stopOn,
  });

  return settled.map((res, index) => {
    const item = cases[index];
    if (res.ok) {
      return { id: item.id, label: item.label, data: item.data, score: res.value, skipped: false };
    }
    const err = options.describeError ? options.describeError(res.error) : res.error?.message || 'Scorer failed';
    return { id: item.id, label: item.label, data: item.data, error: err, skipped: res.skipped };
  });
}

/**
 * Extract scored samples from replay results.
 * @param {Array<object>} results
 */
export function samplesOf(results) {
  const samples = [];
  let errors = 0;
  for (const r of results) {
    if (r.score === undefined || !Number.isFinite(r.score)) {
      errors++;
      continue;
    }
    samples.push({ label: r.label, score: r.score, id: r.id });
  }
  return { samples, errors };
}

