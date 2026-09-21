export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_QUESTIONS = 32;

/**
 * Run worker over items with bounded concurrency, preserving input order.
 * Never throws.
 * @param {Array<any>} items
 * @param {(item: any, index: number) => Promise<any>} worker
 * @param {{ concurrency?: number, signal?: AbortSignal, stopOn?: (err: any) => boolean }} [options]
 */
export async function fanOut(items, worker, options = {}) {
  const concurrency = Math.max(1, Math.floor(options.concurrency || DEFAULT_CONCURRENCY));
  const results = new Array(items.length);
  let next = 0;
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      const idx = next++;
      if (idx >= items.length) return;
      if (options.signal?.aborted) {
        stopped = true;
        return;
      }
      try {
        const val = await worker(items[idx], idx);
        results[idx] = { ok: true, index: idx, value: val };
      } catch (err) {
        results[idx] = { ok: false, index: idx, error: err, skipped: false };
        if (options.stopOn && options.stopOn(err)) {
          stopped = true;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));

  for (let i = 0; i < items.length; i++) {
    if (!results[i]) {
      results[i] = {
        ok: false,
        index: i,
        error: new Error('Batch cancelled or stopped before this request was submitted.'),
        skipped: true,
      };
    }
  }

  return results;
}

/**
 * Split an evaluation request that exceeds maxQuestions into smaller chunks.
 * @param {{ state: any, questions: Record<string, any>, model?: string }} request
 * @param {{ maxQuestions?: number }} [options]
 * @returns {Array<object>}
 */
export function chunkEvaluationRequest(request, options = {}) {
  const limit = Math.max(1, Math.floor(options.maxQuestions || DEFAULT_MAX_QUESTIONS));
  const questions = request?.questions;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    return [request];
  }

  const entries = Object.entries(questions);
  if (entries.length <= limit) {
    return [request];
  }

  const chunks = [];
  for (let i = 0; i < entries.length; i += limit) {
    const chunkQuestions = Object.fromEntries(entries.slice(i, i + limit));
    chunks.push({
      ...request,
      questions: chunkQuestions,
    });
  }
  return chunks;
}

/**
 * Summarize batch evaluation results.
 */
function summarizeBatch(results, elapsedMs) {
  const answers = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let succeeded = 0;
  let skipped = 0;
  let model = undefined;

  for (const r of results) {
    if (!r.ok) {
      if (r.skipped) skipped++;
      continue;
    }
    succeeded++;
    Object.assign(answers, r.value.answers);
    if (r.value.usage) {
      inputTokens += r.value.usage.input_tokens || 0;
      outputTokens += r.value.usage.output_tokens || 0;
    }
    if (!model && r.value.model) model = r.value.model;
  }

  return {
    ok: succeeded === results.length,
    results,
    failures: results.length - succeeded,
    skipped,
    answers,
    model,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    elapsedMs,
  };
}

/**
 * Execute multiple Jev requests with bounded concurrency.
 * @param {object} client - JevClient instance
 * @param {Array<object>} requests
 * @param {{ concurrency?: number, signal?: AbortSignal }} [options]
 */
export async function evaluateMany(client, requests, options = {}) {
  const start = Date.now();
  const results = await fanOut(requests, (req) => client.evaluate(req, options.signal), {
    concurrency: options.concurrency,
    signal: options.signal,
    stopOn: (err) => err?.message?.includes('limit reached') || err?.message?.includes('cancelled'),
  });

  return summarizeBatch(results, Date.now() - start);
}

/**
 * Evaluate any number of questions against one state, chunking to maxQuestions and merging results.
 * @param {object} client - JevClient instance
 * @param {object} request
 * @param {{ concurrency?: number, maxQuestions?: number, signal?: AbortSignal }} [options]
 */
export async function evaluateAll(client, request, options = {}) {
  const chunks = chunkEvaluationRequest(request, { maxQuestions: options.maxQuestions });
  return evaluateMany(client, chunks, options);
}

