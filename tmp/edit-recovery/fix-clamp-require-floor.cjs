// Fix clamp logic: require reaching the FULL safe floor (with headroom). If the floor exceeds
// either the max-trade cap (fee spike) or tradable balance, SKIP cleanly instead of clamping to a
// marginal size that lands at the cost cap and churns the edge gate.
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'latin1');
const L = (...lines) => lines.join('\r\n');

function replaceOnce(oldStr, newStr, label) {
  const n = src.split(oldStr).length - 1;
  if (n !== 1) throw new Error(`EXPECTED 1 occurrence for ${label}, found ${n}`);
  src = src.replace(oldStr, newStr);
  console.log(`OK ${label}`);
}

const old = L(
  '    if (economicFloorAtomic > 0) {',
  '      const preFloorAmount = entryInventory.amountAtomic ?? 0;',
  '      const affordableFloor = Math.min(economicFloorAtomic, entryInventory.maxTradeAtomic);',
  '      if (preFloorAmount > 0 && preFloorAmount < affordableFloor) {',
  '        if (affordableFloor <= entryInventory.tradableAtomic) {',
  '          log(',
  "            'info',",
  '            session.id,',
  '            `entry economic floor ${economicFloorActive ? \'apply\' : \'shadow\'}: ${entryInventory.inputSymbol}->${entryInventory.outputSymbol} amount ${preFloorAmount} -> ${affordableFloor} floor=${economicFloorAtomic} (cost=${recentNetworkCostLamports}lamports cap=${MAX_QUOTE_PRICE_IMPACT_BPS}bps) sub-economic clamp`,',
  '          );',
  '          if (economicFloorActive) {',
  '            entryInventory.amountAtomic = affordableFloor;',
  '            entryInventory.riskAdjustedAmountAtomic = affordableFloor;',
  '          }',
  '        } else if (economicFloorActive) {',
);
const neu = L(
  '    if (economicFloorAtomic > 0) {',
  '      const preFloorAmount = entryInventory.amountAtomic ?? 0;',
  '      // Only act when the entry is sub-economic. Require reaching the FULL headroom floor: if it does',
  '      // not fit under both the max-trade cap (fee spike) and tradable balance, skip rather than clamp',
  '      // to a marginal size that sits at the cost cap and churns the edge gate.',
  '      const floorFits = economicFloorAtomic <= entryInventory.maxTradeAtomic',
  '        && economicFloorAtomic <= entryInventory.tradableAtomic;',
  '      if (preFloorAmount > 0 && preFloorAmount < economicFloorAtomic) {',
  '        if (floorFits) {',
  '          log(',
  "            'info',",
  '            session.id,',
  '            `entry economic floor ${economicFloorActive ? \'apply\' : \'shadow\'}: ${entryInventory.inputSymbol}->${entryInventory.outputSymbol} amount ${preFloorAmount} -> ${economicFloorAtomic} floor=${economicFloorAtomic} (cost=${recentNetworkCostLamports}lamports cap=${MAX_QUOTE_PRICE_IMPACT_BPS}bps) sub-economic clamp`,',
  '          );',
  '          if (economicFloorActive) {',
  '            entryInventory.amountAtomic = economicFloorAtomic;',
  '            entryInventory.riskAdjustedAmountAtomic = economicFloorAtomic;',
  '          }',
  '        } else if (economicFloorActive) {',
);
replaceOnce(old, neu, 'clamp-require-full-floor');

fs.writeFileSync(path, src, 'latin1');
console.log('WROTE', path, 'bytes', src.length);
