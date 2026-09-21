export const DEFAULT_MAX_INPUT_BYTES = 64 * 1024; // 64 KiB
export const DEFAULT_MAX_QUESTIONS = 32;

/**
 * Validate that serialized JSON does not exceed byte limit.
 * @param {string} body
 * @param {number} [maxBytes=DEFAULT_MAX_INPUT_BYTES]
 */
export function assertWithinByteLimit(body, maxBytes = DEFAULT_MAX_INPUT_BYTES) {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(`TypeSafe request payload too large (${bytes} bytes; limit is ${maxBytes} bytes).`);
  }
}

/**
 * Normalize and prepare evaluation request object.
 * @param {object} input
 * @param {{ maxInputBytes?: number, maxQuestions?: number }} [options]
 * @returns {object}
 */
export function prepareEvaluationRequest(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('TypeSafe request must be a non-null object with "state" and "questions".');
  }

  if (input.state === undefined || input.state === null) {
    throw new Error('TypeSafe request is missing required field "state".');
  }

  const rawQuestions = input.questions;
  if (!rawQuestions || typeof rawQuestions !== 'object' || Array.isArray(rawQuestions)) {
    throw new Error('TypeSafe request "questions" must be an object map of question id to question definition.');
  }

  const questionEntries = Object.entries(rawQuestions);
  if (questionEntries.length === 0) {
    throw new Error('TypeSafe request must contain at least one question.');
  }

  const maxQuestions = options.maxQuestions || DEFAULT_MAX_QUESTIONS;
  if (questionEntries.length > maxQuestions) {
    throw new Error(`TypeSafe request contains ${questionEntries.length} questions; maximum per request is ${maxQuestions}.`);
  }

  const normalizedQuestions = {};
  for (const [id, q] of questionEntries) {
    if (!id || typeof id !== 'string') {
      throw new Error('Question ID must be a non-empty string.');
    }
    if (!q || typeof q !== 'object') {
      throw new Error(`Question "${id}" must be an object.`);
    }

    const type = q.type;
    if (!['choice', 'noul', 'score'].includes(type)) {
      throw new Error(`Question "${id}" has unsupported type "${type}". Must be 'choice', 'noul', or 'score'.`);
    }

    if (!q.instructions || typeof q.instructions !== 'string' || !q.instructions.trim()) {
      throw new Error(`Question "${id}" must have non-empty string "instructions".`);
    }

    if (type === 'choice') {
      if (!q.criteria) {
        throw new Error(`Choice question "${id}" requires "criteria" (options mapping or array).`);
      }
      let criteria = q.criteria;
      if (Array.isArray(criteria)) {
        const mapped = {};
        for (const item of criteria) {
          mapped[String(item)] = String(item);
        }
        criteria = mapped;
      } else if (typeof criteria !== 'object') {
        throw new Error(`Choice question "${id}" criteria must be an object or array.`);
      }
      normalizedQuestions[id] = {
        type: 'choice',
        instructions: q.instructions.trim(),
        criteria,
      };
    } else if (type === 'noul') {
      normalizedQuestions[id] = {
        type: 'noul',
        instructions: q.instructions.trim(),
      };
    } else if (type === 'score') {
      if (!q.criteria || (!Array.isArray(q.criteria) && typeof q.criteria !== 'object')) {
        throw new Error(`Score question "${id}" requires "criteria" array or rubric map.`);
      }
      const criteria = Array.isArray(q.criteria) ? q.criteria : Object.values(q.criteria);
      normalizedQuestions[id] = {
        type: 'score',
        instructions: q.instructions.trim(),
        criteria: criteria.map(String),
      };
    }
  }

  const state = typeof input.state === 'string' ? { text: input.state } : input.state;
  const result = {
    state,
    questions: normalizedQuestions,
    ...(input.model ? { model: String(input.model).trim() } : {}),
  };

  const body = JSON.stringify(result);
  assertWithinByteLimit(body, options.maxInputBytes || DEFAULT_MAX_INPUT_BYTES);

  return result;
}

