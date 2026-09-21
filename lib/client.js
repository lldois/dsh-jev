import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readStoredApiKey, credentialsPath, dshSecretPath, piSecretPath, keySituation } from './credentials.js';
import { recordAuthVerified, recordAuthFailure } from './auth.js';
import {
  DEFAULT_USD_PER_MTOK,
  DEFAULT_MAX_REQUESTS,
  openUsageLedger,
  capsFromEnvironment,
  mergeCaps,
  estimateUsd,
} from './usage.js';
import { prepareEvaluationRequest, assertWithinByteLimit, DEFAULT_MAX_INPUT_BYTES } from './schema.js';
import { evaluateMany, evaluateAll } from './batch.js';

export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_MODEL = 'jev-latest';
export const DEFAULT_API_KEY_ENV = 'TYPESAFE_API_KEY';

/**
 * Resolve the API key together with where it came from, for status reporting.
 * @param {object} [config]
 * @returns {{ key: string, source: string, origin: string } | null}
 */
export function resolveApiKeySource(config = {}) {
  // 1. Explicit config apiKey
  if (config.apiKey && typeof config.apiKey === 'string' && config.apiKey.trim()) {
    return { key: config.apiKey.trim(), source: 'config', origin: 'settings' };
  }

  // 2. Custom or default env var
  const envName = config.apiKeyEnv || DEFAULT_API_KEY_ENV;
  const envKey = process.env[envName]?.trim();
  if (envKey) {
    return { key: envKey, source: 'env', origin: `$${envName}` };
  }

  // 3. Fallback to default TYPESAFE_API_KEY if custom was set but empty
  if (envName !== DEFAULT_API_KEY_ENV && process.env.TYPESAFE_API_KEY?.trim()) {
    return { key: process.env.TYPESAFE_API_KEY.trim(), source: 'env', origin: '$TYPESAFE_API_KEY' };
  }

  // 4. Stored key in ~/.pi/agent/pi-typesafe/auth.json
  const storedAuth = credentialsPath();
  if (fs.existsSync(storedAuth)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(storedAuth, 'utf8'));
      const val = parsed?.apiKey || parsed?.key;
      if (typeof val === 'string' && val.trim()) {
        return { key: val.trim(), source: 'file', origin: '~/.pi/agent/pi-typesafe/auth.json' };
      }
    } catch {}
  }

  // 5. Secret file in ~/.dsh/secrets/typesafe_api_key
  const dshSecret = dshSecretPath();
  if (fs.existsSync(dshSecret)) {
    try {
      const content = fs.readFileSync(dshSecret, 'utf8').trim();
      if (content) return { key: content, source: 'file', origin: '~/.dsh/secrets/typesafe_api_key' };
    } catch {}
  }

  // 6. Secret file in ~/.pi/agent/secrets/typesafe_api_key (cross-agent shared credential)
  const piSecret = piSecretPath();
  if (fs.existsSync(piSecret)) {
    try {
      const content = fs.readFileSync(piSecret, 'utf8').trim();
      if (content) return { key: content, source: 'file', origin: '~/.pi/agent/secrets/typesafe_api_key' };
    } catch {}
  }

  // 7. Dotenv in workspace typesafe-eval/.env
  const evalEnv = path.join(os.homedir(), 'workspace', 'chat', 'typesafe-eval', '.env');
  if (fs.existsSync(evalEnv)) {
    try {
      const lines = fs.readFileSync(evalEnv, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('TYPESAFE_API_KEY=')) {
          const val = trimmed.slice('TYPESAFE_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
          if (val) return { key: val, source: 'file', origin: 'typesafe-eval/.env' };
        }
      }
    } catch {}
  }

  return null;
}

export function resolveApiKey(config = {}) {
  return resolveApiKeySource(config)?.key ?? null;
}

