/**
 * Patch: Fix dynamic exit thresholds to make them truly per-token/per-position.
 *
 * Four changes:
 * 1. computeExitCostFloorBps gains optional positionState param so per-position
 *    measured exit impact feeds into the cost floor. computeDynamicExitThresholds
 *    passes it through.
 *
 * 2a/2b. Stop loss decoupled from cost floor. The cost floor ensures TP clears
 *    round-trip friction — correct. But flooring SL at the same value creates
 *    1:1 R:R. A stop loss IS a loss; sized by ATR or configured minimum.
 *
 * 3. WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED default changed to true.
 */

const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(workerPath, 'utf8');
const original = src;

let changeCount = 0;

// ── Change 1a: Add positionState param to computeExitCostFloorBps ────────
// From:  const computeExitCostFloorBps = (session: RawSession): number => Math.max(
// To:    const computeExitCostFloorBps = (session: RawSession, positionState?: ... | null): number => {
//          ... use measuredExitImpactBps from positionState ...
{
  const targetLF = 'const computeExitCostFloorBps = (session: RawSession): number => Math.max(\n  positionExitPolicy.exitCostFloorBps,\n  session.risk_limits.maxSlippageBps + session.service_control.platformFeeBps + signalPolicy.edgeSafetyBufferBps,\n);';
  const targetCRLF = targetLF.replace(/\n/g, '\r\n');
  const target = src.includes(targetCRLF) ? targetCRLF : targetLF;
  const targetIdx = src.indexOf(target);
  if (targetIdx < 0) {
    console.error('FAIL: Could not find computeExitCostFloorBps definition');
    process.exit(1);
  }
  const nl = src.includes(targetCRLF) ? '\r\n' : '\n';
  const replacement = [
    'const computeExitCostFloorBps = (',
    "  session: RawSession,",
    "  positionState?: NonNullable<Session['serviceControl']['positionState']> | null,",
    '): number => {',
    '  // Use per-position measured exit impact when available (persisted in position state).',
    '  // When HIGHER than assumed slippage, it overrides — never under-price the real exit toll.',
    '  const measuredExitImpactBps = positionState?.measuredExitImpactBps ?? null;',
    '  const slippageComponentBps = measuredExitImpactBps !== null',
    '    ? Math.max(measuredExitImpactBps, session.risk_limits.maxSlippageBps)',
    '    : session.risk_limits.maxSlippageBps;',
    '  // Round-trip cost: entry-leg cost (from position state if tracked, else',
    '  // mirror exit as conservative estimate) + exit-leg cost.',
    '  const entryCostBps = positionState?.entryCostBps ?? slippageComponentBps;',
    '  const exitOnlyCostBps = Math.max(',
    '    positionExitPolicy.exitCostFloorBps,',
    '    slippageComponentBps + session.service_control.platformFeeBps + signalPolicy.edgeSafetyBufferBps,',
    '  );',
    '  return exitOnlyCostBps + entryCostBps;',
    '};',
  ].join(nl);
  src = src.substring(0, targetIdx) + replacement + src.substring(targetIdx + target.length);
  changeCount++;
  console.log('✓ Change 1a: computeExitCostFloorBps now accepts positionState, uses measured exit impact + entry cost');
}

// ── Change 1b: Pass positionState in computeDynamicExitThresholds ────────
{
  const anchor = 'const computeDynamicExitThresholds = (';
  const anchorIdx = src.indexOf(anchor);
  if (anchorIdx < 0) {
    console.error('FAIL: Could not find computeDynamicExitThresholds');
    process.exit(1);
  }
  const target = 'const costFloorBps = computeExitCostFloorBps(session);';
  const targetIdx = src.indexOf(target, anchorIdx);
  if (targetIdx < 0 || (targetIdx - anchorIdx) > 500) {
    console.error('FAIL: computeExitCostFloorBps(session) not found near computeDynamicExitThresholds');
    process.exit(1);
  }
  src = src.substring(0, targetIdx) +
    'const costFloorBps = computeExitCostFloorBps(session, positionState);' +
    src.substring(targetIdx + target.length);
  changeCount++;
  console.log('✓ Change 1b: computeDynamicExitThresholds passes positionState to costFloor');
}

