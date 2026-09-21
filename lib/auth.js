import * as fs from 'node:fs';
import * as path from 'node:path';
import { credentialsPath, keySituation, keySourceLabel, piTypesafeDir } from './credentials.js';

const AUTH_VERSION = 1;
const REJECTED_STATUSES = new Set([401, 403]);

export function authStatePath() {
  return path.join(piTypesafeDir(), 'auth-state.json');
}

function readState(p) {
  try {
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      verifiedAt: typeof parsed.verifiedAt === 'string' ? parsed.verifiedAt : undefined,
      lastFailure: parsed.lastFailure && typeof parsed.lastFailure === 'object' ? parsed.lastFailure : undefined,
    };
  } catch {
    return {};
  }
}

function writeState(p, state) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: AUTH_VERSION, ...state }, null, 2)}\n`, { mode: 0o600, flag: 'w' });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, p);
  } catch {}
}

export function authState(options = {}) {
  const p = options.path || authStatePath();
  const situation = keySituation();
  const stored = readState(p);
  const source = situation.kind === 'environment' ? 'environment' : situation.kind === 'stored' ? 'stored' : undefined;
  const status = stored.lastFailure?.status;
  const rejected = status !== undefined && REJECTED_STATUSES.has(status);
  const usable = source !== undefined && !rejected;

  return {
    kind: situation.kind,
    source,
    path: situation.kind === 'unusable' ? situation.path : (situation.path || credentialsPath()),
    reason: situation.reason,
    keyName: keySourceLabel(situation),
    verified: stored.verifiedAt !== undefined && !rejected,
    verifiedAt: stored.verifiedAt,
    lastFailure: stored.lastFailure,
    usable,
  };
}

export function recordAuthVerified(at = new Date()) {
  writeState(authStatePath(), { verifiedAt: at.toISOString() });
}

export function recordAuthFailure(error, at = new Date()) {
  const current = readState(authStatePath());
  const failure = {
    code: error?.code || 'error',
    message: String(error?.message || error).slice(0, 300),
    at: at.toISOString(),
    ...(typeof error?.status === 'number' ? { status: error.status } : {}),
  };
  writeState(authStatePath(), {
    ...(current.verifiedAt ? { verifiedAt: current.verifiedAt } : {}),
    lastFailure: failure,
  });
}

export function clearAuthState() {
  try {
    const p = authStatePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

export function describeAuth(state = authState()) {
  const since = state.lastFailure
    ? ` Last failure: ${state.lastFailure.message}${state.lastFailure.at ? ` (${state.lastFailure.at})` : ''}`
    : '';

  if (state.kind === 'missing') {
    return {
      level: 'error',
      text: `TypeSafe key: missing — judgments are skipped until a key is configured (/typesafe login or TYPESAFE_API_KEY).${since}`,
    };
  }
  if (state.kind === 'unusable') {
    return {
      level: 'error',
      text: `TypeSafe key: unusable (${state.reason ?? 'unknown reason'}) — judgments are skipped until the key is fixed.${since}`,
    };
  }
  const status = state.lastFailure?.status;
  if (status !== undefined && REJECTED_STATUSES.has(status)) {
    return {
      level: 'error',
      text: `TypeSafe key: ${state.keyName} was rejected (HTTP ${status}).${since}`,
    };
  }
  if (!state.verified) {
    return {
      level: 'warning',
      text: `TypeSafe key: ${state.keyName} (configured; first request will verify).${since}`,
    };
  }
  return {
    level: 'ok',
    text: `TypeSafe key: ${state.keyName} (verified${state.verifiedAt ? ` ${state.verifiedAt}` : ''}).${since}`,
  };
}