export class JevClient {
  constructor(options = {}) {
    this.options = options;
    this.baseURL = (options.baseURL || process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel || process.env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs || 30000;
    this.maxInputBytes = options.maxInputBytes || DEFAULT_MAX_INPUT_BYTES;
    this.usdPerMTok = options.usdPerMTok && options.usdPerMTok > 0 ? options.usdPerMTok : DEFAULT_USD_PER_MTOK;
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;

    this.caps = mergeCaps(
      {
        maxRequests: this.maxRequests,
        ...(options.maxRequestsPerDay !== undefined ? { maxRequestsPerDay: options.maxRequestsPerDay } : {}),
        ...(options.maxInputTokensPerDay !== undefined ? { maxInputTokensPerDay: options.maxInputTokensPerDay } : {}),
        ...(options.maxUsdPerDay !== undefined ? { maxUsdPerDay: options.maxUsdPerDay } : {}),
      },
      capsFromEnvironment()
    );

    this.ledger = options.ledger || openUsageLedger({ usdPerMTok: this.usdPerMTok });

    this.stats = {
      requestsCount: 0,
      requestsStarted: 0,
      requestsSucceeded: 0,
      requestsFailed: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastElapsedMs: 0,
      lastError: null,
    };
  }

  isConfigured() {
    return Boolean(resolveApiKeySource(this.options));
  }

  getKeyOrigin() {
    return resolveApiKeySource(this.options)?.origin ?? null;
  }

  getApiKey() {
    return resolveApiKey(this.options);
  }

  getUsage() {
    return {
      requestsStarted: this.stats.requestsStarted,
      requestsSucceeded: this.stats.requestsSucceeded,
      requestsFailed: this.stats.requestsFailed,
      inputTokens: this.stats.inputTokens,
      outputTokens: this.stats.outputTokens,
      totalTokens: this.stats.totalTokens,
      estimatedUsd: estimateUsd(this.stats.inputTokens, this.usdPerMTok),
      lastElapsedMs: this.stats.lastElapsedMs,
    };
  }

  getSpend() {
    const reached = this.ledger.blocked(this.caps);
    return {
      session: this.getUsage(),
      today: this.ledger.today(),
      caps: this.caps,
      usdPerMTok: this.usdPerMTok,
      ...(reached ? { blocked: reached } : {}),
    };
  }

  /**
   * List accessible models from api.typesafe.ai/v1/models to verify key.
   * @param {{ signal?: AbortSignal }} [callOptions]
   * @returns {Promise<Array<string>>}
   */
  async listModels(callOptions = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('No API key configured for TypeSafe Jev.');
    }

    const url = `${this.baseURL}/v1/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'dsh-jev/0.1.0',
      },
      signal: callOptions.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`TypeSafe API error (${res.status}): ${errText || res.statusText}`);
      err.status = res.status;
      recordAuthFailure(err);
      throw err;
    }

    recordAuthVerified();
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.data || data?.models || [];
    return list.map((m) => (typeof m === 'string' ? m : m?.id || m?.name)).filter(Boolean);
  }

  /**
   * Run a System One evaluation with TypeSafe Jev.
   * @param {{ state: any, questions: Record<string, any>, model?: string }} rawRequest
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ answers: Record<string, any>, model: string, usage: any, elapsedMs: number }>}
   */
  async evaluate(rawRequest, signal) {
    const startTime = Date.now();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      const err = new Error('Missing TYPESAFE_API_KEY. Set it in environment, ~/.pi/agent/pi-typesafe/auth.json, or ~/.dsh/secrets/typesafe_api_key.');
      this.stats.lastError = err.message;
      throw err;
    }

    // Check session cap
    if (this.stats.requestsStarted >= this.maxRequests) {
      const err = new Error(`TypeSafe session request limit reached (${this.maxRequests} attempts per session).`);
      err.code = 'budget';
      this.stats.lastError = err.message;
      throw err;
    }

    // Check daily spend caps
    const blockedCap = this.ledger.blocked(this.caps);
    if (blockedCap) {
      const err = new Error(`TypeSafe ${blockedCap.cap} reached (${blockedCap.used} of ${blockedCap.limit} on ${blockedCap.day}); request not submitted.`);
      err.code = 'budget';
      this.stats.lastError = err.message;
      throw err;
    }

    const request = prepareEvaluationRequest(rawRequest, { maxInputBytes: this.maxInputBytes });
    const model = request.model || this.defaultModel;

    this.stats.requestsStarted += 1;
    this.ledger.recordStart();

    const controller = new AbortController();
    let timeoutId = null;
    if (this.timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(new Error(`TypeSafe Jev request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    }

    const abortHandler = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      const url = `${this.baseURL}/v1/systemone`;
      const bodyPayload = JSON.stringify({
        state: request.state,
        questions: request.questions,
        model,
      });

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'dsh-jev/0.1.0',
        },
        body: bodyPayload,
        signal: controller.signal,
      });

      const elapsedMs = Date.now() - startTime;

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const err = new Error(`TypeSafe API error (${res.status}): ${errorText || res.statusText}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      const inTokens = data.usage?.input_tokens ?? 0;
      const outTokens = data.usage?.output_tokens ?? 0;
      const totalTokens = data.usage?.total_tokens ?? (inTokens + outTokens);

      this.stats.requestsCount += 1;
      this.stats.requestsSucceeded += 1;
      this.stats.inputTokens += inTokens;
      this.stats.outputTokens += outTokens;
      this.stats.totalTokens += totalTokens;
      this.stats.lastElapsedMs = elapsedMs;

      this.ledger.recordSuccess(inTokens, outTokens);
      recordAuthVerified();

      const answers = {};
      for (const [id, rawAns] of Object.entries(data.answers || {})) {
        const qConfig = request.questions[id];
        if (!qConfig) {
          answers[id] = rawAns;
          continue;
        }

        if (qConfig.type === 'choice') {
          answers[id] = {
            type: 'choice',
            value: rawAns.choice ?? rawAns.value,
            confidence: rawAns.confidence,
            distribution: rawAns.probabilities ?? rawAns.distribution,
            raw: rawAns,
          };
        } else if (qConfig.type === 'noul') {
          const prob = rawAns.noul ?? rawAns.probability ?? rawAns.value ?? 0;
          answers[id] = {
            type: 'noul',
            value: prob,
            raw: rawAns,
          };
        } else if (qConfig.type === 'score') {
          answers[id] = {
            type: 'score',
            value: rawAns.score ?? rawAns.value ?? 0,
            confidence: rawAns.confidence,
            legend: rawAns.legend,
            distribution: rawAns.probabilities ?? rawAns.distribution,
            raw: rawAns,
          };
        } else {
          answers[id] = rawAns;
        }
      }

      return {
        answers,
        model: data.model || model,
        usage: data.usage || { input_tokens: inTokens, output_tokens: outTokens, total_tokens: totalTokens },
        elapsedMs,
      };
    } catch (err) {
      this.stats.requestsFailed += 1;
      this.stats.lastError = err?.message || String(err);
      this.ledger.recordFailure();
      recordAuthFailure(err);
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', abortHandler);
    }
  }

  evaluateMany(requests, options) {
    return evaluateMany(this, requests, options);
  }

  evaluateAll(request, options) {
    return evaluateAll(this, request, options);
  }
}

