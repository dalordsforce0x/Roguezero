// Validate the entry-economic-floor clamp math against real session numbers.
const MIN_USD = 5;
const USDC_ATOMIC_PER_USD = 1_000_000;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function economicFloorAtomic(inputMint, solUsd) {
  if (MIN_USD <= 0) return 0;
  if (inputMint === USDC_MINT) return Math.floor(MIN_USD * USDC_ATOMIC_PER_USD);
  if (inputMint === SOL_MINT) {
    if (solUsd <= 0) return 0;
    return Math.floor((MIN_USD / solUsd) * 1_000_000_000);
  }
  return 0;
}

// clamp returns {action, amount}
function clamp(inputMint, solUsd, preFloorAmount, tradableAtomic, maxTradeAtomic) {
  const floor = economicFloorAtomic(inputMint, solUsd);
  if (floor <= 0) return { action: 'untouched(no-price)', amount: preFloorAmount, floor };
  const affordableFloor = Math.min(floor, maxTradeAtomic);
  if (preFloorAmount > 0 && preFloorAmount < affordableFloor) {
    if (affordableFloor <= tradableAtomic) return { action: 'clamp', amount: affordableFloor, floor };
    return { action: 'skip', amount: 0, floor };
  }
  return { action: 'untouched(above-floor)', amount: preFloorAmount, floor };
}

const SOL_USD = 65 / 0.43672076; // derived from RogueCEO: $65 / 0.437 SOL
console.log('Derived SOL/USD:', SOL_USD.toFixed(2));

const fixedCostUsd = 0.05;
const capBps = 120;
function costBps(notionalUsd) { return Math.round((fixedCostUsd / notionalUsd) * 10000); }

const cases = [
  // name, inputMint, solUsd, preFloor, tradable, maxTrade
  ['RogueCEO failing entry (SOL)', SOL_MINT, SOL_USD, 8_618_286, 434_523_360, 50_000_000],
  ['SOL base 10% already economic', SOL_MINT, SOL_USD, 43_452_336, 434_523_360, 50_000_000],
  ['Tiny SOL session cannot afford', SOL_MINT, SOL_USD, 8_000_000, 20_000_000, 50_000_000],
  ['SOL price unknown -> untouched', SOL_MINT, 0, 8_618_286, 434_523_360, 50_000_000],
  ['USDC bot above floor (no-op)', USDC_MINT, SOL_USD, 11_600_000, 110_000_000, 50_000_000],
  ['USDC bot shrunk below $5 -> clamp', USDC_MINT, SOL_USD, 2_300_000, 110_000_000, 50_000_000],
];

let pass = true;
for (const [name, mint, sol, pre, trad, max] of cases) {
  const r = clamp(mint, sol, pre, trad, max);
  const usd = mint === SOL_MINT ? (r.amount / 1e9) * sol : r.amount / 1e6;
  const preUsd = mint === SOL_MINT ? (pre / 1e9) * (sol || SOL_USD) : pre / 1e6;
  const clears = r.action.startsWith('clamp') || r.action.startsWith('untouched(above')
    ? costBps(usd) <= capBps : null;
  console.log(`\n${name}`);
  console.log(`  pre=$${preUsd.toFixed(2)} (${pre}) floor=${r.floor} -> ${r.action} amount=${r.amount} ($${usd.toFixed(2)})`);
  if (r.action === 'clamp' || r.action.startsWith('untouched(above')) {
    console.log(`  cost gate: ${costBps(usd)}bps vs cap ${capBps} => ${clears ? 'CLEARS' : 'STILL BLOCKED'}`);
  }
}

// assertions
function assert(c, msg) { if (!c) { pass = false; console.log('FAIL:', msg); } else console.log('PASS:', msg); }
console.log('\n--- ASSERTIONS ---');
const ceo = clamp(SOL_MINT, SOL_USD, 8_618_286, 434_523_360, 50_000_000);
assert(ceo.action === 'clamp', 'RogueCEO sub-economic entry is clamped up');
const ceoUsd = (ceo.amount / 1e9) * SOL_USD;
assert(costBps(ceoUsd) <= capBps, `RogueCEO clamped trade ($${ceoUsd.toFixed(2)}) clears cost gate`);
assert(clamp(SOL_MINT, SOL_USD, 43_452_336, 434_523_360, 50_000_000).action.startsWith('untouched(above'), 'Already-economic SOL entry left untouched');
assert(clamp(SOL_MINT, SOL_USD, 8_000_000, 20_000_000, 50_000_000).action === 'skip', 'Underfunded SOL session skips (no churn)');
assert(clamp(SOL_MINT, 0, 8_618_286, 434_523_360, 50_000_000).action.startsWith('untouched(no-price'), 'Unknown SOL price leaves size untouched (safe)');
assert(clamp(USDC_MINT, SOL_USD, 11_600_000, 110_000_000, 50_000_000).action.startsWith('untouched(above'), 'USDC above-floor entry untouched (Noah/Foxy unaffected)');
assert(clamp(USDC_MINT, SOL_USD, 2_300_000, 110_000_000, 50_000_000).action === 'clamp', 'USDC shrunk-below-$5 entry clamped to floor');

console.log('\n' + (pass ? 'ALL ASSERTIONS PASS' : 'SOME ASSERTIONS FAILED'));
