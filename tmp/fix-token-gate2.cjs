const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(f, 'utf8');
let patchCount = 0;

// ── Patch 1: Per-token gate: regime !== 'bullish' → regime === 'bearish' ──
const old1 = "tokenEntrySignal.status !== 'ready' || tokenEntrySignal.regime !== 'bullish'";
const new1 = "tokenEntrySignal.status !== 'ready' || tokenEntrySignal.regime === 'bearish'";
if (src.includes(old1)) {
  src = src.replace(old1, new1);
  patchCount++;
  console.log('PATCH 1 applied: per-token gate relaxed');
} else if (src.includes(new1)) {
  console.log('PATCH 1 already applied');
} else {
  console.error('PATCH 1 anchor not found!');
  process.exit(1);
}

// ── Patch 1b: Log message ──
const oldLog = 'entry blocked: token signal not bullish for';
const newLog = 'entry blocked: token signal bearish for';
if (src.includes(oldLog)) {
  src = src.replace(oldLog, newLog);
  console.log('PATCH 1b applied: log message updated');
}

// ── Patch 2: Add WORKER_ALLOWED_TOKEN_CLASSES parser ──
// This code was never committed — it only existed in VS Code buffer.
// We need to add it. Insert after WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED.
const insertAfter = "const WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED = process.env.WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED !== 'false';";
const parserCode = `
// Restrict entries to these token classes (comma or space separated). Empty = all allowed.
// SOL signal only predicts SOL-correlated tokens — restrict to 'major,sol_beta' to stop bleeding.
const WORKER_ALLOWED_TOKEN_CLASSES: ReadonlySet<string> | null = (() => {
  const raw = process.env.WORKER_ALLOWED_TOKEN_CLASSES?.trim();
  if (!raw) return null;
  return new Set(raw.split(/[,\\s]+/).map((s) => s.trim()).filter(Boolean));
})();`;

if (src.includes('WORKER_ALLOWED_TOKEN_CLASSES')) {
  console.log('PATCH 2 skipped: WORKER_ALLOWED_TOKEN_CLASSES already exists');
} else if (src.includes(insertAfter)) {
  src = src.replace(insertAfter, insertAfter + parserCode);
  patchCount++;
  console.log('PATCH 2 applied: WORKER_ALLOWED_TOKEN_CLASSES parser added');
} else {
  console.error('PATCH 2 anchor not found!');
  process.exit(1);
}

// ── Patch 3: Add token class filter to getUniverseScoutCandidateMints ──
// Check if the filter already exists
const filterLine = "WORKER_ALLOWED_TOKEN_CLASSES";
if (src.includes("!WORKER_ALLOWED_TOKEN_CLASSES || WORKER_ALLOWED_TOKEN_CLASSES.has(getTokenTradeClass")) {
  console.log('PATCH 3 skipped: token class filter already in scout');
} else {
  // Find the filter chain in getUniverseScoutCandidateMints and add the class filter
  const filterAnchor = "&& (!WORKER_BLOCK_PUMP_MINT_ENTRIES || !mint.toLowerCase().endsWith('pump'))";
  if (src.includes(filterAnchor)) {
    src = src.replace(
      filterAnchor,
      filterAnchor + "\n        && (!WORKER_ALLOWED_TOKEN_CLASSES || WORKER_ALLOWED_TOKEN_CLASSES.has(getTokenTradeClass(mint, symbol ?? undefined)))"
    );
    patchCount++;
    console.log('PATCH 3 applied: token class filter added to scout');
  } else {
    console.error('PATCH 3 anchor not found - checking for pump mint filter...');
    // Try alternate anchor
    const altAnchor = "&& !(params.excludedMints?.has(mint) ?? false)";
    if (src.includes(altAnchor)) {
      src = src.replace(
        altAnchor,
        "&& (!WORKER_ALLOWED_TOKEN_CLASSES || WORKER_ALLOWED_TOKEN_CLASSES.has(getTokenTradeClass(mint, symbol ?? undefined)))\n        " + altAnchor
      );
      patchCount++;
      console.log('PATCH 3 applied (alt anchor): token class filter added to scout');
    } else {
      console.error('PATCH 3: no suitable anchor found, skipping');
    }
  }
}

fs.writeFileSync(f, src);
console.log(`Done. ${patchCount} patch(es) written to disk.`);
