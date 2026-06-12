const fs = require('fs');
const s = fs.readFileSync('services/worker/src/index.ts', 'latin1');
const feats = [
  'WORKER_EXIT_TELEMETRY', 'WORKER_ADAPTIVE_EXIT_SHADOW', 'WORKER_PARTIAL_TP_ENABLED',
  'WORKER_GRID_CHOP_SHADOW', 'WORKER_GRID_CHOP_ENABLED', 'tokenClass', 'TOKEN_CLASS',
  'partial-tp', 'adaptiveExitShadow', 'gridChopShadow', 'maxFavorableBps', 'maxAdverseBps',
  'getTokenClass', 'class_entry', 'partialExitDone', 'trailing',
];
for (const f of feats) {
  const n = s.split(f).length - 1;
  console.log((n > 0 ? 'YES' : 'NO ') + '  ' + String(n).padStart(4) + 'x  ' + f);
}
