const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');

function apply(label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  console.log(`[${label}] applied`);
}

// 1) Add profit-margin const after GRID_RECENT_MOVE_LOOKBACK
apply(
  'profit-margin-const',
  `const GRID_RECENT_MOVE_LOOKBACK = Number(process.env.WORKER_GRID_RECENT_MOVE_LOOKBACK ?? 3);`,
  `const GRID_RECENT_MOVE_LOOKBACK = Number(process.env.WORKER_GRID_RECENT_MOVE_LOOKBACK ?? 3);
// Safety margin (bps) required ON TOP of the derived round-trip break-even before a grid
// range is considered tradeable. Keeps grid signals honestly above worst-case cost.
const GRID_PROFIT_MARGIN_BPS = Number(process.env.WORKER_GRID_PROFIT_MARGIN_BPS ?? 15);`,
);

// 2) computeVirtualGridBand: accept derived min-width, use it (not the static fee-floor const)
apply(
  'grid-band-signature',
  `const computeVirtualGridBand = (mint: string, isChop: boolean): GridBandDecision => {`,
  `const computeVirtualGridBand = (mint: string, isChop: boolean, minProfitableWidthBps: number): GridBandDecision => {`,
);

apply(
  'grid-band-too-tight',
  `  if (rangeWidthBps < GRID_RANGE_MIN_WIDTH_BPS) {
    return { action: 'grid_range_too_tight', reason: 'range_below_fee_floor', ...diag };
  }`,
  `  // Honest break-even: a round trip must clear cost on BOTH legs, and the bands only let us
  // capture the fraction of the range between the buy edge and the sell edge. minProfitableWidthBps
  // is derived from the session's real round-trip cost at the call site. GRID_RANGE_MIN_WIDTH_BPS
  // acts only as an env-tunable absolute floor that can RAISE (never lower) the economic threshold.
  const effectiveMinWidthBps = Math.max(GRID_RANGE_MIN_WIDTH_BPS, minProfitableWidthBps);
  if (rangeWidthBps < effectiveMinWidthBps) {
    return { action: 'grid_range_too_tight', reason: \`range_below_breakeven_\${effectiveMinWidthBps}bps\`, ...diag };
  }`,
);

// 3) call site: derive minProfitableWidthBps from session round-trip economics, pass it in
apply(
  'grid-derive-and-pass',
  `      ? 'chop' as const
      : 'trend' as const;

  return {
    at: new Date().toISOString(),`,
  `      ? 'chop' as const
      : 'trend' as const;

  // Derive the grid's economic break-even from the session's REAL round-trip cost:
  //   one-way  = expected slippage + platform fee (the same honest floor used for partial-TP)
  //   round    = 2 x one-way (buy leg + sell leg)
  //   capture  = fraction of range we can actually bank between the band edges (worst case:
  //              buy at the buy-band edge, sell at the sell-band edge) = (100 - 2*edgePct)/100
  //   minWidth = ceil(round / capture) + safety margin
  // Below this width a buy-low/sell-high round trip cannot net positive, so the grid sits out.
  const gridPlatformFeeBps = Number(params.session.service_control.platformFeeBps ?? 0);
  const gridRoundTripCostBps = (WORKER_EXIT_EXPECTED_SLIPPAGE_BPS + gridPlatformFeeBps) * 2;
  const gridCaptureFraction = Math.max(0.1, (100 - 2 * GRID_BAND_EDGE_PCT) / 100);
  const gridMinProfitableWidthBps = Math.ceil(gridRoundTripCostBps / gridCaptureFraction) + GRID_PROFIT_MARGIN_BPS;

  return {
    at: new Date().toISOString(),`,
);

apply(
  'grid-band-call',
  `          const band = computeVirtualGridBand(String(evaluation.mint), marketRegime === 'chop');`,
  `          const band = computeVirtualGridBand(String(evaluation.mint), marketRegime === 'chop', gridMinProfitableWidthBps);`,
);

fs.writeFileSync(path, src, 'utf8');
console.log('DONE: grid economic break-even calibration applied');
