// Fix 1: Worker health state — don't label entry gates as exit_blocked
// Fix 2: Add totalPortfolioValueUsd to funding patch
const fs = require('fs');
const file = 'services/worker/src/index.ts';
let src = fs.readFileSync(file, 'utf8');
let changes = 0;

// --- Fix 1: Add entryGateReasons set and route them to a new health state ---
// Insert entryGateReasons set right before marketWaitReasons
const marketWaitAnchor = "const marketWaitReasons = new Set([";
if (src.includes(marketWaitAnchor) && !src.includes('entryGateReasons')) {
  src = src.replace(
    marketWaitAnchor,
    `const entryGateReasons = new Set([\r\n  'max_open_positions_reached',\r\n  'entry_quality_range_top',\r\n  'entry_below_economic_floor',\r\n  'entry_edge_below_cost',\r\n  'entry_leg_cost_too_high',\r\n  'risk_circuit_breaker',\r\n  'session_loss_limit_reached',\r\n  'daily_loss_limit_reached',\r\n]);\r\n\r\n${marketWaitAnchor}`
  );
  changes++;
  console.log('1. Added entryGateReasons set');
} else if (src.includes('entryGateReasons')) {
  console.log('1. SKIP: entryGateReasons already exists');
} else {
  console.log('1. FAIL: marketWaitReasons anchor not found');
}

// --- Fix 2: Change the exit_blocked condition to exclude entry gate reasons ---
// The current logic: if (reason && (exitBlockedReasons.has(reason) || hasOpenPositions)) { exit_blocked }
// Change to: add a new check for entryGateReasons BEFORE the exit_blocked check
const exitBlockedCheck = "  if (reason && (exitBlockedReasons.has(reason) || hasOpenPositions)) {\r\n    return {\r\n      state: 'exit_blocked',";
if (src.includes(exitBlockedCheck)) {
  src = src.replace(
    exitBlockedCheck,
    `  if (reason && entryGateReasons.has(reason) && hasOpenPositions) {\r\n    return {\r\n      state: 'at_capacity',\r\n      severity: 'info',\r\n      reason,\r\n      detail: 'Bot is at max positions or entry quality gates are blocking new entries. Exits are working normally.',\r\n      updatedAt,\r\n      blockerCount,\r\n    };\r\n  }\r\n\r\n  if (reason && (exitBlockedReasons.has(reason) || hasOpenPositions)) {\r\n    return {\r\n      state: 'exit_blocked',`
  );
  changes++;
  console.log('2. Added at_capacity health state before exit_blocked');
} else {
  console.log('2. FAIL: exit_blocked condition not found (may be LF?)');
  // Try LF version
  const exitBlockedCheckLF = "  if (reason && (exitBlockedReasons.has(reason) || hasOpenPositions)) {\n    return {\n      state: 'exit_blocked',";
  if (src.includes(exitBlockedCheckLF)) {
    src = src.replace(
      exitBlockedCheckLF,
      `  if (reason && entryGateReasons.has(reason) && hasOpenPositions) {\n    return {\n      state: 'at_capacity',\n      severity: 'info',\n      reason,\n      detail: 'Bot is at max positions or entry quality gates are blocking new entries. Exits are working normally.',\n      updatedAt,\n      blockerCount,\n    };\n  }\n\n  if (reason && (exitBlockedReasons.has(reason) || hasOpenPositions)) {\n    return {\n      state: 'exit_blocked',`
    );
    changes++;
    console.log('2. Added at_capacity health state (LF variant)');
  } else {
    console.log('2. FAIL: could not find exit_blocked condition in either CRLF or LF');
  }
}

// --- Fix 3: Add totalPortfolioValueUsd computation alongside unrealizedPnlUsd ---
// After computing totalUnrealizedPnlUsd, add totalPortfolioValueUsd
const unrealizedPatchAnchor = "  const roundedUnrealized = Number(totalUnrealizedPnlUsd.toFixed(6));\r\n  if (roundedUnrealized !== session.funding.unrealizedPnlUsd) {\r\n    await mergeFundingPatch(session, { unrealizedPnlUsd: roundedUnrealized });\r\n  }";
const portfolioPatch = `  // Compute total portfolio value: base balance + all position values at mark
  const solPriceForPortfolio = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;
  let totalPortfolioValueUsd = 0;
  // Add base balance value
  const baseBalanceAtomic = Number(session.funding.currentBalanceAtomic ?? '0');
  if (session.funding.fundingMint === '${/* USDC_MINT will be inlined */ ''}') {
    // placeholder replaced below
  }
  // Add position values at mark price
  for (const [mint, pos] of Object.entries(nextPositions)) {
    if (isLongPositionStatus(pos.status) && pos.lastMarkedPriceUsd && pos.quantityAtomic) {
      const qty = toUiAmount(mint, Number(pos.quantityAtomic), pos.tokenDecimals ?? undefined);
      totalPortfolioValueUsd += pos.lastMarkedPriceUsd * qty;
    }
  }
  const roundedPortfolio = Number(totalPortfolioValueUsd.toFixed(6));

  const roundedUnrealized = Number(totalUnrealizedPnlUsd.toFixed(6));
  const fundingPatch: Record<string, unknown> = {};
  if (roundedUnrealized !== session.funding.unrealizedPnlUsd) {
    fundingPatch.unrealizedPnlUsd = roundedUnrealized;
  }
  if (roundedPortfolio !== session.funding.totalPortfolioValueUsd) {
    fundingPatch.totalPortfolioValueUsd = roundedPortfolio;
  }
  if (Object.keys(fundingPatch).length > 0) {
    await mergeFundingPatch(session, fundingPatch);
  }`;

