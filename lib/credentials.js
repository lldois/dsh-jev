import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Directory where pi-typesafe auth, usage, and state files live.
 * Defaults to ~/.pi/agent/pi-typesafe, or ~/.dsh/pi-typesafe if PI_CODING_AGENT_DIR is not set.
 */
export function piTypesafeDir() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    const dir = configured === '~' || configured.startsWith('~/')
      ? path.join(os.homedir(), configured.slice(1))
      : configured;
    return path.join(dir, 'pi-typesafe');
  }
  return path.join(os.homedir(), '.pi', 'agent', 'pi-typesafe');
}

/**
 * Path to ~/.pi/agent/pi-typesafe/auth.json
 */
export function credentialsPath() {
  return path.join(piTypesafeDir(), 'auth.json');
}

/**
 * Native DSH secret path: ~/.dsh/secrets/typesafe_api_key
 */
export function dshSecretPath() {
  return path.join(os.homedir(), '.dsh', 'secrets', 'typesafe_api_key');
}

/**
 * Shared cross-agent secret path: ~/.pi/agent/secrets/typesafe_api_key
 */
export function piSecretPath() {
  return path.join(os.homedir(), '.pi', 'agent', 'secrets', 'typesafe_api_key');
}

/**
 * Validate that the input looks like a valid TypeSafe API key.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeApiKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 16 || key.length > 512 || /\s/.test(key) || /[^\x21-\x7e]/.test(key)) {
    throw new Error('That does not look like a TypeSafe API key. Copy the complete key from console.typesafe.ai and try again.');
  }
  return key;
}

/**
 * Read the stored API key from auth.json, or fallback to secrets files.
 * @returns {string | undefined}
 */
export function readStoredApiKey() {
  const authPath = credentialsPath();
  try {
    if (fs.existsSync(authPath)) {
      if (process.platform !== 'win32') {
        const mode = fs.statSync(authPath).mode;
        if ((mode & 0o077) !== 0) {
          throw new Error(`Refusing to read ${authPath}: it is readable by other users. Run chmod 600 on it, or run /typesafe login.`);
        }
      }
      const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      const key = parsed?.apiKey || parsed?.key;
      if (typeof key === 'string' && key.trim()) {
        return key.trim();
      }
    }
  } catch (err) {
    if (err?.message?.includes('readable by other users')) throw err;
  }

  // Fallback 1: DSH secret file
  const dshPath = dshSecretPath();
  if (fs.existsSync(dshPath)) {
    try {
      const val = fs.readFileSync(dshPath, 'utf8').trim();
      if (val) return val;
    } catch {}
  }

  // Fallback 2: cross-agent secret file
  const piPath = piSecretPath();
  if (fs.existsSync(piPath)) {
    try {
      const val = fs.readFileSync(piPath, 'utf8').trim();
      if (val) return val;
    } catch {}
  }

  return undefined;
}

/**
 * Return detailed situation about current API key resolution.
 * @returns {{ kind: 'environment' | 'stored' | 'missing' | 'unusable', key?: string, path?: string, reason?: string }}
 */
export function keySituation() {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) {
    return { kind: 'environment', key: fromEnv };
  }

  try {
    const stored = readStoredApiKey();
    if (stored) {
      const p = fs.existsSync(credentialsPath()) ? credentialsPath() : dshSecretPath();
      return { kind: 'stored', key: stored, path: p };
    }
    return { kind: 'missing' };
  } catch (err) {
    return { kind: 'unusable', path: credentialsPath(), reason: err?.message || String(err) };
  }
}

/**
 * Short human label for the key source.
 * @param {{ kind: string }} situation
 * @returns {string}
 */
export function keySourceLabel(situation) {
  switch (situation.kind) {
    case 'environment': return 'TYPESAFE_API_KEY';
    case 'stored': return credentialsPath();
    case 'missing': return 'no key';
    case 'unusable': return 'unusable key';
    default: return 'unknown';
  }
}

/**
 * Store API key to ~/.pi/agent/pi-typesafe/auth.json and mirror to ~/.dsh/secrets/typesafe_api_key.
 * @param {unknown} value
 * @returns {string} Path where key was stored
 */
export function storeApiKey(value) {
  const key = normalizeApiKey(value);
  const p = credentialsPath();

  // 1. Write to ~/.pi/agent/pi-typesafe/auth.json
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { mode: 0o600, flag: 'w' });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, p);
  } catch (err) {
    throw new Error(`Could not write ${p}: ${err.message}`);
  }

  // 2. Mirror to ~/.dsh/secrets/typesafe_api_key for DSH native tools/scripts
  try {
    const dshP = dshSecretPath();
    fs.mkdirSync(path.dirname(dshP), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dshP, key, { mode: 0o600, flag: 'w' });
    try { fs.chmodSync(dshP, 0o600); } catch {}
  } catch {}

  return p;
}

/**
 * Clear stored API key from disk.
 * @returns {boolean} True if any file was removed
 */
export function clearStoredApiKey() {
  let removed = false;
  const p = credentialsPath();
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
      removed = true;
    } catch {}
  }
  const dshP = dshSecretPath();
  if (fs.existsSync(dshP)) {
    try {
      fs.unlinkSync(dshP);
      removed = true;
    } catch {}
  }
  return removed;
}

