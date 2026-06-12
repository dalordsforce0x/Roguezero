/**
 * D5: Fix Sender 0-credit bug.
 * 
 * Problem: rlSendRawTransaction calls reserveHeliusRpc which burns 1 monthly credit.
 * But Helius Sender costs 0 credits — only TPS + SOL tip.
 * 
 * Fix: Create reserveHeliusSender (TPS limit only, no budget burn),
 *      and use it in rlSendRawTransaction instead of reserveHeliusRpc.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');

if (c.includes('reserveHeliusSender')) {
  console.log('D5 already applied');
  process.exit(0);
}

// 1. Add reserveHeliusSender after reserveHeliusRpc
const afterReserveHelius = 'const reserveHeliusRpc = async () => {\r\n  await reserveProviderBudget({ provider: \'helius\', governor: heliusMonthlyBudget, units: 1 });\r\n  await heliusLimiter.acquire();\r\n};';

if (!c.includes(afterReserveHelius)) {
  console.error('FATAL: reserveHeliusRpc pattern not found');
  process.exit(1);
}

const senderReserve = [
  '',
  '// D5: Sender costs 0 Helius monthly credits — only TPS-limit, no budget burn.',
  'const reserveHeliusSender = async () => {',
  '  await heliusLimiter.acquire();',
  '};',
].join('\r\n');

c = c.replace(afterReserveHelius, afterReserveHelius + senderReserve);

// 2. Use reserveHeliusSender in rlSendRawTransaction instead of reserveHeliusRpc
c = c.replace(
  'const rlSendRawTransaction = async (serializedTransaction: Buffer | Uint8Array) => {\r\n  await reserveHeliusRpc();\r\n  return getConnection().sendRawTransaction(serializedTransaction, {',
  'const rlSendRawTransaction = async (serializedTransaction: Buffer | Uint8Array) => {\r\n  await reserveHeliusSender();\r\n  return getConnection().sendRawTransaction(serializedTransaction, {'
);

fs.writeFileSync(file, c);
console.log('D5 done: rlSendRawTransaction now uses reserveHeliusSender (0 credits, TPS-only)');
