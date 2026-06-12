// Validate the COST-DERIVED floor against real measured numbers.
const capBps = 120;            // MAX_QUOTE_PRICE_IMPACT_BPS (live)
const headroomBps = 15000;     // 1.5x safety margin
const USDC_ATOMIC_PER_USD = 1_000_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function floorAtomic(inputMint, recentNetworkCostLamports, solUsd) {
  if (capBps <= 0 || recentNetworkCostLamports <= 0) return 0;
  const minSolLamports = (recentNetworkCostLamports * headroomBps) / capBps;
  if (inputMint === SOL_MINT) return Math.ceil(minSolLamports);
  if (inputMint === USDC_MINT) {
    if (solUsd <= 0) return 0;
    const minUsd = (minSolLamports / 1e9) * solUsd;
    return Math.ceil(minUsd * USDC_ATOMIC_PER_USD);
  }
  return 0;
}

function clamp(inputMint, recentCost, solUsd, pre, tradable, maxTrade) {
  const floor = floorAtomic(inputMint, recentCost, solUsd);
  if (floor <= 0) return { action: 'untouched(no-floor)', amount: pre, floor };
  const floorFits = floor <= maxTrade && floor <= tradable;
  if (pre > 0 && pre < floor) {
    if (floorFits) return { action: 'clamp', amount: floor, floor };
    return { action: 'skip', amount: 0, floor };
  }
  return { action: 'untouched(above)', amount: pre, floor };
}

const SOL_USD = 64.95;                 // live from worker logs
const MAX_TRADE = 50_000_000;          // WORKER_MAX_TRADE_LAMPORTS default (0.05 SOL)
const TRADABLE_CEO = 434_523_360;      // RogueCEO ~0.43 SOL after reserve
// actual measured network cost for RogueCEO's last prepare:
const COST_NORMAL = 213_271;           // ~$0.0139
const COST_SPIKE = 600_000;            // priority-fee spike scenario

// resulting trade cost bps for a clamped notional (SOL): cost/notional in lamports
function realCostBps(costLamports, notionalLamports) {
  return Math.round((costLamports / notionalLamports) * 10000);
}

let pass = true;
function assert(c, m) { if (!c) { pass = false; console.log('FAIL:', m); } else console.log('PASS:', m); }

console.log('=== Cost-derived floor (live cap=120bps, headroom=1.5x) ===\n');

// 1. RogueCEO sub-economic at normal fees -> clamp, and clamped trade clears the gate
const r1 = clamp(SOL_MINT, COST_NORMAL, SOL_USD, 8_618_286, TRADABLE_CEO, MAX_TRADE);
const r1bps = realCostBps(COST_NORMAL, r1.amount);
console.log(`RogueCEO normal fees: floor=${r1.floor} (${(r1.floor/1e9*SOL_USD).toFixed(2)}) -> ${r1.action} amount=${r1.amount} costBps=${r1bps}`);
assert(r1.action === 'clamp', 'normal-fee sub-economic entry is clamped up');
assert(r1bps <= capBps, `clamped trade cost ${r1bps}bps clears cap ${capBps}`);
assert(r1.floor <= MAX_TRADE, 'normal-fee floor fits under max-trade cap');

// 2. Already-economic entry left untouched
const r2 = clamp(SOL_MINT, COST_NORMAL, SOL_USD, 40_000_000, TRADABLE_CEO, MAX_TRADE);
console.log(`\nAlready economic: -> ${r2.action} amount=${r2.amount}`);
assert(r2.action === 'untouched(above)', 'already-economic entry untouched');

// 3. Priority-fee spike pushes floor above max-trade -> SKIP (do not churn)
const r3 = clamp(SOL_MINT, COST_SPIKE, SOL_USD, 8_618_286, TRADABLE_CEO, MAX_TRADE);
console.log(`\nFee spike (${COST_SPIKE} lamports): floor=${r3.floor} (${(r3.floor/1e9*SOL_USD).toFixed(2)}) max=${MAX_TRADE} -> ${r3.action}`);
assert(r3.floor > MAX_TRADE, 'fee-spike floor exceeds max trade');
assert(r3.action === 'skip', 'fee-spike entry skips cleanly (no churn)');

// 4. Price-independence for SOL: same cost, very different price -> identical floor
const r4a = floorAtomic(SOL_MINT, COST_NORMAL, 50);
const r4b = floorAtomic(SOL_MINT, COST_NORMAL, 250);
console.log(`\nSOL floor @ $50 = ${r4a}, @ $250 = ${r4b}`);
assert(r4a === r4b, 'SOL floor is price-independent (self-adjusts via lamports only)');

// 5. USDC bot: floor scales with price; above-floor entries untouched (Noah/Foxy)
const f5 = floorAtomic(USDC_MINT, COST_NORMAL, SOL_USD);
const r5 = clamp(USDC_MINT, COST_NORMAL, SOL_USD, 11_600_000, 110_000_000, 50_000_000);
console.log(`\nUSDC floor=${f5} (${(f5/1e6).toFixed(2)}); $11.60 entry -> ${r5.action}`);
assert(r5.action === 'untouched(above)', 'USDC above-floor entry untouched (Noah/Foxy unaffected)');

// 6. Seed only governs startup: cost 0 -> no floor (untouched)
const r6 = clamp(SOL_MINT, 0, SOL_USD, 8_618_286, TRADABLE_CEO, MAX_TRADE);
console.log(`\nNo cost yet: -> ${r6.action}`);
assert(r6.action.startsWith('untouched(no-floor'), 'no measured cost -> no clamp (safe)');

console.log('\n' + (pass ? 'ALL ASSERTIONS PASS' : 'SOME ASSERTIONS FAILED'));
process.exit(pass ? 0 : 1);
