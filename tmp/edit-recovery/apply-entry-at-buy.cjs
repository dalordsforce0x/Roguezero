// Root-cause fix: record the position at BUY time with the real fill price,
// instead of letting the orphan-recovery loop reconstruct it later from a
// decoupled Jupiter USD mark (which births positions underwater -> fake stop_loss).
const fs = require('fs');
const P = 'services/worker/src/index.ts';
let s = fs.readFileSync(P, 'latin1');
const orig = s;

const anchor =
  "      if (entryInputUsd !== null && entryInputUsd > 0 && entryOutUi > 0) {\r\n" +
  "        pendingEntryFillPriceByMint.set(`${session.id}:${entryOutputMint}`, {\r\n" +
  "          priceUsd: entryInputUsd / entryOutUi,\r\n" +
  "          strategy: tradePlan.entryStrategy ?? null,\r\n" +
  "          at: Date.now(),\r\n" +
  "        });\r\n" +
  "      }\r\n";

const replacement =
  "      if (entryInputUsd !== null && entryInputUsd > 0 && entryOutUi > 0) {\r\n" +
  "        const entryPriceUsdReal = entryInputUsd / entryOutUi;\r\n" +
  "        pendingEntryFillPriceByMint.set(`${session.id}:${entryOutputMint}`, {\r\n" +
  "          priceUsd: entryPriceUsdReal,\r\n" +
  "          strategy: tradePlan.entryStrategy ?? null,\r\n" +
  "          at: Date.now(),\r\n" +
  "        });\r\n" +
  "        // Record the position NOW with the real fill price. Previously the worker\r\n" +
  "        // never created a position at buy time and relied on the orphan-recovery\r\n" +
  "        // loop to reconstruct it from a Jupiter USD mark decoupled from the\r\n" +
  "        // executable price, birthing positions instantly underwater -> fake\r\n" +
  "        // stop_loss churn. Creating it here means recovery's\r\n" +
  "        // `if (reconciledPositions[mint]) continue;` skips it and the true cost\r\n" +
  "        // basis is never overwritten by a mark.\r\n" +
  "        const entryNowIso = new Date().toISOString();\r\n" +
  "        positionsState = await persistPositionsState(session, {\r\n" +
  "          activePositionMint: entryOutputMint,\r\n" +
  "          positions: {\r\n" +
  "            ...positionsState.positions,\r\n" +
  "            [entryOutputMint]: {\r\n" +
  "              status: 'long',\r\n" +
  "              positionMint: entryOutputMint,\r\n" +
  "              positionSymbol: resolveTokenSymbol(entryOutputMint),\r\n" +
  "              entryStrategy: tradePlan.entryStrategy ?? null,\r\n" +
  "              entryPriceUsd: entryPriceUsdReal,\r\n" +
  "              entryAt: entryNowIso,\r\n" +
  "              quantityAtomic: String(entryOutAtomic),\r\n" +
  "              tokenDecimals: getMintDecimals(entryOutputMint),\r\n" +
  "              highWaterPriceUsd: entryPriceUsdReal,\r\n" +
  "              lastMarkedPriceUsd: entryPriceUsdReal,\r\n" +
  "              lastMarkedAt: entryNowIso,\r\n" +
  "              lastComputedAtrUsd: null,\r\n" +
  "              lastComputedAtrBps: null,\r\n" +
  "              atrComputedAt: null,\r\n" +
  "              maxFavorableBps: null,\r\n" +
  "              maxFavorableAt: null,\r\n" +
  "              maxAdverseBps: null,\r\n" +
  "              maxAdverseAt: null,\r\n" +
  "              entryQualityScore: null,\r\n" +
  "              entryQualityBand: null,\r\n" +
  "              pendingExitReason: null,\r\n" +
  "              exitReason: null,\r\n" +
  "              partialExitDone: false,\r\n" +
  "            },\r\n" +
  "          },\r\n" +
  "        });\r\n" +
  "        log('info', session.id, `entry recorded at buy: ${resolveTokenSymbol(entryOutputMint)} entryPriceUsd=${entryPriceUsdReal} qtyAtomic=${entryOutAtomic}`);\r\n" +
  "      }\r\n";

const n = s.split(anchor).length - 1;
if (n !== 1) throw new Error(`anchor matched ${n} times (need exactly 1)`);
s = s.replace(anchor, replacement);
if (s === orig) throw new Error('no change applied');
fs.writeFileSync(P, s, 'latin1');
console.log('OK position-create-at-buy applied; delta', s.length - orig.length);