// Actually, let me find the USDC_MINT constant first, then do a simpler approach.
// The portfolio value needs: base balance (USDC or SOL) + position mark values.
// Let me just inline it properly.

// Find USDC mint constant
const usdcMintMatch = src.match(/const USDC_MINT\s*=\s*['"]([^'"]+)['"]/);
const usdcMint = usdcMintMatch ? usdcMintMatch[1] : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const replacement = `  // Compute total portfolio value: base balance + all position values at mark
  const solPriceForPortfolio = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;
  let totalPortfolioValueUsd = 0;\r\n  // Add base balance value (SOL always counted + USDC if that's the funding mint)\r\n  const solBalanceForPortfolio = Number(session.funding.currentBalanceAtomic ?? '0');\r\n  if (session.funding.fundingMint === '${usdcMint}') {\r\n    // USDC-based session: base balance is USDC\r\n    totalPortfolioValueUsd += solBalanceForPortfolio / 1_000_000;\r\n  } else {\r\n    // SOL-based session: base balance is SOL lamports\r\n    totalPortfolioValueUsd += (solBalanceForPortfolio / 1_000_000_000) * solPriceForPortfolio;\r\n  }\r\n  // Add position values at mark price\r\n  for (const [pMint, pPos] of Object.entries(nextPositions)) {\r\n    if (isLongPositionStatus(pPos.status) && pPos.lastMarkedPriceUsd && pPos.quantityAtomic) {\r\n      const pQty = toUiAmount(pMint, Number(pPos.quantityAtomic), pPos.tokenDecimals ?? undefined);\r\n      totalPortfolioValueUsd += pPos.lastMarkedPriceUsd * pQty;\r\n    }\r\n  }\r\n  const roundedPortfolio = Number(totalPortfolioValueUsd.toFixed(6));\r\n\r\n  const roundedUnrealized = Number(totalUnrealizedPnlUsd.toFixed(6));\r\n  const fundingPatchObj: Record<string, unknown> = {};\r\n  if (roundedUnrealized !== session.funding.unrealizedPnlUsd) {\r\n    fundingPatchObj.unrealizedPnlUsd = roundedUnrealized;\r\n  }\r\n  if (roundedPortfolio !== (session.funding as any).totalPortfolioValueUsd) {\r\n    fundingPatchObj.totalPortfolioValueUsd = roundedPortfolio;\r\n  }\r\n  if (Object.keys(fundingPatchObj).length > 0) {\r\n    await mergeFundingPatch(session, fundingPatchObj);\r\n  }`;

if (src.includes(unrealizedPatchAnchor)) {
  src = src.replace(unrealizedPatchAnchor, replacement);
  changes++;
  console.log('3. Added totalPortfolioValueUsd computation (CRLF)');
} else {
  // Try LF
  const unrealizedPatchAnchorLF = unrealizedPatchAnchor.replace(/\r\n/g, '\n');
  if (src.includes(unrealizedPatchAnchorLF)) {
    src = src.replace(unrealizedPatchAnchorLF, replacement.replace(/\r\n/g, '\n'));
    changes++;
    console.log('3. Added totalPortfolioValueUsd computation (LF)');
  } else {
    console.log('3. FAIL: unrealized PnL patch anchor not found');
    // Debug: find it
    const idx = src.indexOf('roundedUnrealized !== session.funding.unrealizedPnlUsd');
    if (idx > -1) {
      console.log('   Found unrealized check at index', idx);
      console.log('   Context:', JSON.stringify(src.substring(idx - 100, idx + 150)));
    }
  }
}

if (changes > 0) {
  fs.writeFileSync(file, src);
}
console.log(`\nDone: ${changes} changes applied to worker.`);
