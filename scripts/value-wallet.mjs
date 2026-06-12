import 'dotenv/config';

const mints = [
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',
  '5qKi97V1ZuL9k1wu9UWfs8r817EGuJk6bnuLMSZDH7Uy',
  'CDxapExDjqVoZ9FZ3RXi3gv8FurKdWbZwL81sEJFiJ9p',
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
];

const url = 'https://api.jup.ag/price/v2?ids=' + mints.join(',');
const res = await fetch(url);
const data = await res.json();

const p = {};
for (const [k, v] of Object.entries(data.data)) {
  p[k] = v.price ? Number(v.price) : 0;
  const sym = k === 'So11111111111111111111111111111111111111112' ? 'SOL'
    : k === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USDC'
    : k === 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' ? 'JUP'
    : k === '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm' ? '5oVN'
    : k === '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' ? 'POPCAT'
    : k.slice(0, 6);
  console.log(`${sym}: $${p[k].toFixed(8)}`);
}

const SOL = p['So11111111111111111111111111111111111111112'];

console.log('\n=== NOAH (USDC-based, funded $54.92) ===');
const nv = 0.056052 * SOL + 113.951084
  + 63.853308 * p['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN']
  + 0.153863906 * p['5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm']
  + 13.284297 * p['5qKi97V1ZuL9k1wu9UWfs8r817EGuJk6bnuLMSZDH7Uy']
  + 44.239751 * p['CDxapExDjqVoZ9FZ3RXi3gv8FurKdWbZwL81sEJFiJ9p'];
console.log(`  SOL 0.056052 = $${(0.056052*SOL).toFixed(2)}`);
console.log(`  USDC         = $113.95`);
console.log(`  JUP 63.85    = $${(63.853308*p['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN']).toFixed(2)}`);
console.log(`  5oVN 0.154   = $${(0.153863906*p['5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm']).toFixed(4)}`);
console.log(`  5qKi 13.28   = $${(13.284297*p['5qKi97V1ZuL9k1wu9UWfs8r817EGuJk6bnuLMSZDH7Uy']).toFixed(2)}`);
console.log(`  CDx  44.24   = $${(44.239751*p['CDxapExDjqVoZ9FZ3RXi3gv8FurKdWbZwL81sEJFiJ9p']).toFixed(2)}`);
console.log(`  ON-CHAIN TOTAL: $${nv.toFixed(2)}`);
console.log(`  FUNDED:         $54.92`);
console.log(`  PnL:            $${(nv-54.92).toFixed(2)} (${((nv/54.92-1)*100).toFixed(1)}%)`);
console.log(`  Worker DB says: $176.47`);

console.log('\n=== FOXY (USDC-based, funded $103.49) ===');
const fv = 0.052023 * SOL + 77.986457
  + 34.366848 * p['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN']
  + 0.122196947 * p['5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm'];
console.log(`  SOL 0.052    = $${(0.052023*SOL).toFixed(2)}`);
console.log(`  USDC         = $77.99`);
console.log(`  JUP 34.37    = $${(34.366848*p['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN']).toFixed(2)}`);
console.log(`  5oVN 0.122   = $${(0.122196947*p['5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm']).toFixed(4)}`);
console.log(`  ON-CHAIN TOTAL: $${fv.toFixed(2)}`);
console.log(`  FUNDED:         $103.49`);
console.log(`  PnL:            $${(fv-103.49).toFixed(2)} (${((fv/103.49-1)*100).toFixed(1)}%)`);
console.log(`  Worker DB says: $113.72`);

console.log('\n=== ROGUECEO (SOL-based, funded 0.437 SOL) ===');
const startSOL = 0.437 * SOL;
const cv = 0.394314 * SOL
  + 12.082395 * p['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN']
  + 9.776453102 * p['7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'];
console.log(`  SOL 0.394    = $${(0.394314*SOL).toFixed(2)}`);
console.log(`  JUP 12.08    = $${(12.082395*p['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN']).toFixed(2)}`);
console.log(`  POPCAT 9.78  = $${(9.776453102*p['7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr']).toFixed(2)}`);
console.log(`  ON-CHAIN TOTAL: $${cv.toFixed(2)}`);
console.log(`  FUNDED: 0.437 SOL = $${startSOL.toFixed(2)} (at current price)`);
console.log(`  PnL:            $${(cv-startSOL).toFixed(2)} (${((cv/startSOL-1)*100).toFixed(1)}%)`);
console.log(`  Worker DB says: $27.69`);
