#!/usr/bin/env node
/**
 * Run batch registration and output only JSON to stdout (for backend parsing).
 * Usage: REGISTER_COUNT=2 OUTPUT_JSON=1 node run-register.js
 * Or: node run-register.js 2
 */
import { ChatGPTAccountCreator } from './chatgpt_account_creator.js';

const count = parseInt(process.env.REGISTER_COUNT || process.argv[2] || '2', 10) || 2;
process.env.REGISTER_COUNT = String(count);
process.env.OUTPUT_JSON = '1';

try {
  const creator = new ChatGPTAccountCreator();
  await creator.createAccounts(count);
  process.stdout.write(JSON.stringify({ accounts: creator.createdAccounts }) + '\n');
} catch (e) {
  process.stderr.write(`Fatal error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({ accounts: [], error: e.message }) + '\n');
  process.exit(1);
}
