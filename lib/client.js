import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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

  // 4. Secret file in ~/.dsh/secrets/typesafe_api_key
  const dshSecret = path.join(os.homedir(), '.dsh', 'secrets', 'typesafe_api_key');
  if (fs.existsSync(dshSecret)) {
    try {
      const content = fs.readFileSync(dshSecret, 'utf8').trim();
      if (content) return { key: content, source: 'file', origin: '~/.dsh/secrets/typesafe_api_key' };
    } catch {}
  }

  // 5. Secret file in ~/.pi/agent/secrets/typesafe_api_key (cross-agent shared credential)
  const piSecret = path.join(os.homedir(), '.pi', 'agent', 'secrets', 'typesafe_api_key');
  if (fs.existsSync(piSecret)) {
    try {
      const content = fs.readFileSync(piSecret, 'utf8').trim();
      if (content) return { key: content, source: 'file', origin: '~/.pi/agent/secrets/typesafe_api_key' };
    } catch {}
  }

  // 6. Dotenv in workspace typesafe-eval/.env
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
    this.stats = {
      requestsCount: 0,
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

  /**
   * Run a System One evaluation with TypeSafe Jev.
   * @param {{ state: any, questions: Record<string, any>, model?: string }} request
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ answers: Record<string, any>, model: string, usage: any, elapsedMs: number }>}
   */
  async evaluate(request, signal) {
    const startTime = Date.now();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      const err = new Error('Missing TYPESAFE_API_KEY. Set it in environment or ~/.dsh/secrets/typesafe_api_key.');
      this.stats.lastError = err.message;
      throw err;
    }

    const formattedQuestions = {};
    for (const [id, q] of Object.entries(request.questions || {})) {
      if (q.type === 'choice') {
        formattedQuestions[id] = {
          type: 'choice',
          instructions: q.instructions,
          criteria: q.criteria,
        };
      } else if (q.type === 'noul') {
        formattedQuestions[id] = {
          type: 'noul',
          instructions: q.instructions,
        };
      } else if (q.type === 'score') {
        formattedQuestions[id] = {
          type: 'score',
          instructions: q.instructions,
          criteria: q.criteria,
        };
      } else {
        formattedQuestions[id] = q;
      }
    }

    const statePayload = typeof request.state === 'string' ? { text: request.state } : (request.state ?? {});
    const model = request.model || this.defaultModel;

    const controller = new AbortController();
    let timeoutId = null;
    if (this.timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(new Error(`TypeSafe Jev request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    }

    const abortHandler = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      const url = `${this.baseURL}/v1/systemone`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'dsh-jev/0.1.0',
        },
        body: JSON.stringify({
          state: statePayload,
          questions: formattedQuestions,
          model,
        }),
        signal: controller.signal,
      });

      const elapsedMs = Date.now() - startTime;

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`TypeSafe API error (${res.status}): ${errorText || res.statusText}`);
      }

      const data = await res.json();
      this.stats.requestsCount += 1;
      const tokens = (data.usage?.total_tokens ?? ((data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0))) || 0;
      this.stats.totalTokens += tokens;
      this.stats.lastElapsedMs = elapsedMs;

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
        usage: data.usage,
        elapsedMs,
      };
    } catch (err) {
      this.stats.lastError = err?.message || String(err);
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', abortHandler);
    }
  }
}

