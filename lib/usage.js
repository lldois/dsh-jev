import * as fs from 'node:fs';
import * as path from 'node:path';
import { piTypesafeDir } from './credentials.js';

/**
 * TypeSafe bills input tokens only; output is free.
 * Default: $0.042 per million input tokens ($42 per billion).
 */
export const DEFAULT_USD_PER_MTOK = 0.042;
export const DEFAULT_MAX_REQUESTS = 20;
const KEEP_DAYS = 31;
const USAGE_VERSION = 1;

export function localDay(now = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function usagePath() {
  return path.join(piTypesafeDir(), 'usage.json');
}

export function estimateUsd(inputTokens, usdPerMTok = DEFAULT_USD_PER_MTOK) {
  return Math.round(((inputTokens * usdPerMTok) / 1e6) * 1e6) / 1e6;
}

export function emptyTotals() {
  return { requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, outputTokens: 0 };
}

function count(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

function totalsOf(raw = {}) {
  return {
    requestsStarted: count(raw.requestsStarted),
    requestsSucceeded: count(raw.requestsSucceeded),
    requestsFailed: count(raw.requestsFailed),
    inputTokens: count(raw.inputTokens),
    outputTokens: count(raw.outputTokens),
  };
}

function readDays(p) {
  try {
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const days = parsed?.days;
    if (!days || typeof days !== 'object' || Array.isArray(days)) return {};
    const result = {};
    for (const [day, totals] of Object.entries(days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        result[day] = totalsOf(totals);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function keepRecent(days, today) {
  const names = Object.keys(days).sort();
  const result = {};
  for (const name of names.slice(-KEEP_DAYS)) {
    result[name] = days[name];
  }
  result[today] = days[today] ?? emptyTotals();
  return result;
}

function writeDays(p, days) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    const payload = JSON.stringify({ version: USAGE_VERSION, days }, null, 2);
    fs.writeFileSync(tmp, `${payload}\n`, { mode: 0o600, flag: 'w' });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, p);
  } catch {}
}

export function capsFromEnvironment(env = process.env) {
  const num = (name) => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };

  const maxRequestsPerDay = num('PI_TYPESAFE_MAX_REQUESTS_PER_DAY') ?? num('DSH_JEV_MAX_REQUESTS_PER_DAY');
  const maxInputTokensPerDay = num('PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY') ?? num('DSH_JEV_MAX_INPUT_TOKENS_PER_DAY');
  const maxUsdPerDay = num('PI_TYPESAFE_MAX_USD_PER_DAY') ?? num('DSH_JEV_MAX_USD_PER_DAY');

  return {
    ...(maxRequestsPerDay !== undefined ? { maxRequestsPerDay: Math.floor(maxRequestsPerDay) } : {}),
    ...(maxInputTokensPerDay !== undefined ? { maxInputTokensPerDay: Math.floor(maxInputTokensPerDay) } : {}),
    ...(maxUsdPerDay !== undefined ? { maxUsdPerDay } : {}),
  };
}

export function mergeCaps(explicit = {}, environment = {}) {
  const lowest = (a, b) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
  return {
    ...(explicit.maxRequests !== undefined ? { maxRequests: explicit.maxRequests } : {}),
    ...(lowest(explicit.maxRequestsPerDay, environment.maxRequestsPerDay) !== undefined
      ? { maxRequestsPerDay: lowest(explicit.maxRequestsPerDay, environment.maxRequestsPerDay) }
      : {}),
    ...(lowest(explicit.maxInputTokensPerDay, environment.maxInputTokensPerDay) !== undefined
      ? { maxInputTokensPerDay: lowest(explicit.maxInputTokensPerDay, environment.maxInputTokensPerDay) }
      : {}),
    ...(lowest(explicit.maxUsdPerDay, environment.maxUsdPerDay) !== undefined
      ? { maxUsdPerDay: lowest(explicit.maxUsdPerDay, environment.maxUsdPerDay) }
      : {}),
  };
}

export function openUsageLedger(options = {}) {
  const p = options.path || usagePath();
  const now = options.now || (() => new Date());
  const usdPerMTok = options.usdPerMTok && options.usdPerMTok > 0 ? options.usdPerMTok : DEFAULT_USD_PER_MTOK;

  let day = localDay(now());
  let days = keepRecent(readDays(p), day);
  let totals = days[day];

  const report = (val, name) => ({
    ...val,
    day: name,
    estimatedUsd: estimateUsd(val.inputTokens, usdPerMTok),
  });

  const save = () => {
    days = keepRecent({ ...days, [day]: totals }, day);
    writeDays(p, days);
  };

  const roll = () => {
    const current = localDay(now());
    if (current === day) return;
    day = current;
    totals = days[day] ?? emptyTotals();
    days = keepRecent(days, day);
  };

  const add = (delta) => {
    roll();
    totals = {
      requestsStarted: totals.requestsStarted + (delta.requestsStarted || 0),
      requestsSucceeded: totals.requestsSucceeded + (delta.requestsSucceeded || 0),
      requestsFailed: totals.requestsFailed + (delta.requestsFailed || 0),
      inputTokens: totals.inputTokens + (delta.inputTokens || 0),
      outputTokens: totals.outputTokens + (delta.outputTokens || 0),
    };
    save();
  };

  return {
    path: p,
    usdPerMTok,
    today: () => {
      roll();
      return report(totals, day);
    },
    recordStart: () => add({ requestsStarted: 1 }),
    recordSuccess: (inputTokens, outputTokens) =>
      add({
        requestsSucceeded: 1,
        inputTokens: Number.isSafeInteger(inputTokens) && inputTokens > 0 ? inputTokens : 0,
        outputTokens: Number.isSafeInteger(outputTokens) && outputTokens > 0 ? outputTokens : 0,
      }),
    recordFailure: () => add({ requestsFailed: 1 }),
    blocked: (caps = {}) => {
      roll();
      const checks = [
        ['requestsPerDay', caps.maxRequestsPerDay, totals.requestsStarted],
        ['inputTokensPerDay', caps.maxInputTokensPerDay, totals.inputTokens],
        ['usdPerDay', caps.maxUsdPerDay, estimateUsd(totals.inputTokens, usdPerMTok)],
      ];
      for (const [cap, limit, used] of checks) {
        if (limit !== undefined && used >= limit) {
          return { cap, limit, used, day };
        }
      }
      return undefined;
    },
    describe: (caps = {}) => {
      roll();
      const current = report(totals, day);
      const limits = [
        caps.maxRequestsPerDay === undefined ? undefined : `${current.requestsStarted}/${caps.maxRequestsPerDay} req`,
        caps.maxInputTokensPerDay === undefined ? undefined : `${current.inputTokens}/${caps.maxInputTokensPerDay} tok`,
        caps.maxUsdPerDay === undefined ? undefined : `$${current.estimatedUsd.toFixed(4)}/$${caps.maxUsdPerDay.toFixed(2)}`,
      ].filter(Boolean);
      return `${current.requestsStarted} req today (${current.requestsSucceeded} ok, ${current.requestsFailed} err), ${current.inputTokens} in / ${current.outputTokens} out tok, ~$${current.estimatedUsd.toFixed(4)}${limits.length ? `; caps: ${limits.join(', ')}` : '; no daily cap'}`;
    },
  };
}

