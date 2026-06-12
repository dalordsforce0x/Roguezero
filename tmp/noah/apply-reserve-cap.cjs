const fs = require('fs');
const path = 'services/worker/src/index.ts';
let raw = fs.readFileSync(path, 'latin1');
const hadCRLF = raw.includes('\r\n');
let s = raw.split('\r\n').join('\n');

const oldStr = `      const estimatedNetworkCostLamports = prepare.data.costs?.estimatedNetworkCostLamports ?? 0;`;
const newStr = `      const rawNetworkCostLamports = prepare.data.costs?.estimatedNetworkCostLamports ?? 0;
      // The API's estimate bakes in worst-case new-ATA rent (~2.04M lamports) even
      // when the output token account already exists (it does for any session that
      // has already traded its base currency). Selling SOL->USDC opens no net new
      // account: the USDC ATA exists and the wrapped-SOL temp account is opened and
      // closed in the same tx (rent reclaimed). Simulation already passed above, so
      // the tx is affordable on-chain. Cap the reserve calc to the realistic swap
      // cost (base fee + priority + tip headroom, no ATA rent) so phantom rent can't
      // fabricate a shortfall that cancel-retries the SOL exit forever.
      const estimatedNetworkCostLamports = Math.min(rawNetworkCostLamports, GAS_REFILL_SWAP_COST_LAMPORTS);`;

const count = s.split(oldStr).length - 1;
if (count !== 1) {
  console.error(`ABORT: oldStr found ${count} times (expected 1)`);
  process.exit(1);
}
s = s.replace(oldStr, newStr);

if (hadCRLF) s = s.split('\n').join('\r\n');
fs.writeFileSync(path, s, 'latin1');
console.log('OK: applied reserve-trap cap fix');
