#!/usr/bin/env node
import { parseGateArgs, printHelp, evaluateGate } from '../lib/gate.js';
import { JevClient } from '../lib/client.js';

async function main() {
  const options = parseGateArgs(process.argv.slice(2));

  if (options.help || (!options.criteria && process.stdin.isTTY && !options.diff && !options.file)) {
    printHelp();
    process.exit(options.help ? 0 : 2);
  }

  const client = new JevClient();

  try {
    const result = await evaluateGate(options, client);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const icon = result.passed ? '✓' : '✗';
      const probPct = (result.probability * 100).toFixed(1);
      console.log(`${icon} Gate ${result.passed ? 'PASSED' : 'REJECTED'}: ${probPct}% confidence (threshold ${(result.threshold * 100).toFixed(0)}%) [${result.elapsedMs}ms]`);
      console.log(`  Criteria: "${result.criteria}"`);
      if (result.error) {
        console.log(`  Notice: ${result.error}`);
      }
    }
    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ passed: options.failOpen, error: err.message }, null, 2));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(options.failOpen ? 0 : 2);
  }
}

main();