// ── Change 2a: Decouple stop loss from cost floor in FALLBACK path ───────
{
  // Find the second occurrence of mode: 'fallback' — first might be in type def
  const fallbackTarget = "mode: 'fallback'";
  let fallbackIdx = src.indexOf(fallbackTarget);
  // Check if this is inside computeDynamicExitThresholds by looking for stopLossBps nearby
  const regionBefore = src.substring(Math.max(0, fallbackIdx - 300), fallbackIdx);
  if (!regionBefore.includes('stopLossBps')) {
    // Try second occurrence
    fallbackIdx = src.indexOf(fallbackTarget, fallbackIdx + 1);
  }
  if (fallbackIdx < 0) {
    console.error('FAIL: Could not find fallback mode marker');
    process.exit(1);
  }
  const searchRegion = src.substring(fallbackIdx - 500, fallbackIdx);
  const target = 'stopLossBps: Math.max(positionExitPolicy.stopLossBps, costFloorBps),';
  const relIdx = searchRegion.indexOf(target);
  if (relIdx < 0) {
    console.error('FAIL: Could not find fallback stopLossBps line');
    process.exit(1);
  }
  const absIdx = fallbackIdx - 500 + relIdx;
  src = src.substring(0, absIdx) +
    'stopLossBps: positionExitPolicy.stopLossBps,' +
    src.substring(absIdx + target.length);
  changeCount++;
  console.log('✓ Change 2a: Decouple stop loss from cost floor (fallback path)');
}

// ── Change 2b: Decouple stop loss from cost floor in ATR path ────────────
{
  // There are TWO 'mode: 'atr'' occurrences — one in the type definition, one in
  // computeDynamicExitThresholds. We need the second one (inside the function).
  const atrTarget = "mode: 'atr'";
  const firstIdx = src.indexOf(atrTarget);
  const secondIdx = src.indexOf(atrTarget, firstIdx + 1);
  const atrIdx = secondIdx >= 0 ? secondIdx : firstIdx;
  if (atrIdx < 0) {
    console.error('FAIL: Could not find atr mode marker in computeDynamicExitThresholds');
    process.exit(1);
  }
  const regionBefore = src.substring(Math.max(0, atrIdx - 400), atrIdx);
  if (!regionBefore.includes('stopLossBps')) {
    console.error('FAIL: stopLossBps not found near second atr mode marker');
    process.exit(1);
  }
  // The multi-line pattern uses platform-specific line endings; handle both
  const target1 = 'stopLossBps: Math.max(\n      costFloorBps,';
  const target2 = 'stopLossBps: Math.max(\r\n      costFloorBps,';
  let relIdx = regionBefore.indexOf(target2);
  let targetLen = target2.length;
  if (relIdx < 0) {
    relIdx = regionBefore.indexOf(target1);
    targetLen = target1.length;
  }
  if (relIdx < 0) {
    console.error('FAIL: Could not find ATR stopLossBps block');
    console.error('Region (last 200):', regionBefore.substring(regionBefore.length - 200));
    process.exit(1);
  }
  const absIdx = atrIdx - regionBefore.length + relIdx;
  const nl = regionBefore.includes('\r\n') ? '\r\n' : '\n';
  src = src.substring(0, absIdx) +
    'stopLossBps: Math.max(' + nl + '      positionExitPolicy.stopLossBps,' +
    src.substring(absIdx + targetLen);
  changeCount++;
  console.log('✓ Change 2b: Decouple stop loss from cost floor (ATR path)');
}

// ── Change 3: Enable WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED by default ─
{
  const target = "const WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED = process.env.WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED === 'true';";
  const targetIdx = src.indexOf(target);
  if (targetIdx < 0) {
    console.error('FAIL: Could not find WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED declaration');
    process.exit(1);
  }
  src = src.substring(0, targetIdx) +
    "const WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED = process.env.WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED !== 'false';" +
    src.substring(targetIdx + target.length);
  changeCount++;
  console.log('✓ Change 3: WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED default true (opt-out with false)');
}

if (src === original) {
  console.error('FAIL: No changes were made');
  process.exit(1);
}

fs.writeFileSync(workerPath, src);
console.log(`\nAll ${changeCount} changes applied successfully.`);

// Verify the changes
const verify = fs.readFileSync(workerPath, 'utf8');
const checks = [
  ['computeExitCostFloorBps(session, positionState)', 'positionState passthrough'],
  ['slippageComponentBps', 'measured exit impact logic'],
  ['entryCostBps = positionState?.entryCostBps', 'entry cost from position'],
  ['stopLossBps: positionExitPolicy.stopLossBps,', 'fallback SL decoupled'],
  ["WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED = process.env.WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED !== 'false'", 'feature flag default true'],
];
let allOk = true;
for (const [needle, label] of checks) {
  if (verify.includes(needle)) {
    console.log(`  ✓ verify: ${label}`);
  } else {
    console.error(`  ✗ verify FAIL: ${label}`);
    allOk = false;
  }
}
if (!allOk) {
  console.error('\nSome verifications failed!');
  process.exit(1);
}
console.log('\nAll verifications passed.');
