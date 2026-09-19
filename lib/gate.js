/**
 * Post-run gate check using TypeSafe Jev System One evaluation.
 * Exits with 0 if evaluation meets threshold, non-zero otherwise.
 */

import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { JevClient } from './client.js';

export function parseGateArgs(args) {
  const options = {
    criteria: '',
    threshold: 0.7,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c' || arg === '--criteria') {
      options.criteria = args[++i] || '';
    } else if (arg === '-p' || arg === '--min-prob' || arg === '--threshold') {
      const val = parseFloat(args[++i] || '0.7');
      if (!isNaN(val)) options.threshold = val;
    } else if (arg === '-d' || arg === '--diff') {
      options.diff = true;
    } else if (arg === '-f' || arg === '--file') {
      options.file = args[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--fail-open') {
      options.failOpen = true;
    } else if (arg === '-m' || arg === '--model') {
      options.model = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (!options.criteria && !arg.startsWith('-')) {
      options.criteria = arg;
    }
  }

  return options;
}

export function printHelp() {
  console.log(`
Usage: dsh-jev-gate [options] [criteria]

Post-run gate check using TypeSafe Jev System One evaluation.
Exits with 0 if evaluation meets threshold, 1 if rejected, 2 on error.

Options:
  -c, --criteria <text>      Acceptance criteria to check against output/diff
  -p, --threshold <num>      Minimum passing probability (default: 0.7)
  -d, --diff                 Use git diff (HEAD) as evaluation state
  -f, --file <path>          Read state from file
      --json                 Output result in JSON format
      --fail-open            Exit 0 even on API or config error
  -m, --model <model>        Override Jev model (default: jev-latest)
  -h, --help                 Show this help message

Examples:
  subagent gate: "dsh-jev-gate -c 'Tests pass and no new any types' -d"
  pipeline gate: "git diff | dsh-jev-gate -c 'All exports documented'"
`);
}

export function resolveGateState(options) {
  if (options.state) {
    return typeof options.state === 'string' ? options.state : JSON.stringify(options.state, null, 2);
  }

  if (options.diff) {
    try {
      const diffOutput = execSync('git diff HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (diffOutput.trim()) return diffOutput;
      const cachedDiff = execSync('git diff --cached', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (cachedDiff.trim()) return cachedDiff;
      return 'No git changes detected.';
    } catch (e) {
      return `Git diff failed: ${e.message}`;
    }
  }

  if (options.file) {
    try {
      return fs.readFileSync(options.file, 'utf8');
    } catch (e) {
      throw new Error(`Failed to read file ${options.file}: ${e.message}`);
    }
  }

  // Read from stdin if available and not TTY
  if (!process.stdin.isTTY) {
    try {
      return fs.readFileSync(0, 'utf8');
    } catch {
      // Ignore read error
    }
  }

  return 'No state provided.';
}

export async function evaluateGate(options, jevClient) {
  const client = jevClient || new JevClient();
  const threshold = options.threshold ?? 0.7;

  if (!options.criteria.trim()) {
    throw new Error('Missing criteria for gate check. Provide --criteria <text>.');
  }

  if (!client.isConfigured()) {
    if (options.failOpen) {
      return {
        passed: true,
        probability: 1.0,
        criteria: options.criteria,
        threshold,
        elapsedMs: 0,
        error: 'Jev unconfigured (fail-open enabled)',
      };
    }
    throw new Error('TypeSafe Jev API key unconfigured. Set TYPESAFE_API_KEY.');
  }

  const stateText = resolveGateState(options);

  const response = await client.evaluate({
    state: stateText,
    model: options.model,
    questions: {
      gate_passed: {
        type: 'noul',
        instructions: `Does the provided code/output satisfy this acceptance criteria: "${options.criteria}"?`,
      },
    },
  });

  const answer = response.answers['gate_passed'];
  const probability = typeof answer?.value === 'number' ? answer.value : Number(answer?.value ?? 0);
  const passed = probability >= threshold;

  return {
    passed,
    probability,
    confidence: answer?.confidence,
    criteria: options.criteria,
    threshold,
    elapsedMs: response.elapsedMs,
    answer,
  };
}

