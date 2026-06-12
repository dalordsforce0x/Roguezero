// Fix 1: Add startingValueUsd computation
// Fix 2: Add more reasons to entryGateReasons (stale_candles_no_fresh_signal, no_strategy_entry_signal, etc.)
// Fix 3: Make the exit_blocked fallback only apply for ACTUAL exit failure reasons
const fs = require('fs');
const file = 'services/worker/src/index.ts';
let src = fs.readFileSync(file, 'utf8');
let changes = 0;

// --- Fix 1: Add startingValueUsd after roundedPortfolio ---
const anchor1 = '  const roundedPortfolio = Number(totalPortfolioValueUsd.toFixed(6));';
const target1 = anchor1 + '\r\n\r\n  const roundedUnrealized';
const replacement1 = anchor1 + `\r\n  // Compute starting value in USD for PnL comparison\r\n  const startAtomic = Number(session.funding.startingBalanceAtomic ?? '0');\r\n  const startingValueUsd = session.funding.fundingMint === USDC_MINT\r\n    ? startAtomic / USDC_ATOMIC_PER_USD\r\n    : (startAtomic / 1_000_000_000) * solPriceForPortfolio;\r\n  const roundedStartingValue = Number(startingValueUsd.toFixed(6));\r\n\r\n  const roundedUnrealized`;

if (src.includes(target1)) {
  src = src.replace(target1, replacement1);
  changes++;
  console.log('1. Added startingValueUsd computation');
} else {
  // Try LF
  const target1LF = anchor1 + '\n\n  const roundedUnrealized';
  const replacement1LF = anchor1 + `\n  // Compute starting value in USD for PnL comparison\n  const startAtomic = Number(session.funding.startingBalanceAtomic ?? '0');\n  const startingValueUsd = session.funding.fundingMint === USDC_MINT\n    ? startAtomic / USDC_ATOMIC_PER_USD\n    : (startAtomic / 1_000_000_000) * solPriceForPortfolio;\n  const roundedStartingValue = Number(startingValueUsd.toFixed(6));\n\n  const roundedUnrealized`;
  if (src.includes(target1LF)) {
    src = src.replace(target1LF, replacement1LF);
    changes++;
    console.log('1. Added startingValueUsd computation (LF)');
  } else {
    console.log('1. FAIL: anchor not found');
    const idx = src.indexOf('roundedPortfolio = Number(totalPortfolioValueUsd');
    if (idx > -1) {
      console.log('   Found roundedPortfolio at index', idx);
      const ctx = src.substring(idx, idx + 200);
      console.log('   Next 200 chars:', JSON.stringify(ctx));
    }
  }
}

// --- Fix 1b: Add startingValueUsd to the fundingPatchObj ---
const anchor1b = `  if (roundedPortfolio !== (session.funding as any).totalPortfolioValueUsd) {\r\n    fundingPatchObj.totalPortfolioValueUsd = roundedPortfolio;\r\n  }\r\n  if (Object.keys(fundingPatchObj).length > 0) {`;
const replacement1b = `  if (roundedPortfolio !== (session.funding as any).totalPortfolioValueUsd) {\r\n    fundingPatchObj.totalPortfolioValueUsd = roundedPortfolio;\r\n  }\r\n  if (roundedStartingValue > 0 && roundedStartingValue !== (session.funding as any).startingValueUsd) {\r\n    fundingPatchObj.startingValueUsd = roundedStartingValue;\r\n  }\r\n  if (Object.keys(fundingPatchObj).length > 0) {`;

if (src.includes(anchor1b)) {
  src = src.replace(anchor1b, replacement1b);
  changes++;
  console.log('1b. Added startingValueUsd to fundingPatchObj');
} else {
  const anchor1bLF = anchor1b.replace(/\r\n/g, '\n');
  const replacement1bLF = replacement1b.replace(/\r\n/g, '\n');
  if (src.includes(anchor1bLF)) {
    src = src.replace(anchor1bLF, replacement1bLF);
    changes++;
    console.log('1b. Added startingValueUsd to fundingPatchObj (LF)');
  } else {
    console.log('1b. FAIL: anchor not found');
  }
}

// --- Fix 2: Add more entry-gate-like reasons to entryGateReasons ---
// stale_candles_no_fresh_signal and no_strategy_entry_signal are currently
// falling to exit_blocked via the || hasOpenPositions catch-all
const anchor2 = "  'daily_loss_limit_reached',\r\n]);";
const replacement2 = "  'daily_loss_limit_reached',\r\n  'entry_cooldown_active',\r\n  'stale_candles_no_fresh_signal',\r\n]);";
if (src.includes(anchor2)) {
  src = src.replace(anchor2, replacement2);
  changes++;
  console.log('2. Added stale_candles_no_fresh_signal + entry_cooldown_active to entryGateReasons');
} else {
  const anchor2LF = anchor2.replace(/\r\n/g, '\n');
  const replacement2LF = replacement2.replace(/\r\n/g, '\n');
  if (src.includes(anchor2LF)) {
    src = src.replace(anchor2LF, replacement2LF);
    changes++;
    console.log('2. Added stale_candles_no_fresh_signal + entry_cooldown_active (LF)');
  } else {
    console.log('2. FAIL: entryGateReasons tail anchor not found');
  }
}

// --- Fix 3: no_strategy_entry_signal is in marketWaitReasons, which should
// take priority over exit_blocked. Let me check the logic order. ---
// The health function checks: marketWaitReasons FIRST, then exitBlockedReasons.
// But no_strategy_entry_signal IS in marketWaitReasons already. Why did it show as exit_blocked?
// Because the code checks: if (reason && marketWaitReasons.has(reason) && !hasOpenPositions)
// The !hasOpenPositions condition means market_wait only applies when NO positions.
// When positions exist, it falls through to exit_blocked.
// 
// The fix: the at_capacity check we added catches entryGateReasons BEFORE exit_blocked.
// But no_strategy_entry_signal is a marketWait reason, not an entryGate reason.
// For bots WITH positions that are in a market wait state, the correct label is
// still "at_capacity" or "active_holding" — NOT exit_blocked.
// 
// The simplest fix: also add the at_capacity check for marketWaitReasons when hasOpenPositions.
// Actually, let me look at the logic flow more carefully.

// Let me check the current flow
const marketWaitCheck = src.indexOf('marketWaitReasons.has(reason)');
if (marketWaitCheck > -1) {
  const ctx = src.substring(marketWaitCheck - 50, marketWaitCheck + 150);
  console.log('3. MarketWait check context:', JSON.stringify(ctx));
}

if (changes > 0) {
  fs.writeFileSync(file, src);
}
console.log(`\nDone: ${changes} changes applied.`);
