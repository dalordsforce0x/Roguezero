const fs = require('fs');
const path = 'services/worker/src/index.ts';
const raw = fs.readFileSync(path, 'latin1');
let text = raw.split(/\r?\n/).join('\n');

function replaceOnce(t, find, repl, label) {
  const n = t.split(find).length - 1;
  if (n !== 1) throw new Error(`[${label}] expected 1 occurrence, got ${n}`);
  return t.replace(find, repl);
}

// ---- Edit 1: module-level stash map declaration ----
const A1 = "const pendingEntryQualityByMint = new Map<string, { score: number; band: string }>();";
const A1repl = A1 + "\n" +
`// Real executed entry price (USD per output token) captured at submit time from the
// actual swap fill, keyed \`\${sessionId}:\${outputMint}\`. Consumed by the inventory
// re-track so a freshly bought position uses its TRUE cost basis instead of a Jupiter
// USD mark that can be decoupled from the executable route price (which births
// positions instantly underwater and triggers a spurious stop_loss).
const pendingEntryFillPriceByMint = new Map<string, { priceUsd: number; strategy: StrategyKey | null; at: number }>();
const PENDING_ENTRY_FILL_TTL_MS = 5 * 60_000;`;
text = replaceOnce(text, A1, A1repl, 'map-decl');

// ---- Edit 2: stash the real fill price at submit success (inside enter_long block) ----
const A2 = "  if (tradePlan.direction === 'enter_long') {\n    const nextScannerStrategy = getNextStrategyInSequence(";
const stashBlock =
`    // Capture the REAL executed entry price from this fill so the position's cost
    // basis matches what we actually paid. Without this, inventory re-track stamps
    // entryPriceUsd from a Jupiter USD mark decoupled from the executable price,
    // birthing positions instantly underwater and firing a spurious stop_loss.
    const entryQuoteForBasis = prepare?.data.quote ?? null;
    if (entryQuoteForBasis) {
      const entryInAtomic = Number(entryQuoteForBasis.inAmount);
      const entryOutAtomic = Number(entryQuoteForBasis.outAmount);
      const entryInputMint = tradePlan.inventory.inputMint;
      const entryOutputMint = tradePlan.inventory.outputMint;
      const solUsdForBasis = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? null;
      let entryInputUsd: number | null = null;
      if (entryInputMint === USDC_MINT) {
        entryInputUsd = entryInAtomic / 1_000_000;
      } else if (entryInputMint === SOL_MINT && solUsdForBasis && solUsdForBasis > 0) {
        entryInputUsd = (entryInAtomic / 1_000_000_000) * solUsdForBasis;
      }
      const entryOutUi = entryOutAtomic > 0 ? toUiAmount(entryOutputMint, entryOutAtomic) : 0;
      if (entryInputUsd !== null && entryInputUsd > 0 && entryOutUi > 0) {
        pendingEntryFillPriceByMint.set(\`\${session.id}:\${entryOutputMint}\`, {
          priceUsd: entryInputUsd / entryOutUi,
          strategy: tradePlan.entryStrategy ?? null,
          at: Date.now(),
        });
      }
    }`;
const A2repl = "  if (tradePlan.direction === 'enter_long') {\n" + stashBlock + "\n    const nextScannerStrategy = getNextStrategyInSequence(";
text = replaceOnce(text, A2, A2repl, 'stash-write');

// ---- Edit 3: consume the stash at inventory re-track creation ----
const A3 =
`      const nowIso = new Date().toISOString();
      reconciledPositions[mint] = {
        status: 'long',
        positionMint: mint,
        positionSymbol: resolveTokenSymbol(mint),
        entryStrategy: null,
        entryPriceUsd: markPriceUsd,
        entryAt: nowIso,
        quantityAtomic: String(holding.atomic),
        tokenDecimals: holding.decimals,
        highWaterPriceUsd: markPriceUsd,
        lastMarkedPriceUsd: markPriceUsd,
        lastMarkedAt: markPriceUsd !== null ? nowIso : null,`;
const A3repl =
`      const nowIso = new Date().toISOString();
      // Prefer the REAL executed entry price captured at submit time over the current
      // Jupiter USD mark. The mark is decoupled from the executable route price for
      // many tokens, so using it as cost basis births positions instantly underwater
      // and fires a spurious stop_loss. The stash is only populated for our own buys;
      // genuine orphans (manual deposits) fall back to the mark.
      const entryFillStashKey = \`\${session.id}:\${mint}\`;
      const stashedEntryFill = pendingEntryFillPriceByMint.get(entryFillStashKey) ?? null;
      const stashedEntryFillFresh = stashedEntryFill !== null
        && Date.now() - stashedEntryFill.at <= PENDING_ENTRY_FILL_TTL_MS
        && stashedEntryFill.priceUsd > 0;
      if (stashedEntryFill !== null) {
        pendingEntryFillPriceByMint.delete(entryFillStashKey);
      }
      const recoveredEntryPriceUsd = stashedEntryFillFresh ? stashedEntryFill!.priceUsd : markPriceUsd;
      const recoveredEntryStrategy = stashedEntryFillFresh ? stashedEntryFill!.strategy : null;
      reconciledPositions[mint] = {
        status: 'long',
        positionMint: mint,
        positionSymbol: resolveTokenSymbol(mint),
        entryStrategy: recoveredEntryStrategy,
        entryPriceUsd: recoveredEntryPriceUsd,
        entryAt: nowIso,
        quantityAtomic: String(holding.atomic),
        tokenDecimals: holding.decimals,
        highWaterPriceUsd: recoveredEntryPriceUsd,
        lastMarkedPriceUsd: recoveredEntryPriceUsd,
        lastMarkedAt: recoveredEntryPriceUsd !== null ? nowIso : null,`;
text = replaceOnce(text, A3, A3repl, 'stash-consume');

fs.writeFileSync(path, text.split('\n').join('\r\n'), 'latin1');
console.log('All 3 edits applied.');
