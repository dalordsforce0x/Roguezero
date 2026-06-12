const fs = require('fs');
const path = 'services/worker/src/index.ts';
let s = fs.readFileSync(path, 'latin1');
const CR = '\r\n';

function replaceOnce(hay, oldStr, newStr, label) {
  let i = 0, c = 0;
  while ((i = hay.indexOf(oldStr, i)) !== -1) { c++; i += oldStr.length; }
  if (c !== 1) { console.error(`ABORT ${label}: occurrences=${c}`); process.exit(1); }
  return hay.replace(oldStr, newStr);
}

const oldStr = [
  "      log('info', session.id, `entry blocked: ${resolveTokenSymbol(selectedEntryMint)} already open in portfolio`);",
  '      return;',
  '    }',
  '',
  "    if (tokenEntrySignal.status !== 'ready' || tokenEntrySignal.regime !== 'bullish') {",
].join(CR);

const newStr = [
  "      log('info', session.id, `entry blocked: ${resolveTokenSymbol(selectedEntryMint)} already open in portfolio`);",
  '      return;',
  '    }',
  '',
  '    // Price-availability gate. Never enter a token we cannot price: without a',
  '    // live USD mark we cannot mark the position, evaluate stop/take-profit, or',
  '    // report honest PnL. SOL is priced via the Pyth feed; every other entry mint',
  '    // must have a live Jupiter USD price before we commit capital to it.',
  '    if (selectedEntryMint !== SOL_MINT) {',
  '      const entryMintUsdPrice = latestJupiterUsdByMint.get(selectedEntryMint) ?? null;',
  '      if (entryMintUsdPrice === null || !Number.isFinite(entryMintUsdPrice) || entryMintUsdPrice <= 0) {',
  "        recordEntryRejectCooldown(session, selectedEntryMint, 'entry_token_unpriced');",
  "        await persistTradeDecision(session, 'blocked', 'entry_token_unpriced');",
  '        await persistLastTradeGate(session, {',
  '          at: new Date().toISOString(),',
  "          decision: 'blocked',",
  "          reason: 'entry_token_unpriced',",
  '          expectedEdgeBps: tokenEntrySignal.momentumBps,',
  '          estimatedCostBps: null,',
  '          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,',
  '        });',
  "        log('info', session.id, `entry blocked: no live USD price for ${resolveTokenSymbol(selectedEntryMint)} (${selectedEntryMint}) -- refusing to trade an unpriceable token`);",
  '        return;',
  '      }',
  '    }',
  '',
  "    if (tokenEntrySignal.status !== 'ready' || tokenEntrySignal.regime !== 'bullish') {",
].join(CR);

s = replaceOnce(s, oldStr, newStr, 'price-gate');
fs.writeFileSync(path, s, 'latin1');
console.log('APPLIED price-gate. length=', s.length);
