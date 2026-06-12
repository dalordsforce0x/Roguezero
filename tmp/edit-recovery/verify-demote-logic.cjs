'use strict';
// Verification harness: replicate the EXACT demote-and-size math + gate threshold
// from services/worker/src/index.ts and run it against the real measured exit costs,
// asserting Noah trades the borderline band and the real walls stay blocked.

const CAP = 12;            // WORKER_MAX_ENTRY_SELL_IMPACT_BPS
const HARD_CEIL = 45;      // WORKER_DEMOTE_MAX_EXIT_BPS
const FLOOR_BPS = 3000;    // WORKER_DEMOTE_SIZE_FLOOR_BPS (0.30x)

// Replicates the gate threshold flip (Edit 3): demote-active => block only above HARD_CEIL.
function gateBlocks(exitBps, demoteActive) {
  if (exitBps === null) return false; // no history -> allowed (first trade to learn)
  const blockBps = demoteActive ? HARD_CEIL : CAP;
  return exitBps > blockBps;
}

// Replicates the demote sizing block (Edit 2): only in band (CAP, HARD_CEIL).
function demoteMultBps(exitBps) {
  if (exitBps === null) return 10000;
  if (exitBps <= CAP) return 10000;        // full size
  if (exitBps >= HARD_CEIL) return 10000;  // out of band -> gate blocks it, sizing untouched
  const raw = Math.round((CAP / exitBps) * 10000);
  return Math.min(10000, Math.max(FLOOR_BPS, raw));
}

// Real measured exit costs (avg sell impact bps) from the 7-day swap_executions join,
// limited to the enabled, tradeable universe. null = no sell history.
const tokens = [
  { sym: 'BABYTROLL', exit: 150.7 },
  { sym: 'KINS', exit: 135.9 },
  { sym: 'Goblin', exit: 132.8 },
  { sym: 'Buttcoin', exit: 124.4 },
  { sym: 'SV151', exit: 93.0 },
  { sym: 'VIRL', exit: 73.7 },
  { sym: 'WORLDCUP', exit: 73.5 },
  { sym: 'three', exit: 53.5 },
  { sym: 'MEW', exit: 52.9 },
  { sym: 'PENGUIN', exit: 48.4 },
  { sym: 'W', exit: 37.0 },
  { sym: 'JTO', exit: 31.7 },
  { sym: 'HNT', exit: 29.6 },
  { sym: 'pippin', exit: 29.0 },
  { sym: 'POPCAT', exit: 21.4 },
  { sym: 'KMNO', exit: 14.5 },
  { sym: 'ORCA', exit: 14.0 },
  { sym: 'PYTH', exit: 12.0 },
  { sym: '$WIF', exit: 11.1 },
  { sym: 'Bonk', exit: 10.7 },
  { sym: 'RAY', exit: 6.3 },
  { sym: 'DRIFT', exit: 3.8 },
  { sym: 'JUP', exit: 2.9 },
  { sym: 'USDC', exit: 2.5 },
  { sym: 'SOL', exit: 2.2 },
  { sym: 'mSOL', exit: 1.3 },
  { sym: 'WBTC', exit: 0.4 },
  { sym: 'JitoSOL', exit: 0.2 },
  { sym: '$michi', exit: null },
  { sym: 'PONKE', exit: null },
];

function classify(t, demoteActive) {
  if (gateBlocks(t.exit, demoteActive)) return 'BLOCK';
  const m = demoteMultBps(t.exit);
  if (m === 10000) return t.exit === null ? 'ALLOW(no-history)' : 'FULL';
  return `DEMOTE ${(m / 10000).toFixed(2)}x`;
}

console.log('=== NOAH (demote-and-size ACTIVE) ===');
let noahTrades = 0, noahBlocked = 0;
for (const t of tokens) {
  const r = classify(t, true);
  if (r === 'BLOCK') noahBlocked++; else noahTrades++;
  console.log(`${t.sym.padEnd(11)} exit=${String(t.exit).padStart(6)}bps -> ${r}`);
}

console.log('\n=== FLEET (demote-and-size NOT graduated) ===');
let fleetTrades = 0, fleetBlocked = 0;
for (const t of tokens) {
  const r = classify(t, false);
  if (r === 'BLOCK') fleetBlocked++; else fleetTrades++;
}

console.log(`\nNoah:  tradeable=${noahTrades}  blocked=${noahBlocked}`);
console.log(`Fleet: tradeable=${fleetTrades}  blocked=${fleetBlocked}`);

// ---- ASSERTIONS ----
const fail = [];
// 1. Blue chips always full size for Noah.
for (const sym of ['SOL', 'USDC', 'JUP', 'mSOL', 'WBTC', 'JitoSOL', 'RAY', 'Bonk', '$WIF', 'DRIFT']) {
  const t = tokens.find((x) => x.sym === sym);
  if (classify(t, true) !== 'FULL') fail.push(`${sym} should be FULL for Noah, got ${classify(t, true)}`);
}
// 2. Borderline band must become tradeable for Noah (the unblock win).
for (const sym of ['POPCAT', 'KMNO', 'ORCA', 'PYTH', 'JTO', 'HNT', 'pippin', 'W']) {
  const t = tokens.find((x) => x.sym === sym);
  const r = classify(t, true);
  if (r === 'BLOCK') fail.push(`${sym} should be tradeable for Noah, got BLOCK`);
}
// 3. Real walls must stay blocked for Noah.
for (const sym of ['BABYTROLL', 'KINS', 'Goblin', 'Buttcoin', 'WORLDCUP', 'MEW', 'three', 'PENGUIN']) {
  const t = tokens.find((x) => x.sym === sym);
  if (classify(t, true) !== 'BLOCK') fail.push(`${sym} should be BLOCK for Noah, got ${classify(t, true)}`);
}
// 4. Fleet keeps the strict 12bps gate: anything >12 blocks.
for (const t of tokens) {
  if (t.exit !== null && t.exit > CAP && classify(t, false) !== 'BLOCK') {
    fail.push(`FLEET: ${t.sym} (${t.exit}bps) should BLOCK under strict cap, got ${classify(t, false)}`);
  }
}
// 5. No-history tokens allowed for both.
for (const sym of ['$michi', 'PONKE']) {
  const t = tokens.find((x) => x.sym === sym);
  if (classify(t, true) === 'BLOCK' || classify(t, false) === 'BLOCK') fail.push(`${sym} should be allowed (no history)`);
}
// 6. Floor respected: no demote multiplier below FLOOR_BPS.
for (const t of tokens) {
  if (t.exit !== null && t.exit > CAP && t.exit < HARD_CEIL) {
    const m = demoteMultBps(t.exit);
    if (m < FLOOR_BPS) fail.push(`${t.sym} demote ${m} below floor ${FLOOR_BPS}`);
  }
}

console.log('\n=== ASSERTIONS ===');
if (fail.length === 0) {
  console.log('ALL PASS');
} else {
  console.log('FAILURES:');
  for (const f of fail) console.log('  - ' + f);
  process.exit(1);
}
