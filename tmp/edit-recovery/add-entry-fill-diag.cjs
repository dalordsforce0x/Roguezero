// Adds targeted diagnostics to the entry-fill stash SET and orphan CONSUME paths
// so the next real entry reveals exactly why entryPriceUsd is a decoupled mark.
const fs = require('fs');
const P = 'services/worker/src/index.ts';
let s = fs.readFileSync(P, 'latin1');
const orig = s;

function replaceOnce(find, repl, label) {
  const n = s.split(find).length - 1;
  if (n !== 1) throw new Error(`anchor "${label}" matched ${n} times (need 1)`);
  s = s.replace(find, repl);
}

// 1) Log when prepare.data.quote is missing (stash never set).
replaceOnce(
  "    const entryQuoteForBasis = prepare?.data.quote ?? null;\r\n    if (entryQuoteForBasis) {\r\n",
  "    const entryQuoteForBasis = prepare?.data.quote ?? null;\r\n    if (!entryQuoteForBasis) { log('warn', session.id, `entry-fill DIAG: missing prepare.data.quote prepare=${prepare ? 'y' : 'n'}`); }\r\n    if (entryQuoteForBasis) {\r\n",
  'no-quote-diag',
);

// 2) Log the computed basis inputs right before the set guard.
replaceOnce(
  "      const entryOutUi = entryOutAtomic > 0 ? toUiAmount(entryOutputMint, entryOutAtomic) : 0;\r\n      if (entryInputUsd !== null && entryInputUsd > 0 && entryOutUi > 0) {\r\n",
  "      const entryOutUi = entryOutAtomic > 0 ? toUiAmount(entryOutputMint, entryOutAtomic) : 0;\r\n      log('info', session.id, `entry-fill DIAG basis out=${entryOutputMint} inMint=${entryInputMint} inAtomic=${entryInAtomic} inputUsd=${entryInputUsd} outUi=${entryOutUi} solUsd=${solUsdForBasis}`);\r\n      if (entryInputUsd !== null && entryInputUsd > 0 && entryOutUi > 0) {\r\n",
  'basis-input-diag',
);

// 3) Log the consume decision in the orphan re-track.
replaceOnce(
  "      const recoveredEntryPriceUsd = stashedEntryFillFresh ? stashedEntryFill!.priceUsd : markPriceUsd;\r\n",
  "      const recoveredEntryPriceUsd = stashedEntryFillFresh ? stashedEntryFill!.priceUsd : markPriceUsd;\r\n      log('info', session.id, `entry-fill DIAG consume mint=${mint} stash=${stashedEntryFill ? 'y' : 'n'} fresh=${stashedEntryFillFresh} recovered=${recoveredEntryPriceUsd} mark=${markPriceUsd}`);\r\n",
  'consume-diag',
);

if (s === orig) throw new Error('no changes applied');
fs.writeFileSync(P, s, 'latin1');
console.log('OK applied 3 diagnostics; new length', s.length, 'delta', s.length - orig.length);
