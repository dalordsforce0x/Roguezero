/*
 * Phase 5: upgrade the virtual-grid chop SHADOW from an entry-pnl proxy to a real range-band
 * grid computed from each mint's live price tape (getMomentumTapeForMint). Fixes the doc-forbidden
 * antipattern where a deep-underwater position (-93 pnl) was labelled "grid_buy_zone" (averaging
 * down / catching a falling knife). New logic: detect a valid trading range (wide enough to clear
 * fees, not so wide it's trending), place band edges, buy lower-band PULLBACKS / sell upper-band
 * rips, and REJECT vertical breakouts (no chase) and breakdowns (no buy / falling-knife guard).
 * Still shadow-only (no execution). Disk-edit; split/join only.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');

function apply(label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  console.log('applied', label);
}

// 1) Insert thresholds + GridBandDecision type + computeVirtualGridBand helper before buildGridChopShadow.
apply(
  'helper',
  `const buildGridChopShadow = (params: {`,
  `// Virtual-grid band thresholds (shadow now; future exec). A valid range must oscillate enough to
// clear round-trip fees but not be so wide that it's really a trend. Band edges (bottom/top pct of
// the range) define buy/sell zones; the breakout/breakdown guards stop the grid from chasing a
// vertical move up or averaging down into a breakdown — both explicit doc requirements.
const GRID_RANGE_MIN_WIDTH_BPS = Number(process.env.WORKER_GRID_RANGE_MIN_WIDTH_BPS ?? 25);
const GRID_RANGE_MAX_WIDTH_BPS = Number(process.env.WORKER_GRID_RANGE_MAX_WIDTH_BPS ?? 800);
const GRID_BAND_EDGE_PCT = Number(process.env.WORKER_GRID_BAND_EDGE_PCT ?? 30);
const GRID_BREAKOUT_MOVE_BPS = Number(process.env.WORKER_GRID_BREAKOUT_MOVE_BPS ?? 40);
const GRID_MIN_SAMPLES = Number(process.env.WORKER_GRID_MIN_SAMPLES ?? 8);
const GRID_RANGE_WINDOW = Number(process.env.WORKER_GRID_RANGE_WINDOW ?? 60);
const GRID_RECENT_MOVE_LOOKBACK = Number(process.env.WORKER_GRID_RECENT_MOVE_LOOKBACK ?? 3);

type GridBandDecision = {
  action:
    | 'grid_disabled'
    | 'grid_warmup'
    | 'grid_range_too_tight'
    | 'grid_range_too_wide_trending'
    | 'grid_buy_zone'
    | 'grid_sell_zone'
    | 'grid_hold'
    | 'grid_breakout_no_chase'
    | 'grid_breakdown_no_buy';
  reason: string;
  rangeWidthBps: number | null;
  pricePositionPct: number | null;
  recentMoveBps: number | null;
  sampleCount: number;
  rangeLow: number | null;
  rangeHigh: number | null;
};

const computeVirtualGridBand = (mint: string, isChop: boolean): GridBandDecision => {
  const empty = { rangeWidthBps: null, pricePositionPct: null, recentMoveBps: null, rangeLow: null, rangeHigh: null };
  if (!isChop) {
    return { action: 'grid_disabled', reason: 'not_chop_regime', sampleCount: 0, ...empty };
  }
  const prices = getMomentumTapeForMint(mint)
    .slice(-GRID_RANGE_WINDOW)
    .map((point) => point.usdPrice)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const sampleCount = prices.length;
  if (sampleCount < GRID_MIN_SAMPLES) {
    return { action: 'grid_warmup', reason: 'insufficient_range_samples', sampleCount, ...empty };
  }
  const rangeHigh = Math.max(...prices);
  const rangeLow = Math.min(...prices);
  const current = prices[prices.length - 1];
  const rangeMid = (rangeHigh + rangeLow) / 2;
  const rangeWidthBps = rangeMid > 0 ? Math.round(((rangeHigh - rangeLow) / rangeMid) * 10000) : 0;
  const span = rangeHigh - rangeLow;
  const pricePositionPct = span > 0 ? Math.round(((current - rangeLow) / span) * 100) : 50;
  const lookbackIdx = Math.max(0, prices.length - 1 - GRID_RECENT_MOVE_LOOKBACK);
  const refPrice = prices[lookbackIdx];
  const recentMoveBps = refPrice > 0 ? Math.round(((current - refPrice) / refPrice) * 10000) : 0;
  const diag = { sampleCount, rangeWidthBps, pricePositionPct, recentMoveBps, rangeLow, rangeHigh };

  if (rangeWidthBps < GRID_RANGE_MIN_WIDTH_BPS) {
    return { action: 'grid_range_too_tight', reason: 'range_below_fee_floor', ...diag };
  }
  if (rangeWidthBps > GRID_RANGE_MAX_WIDTH_BPS) {
    return { action: 'grid_range_too_wide_trending', reason: 'range_too_wide_likely_trending', ...diag };
  }
  // Lower band -> buy the pullback, unless price is breaking DOWN (falling-knife guard).
  if (pricePositionPct <= GRID_BAND_EDGE_PCT) {
    if (recentMoveBps <= -GRID_BREAKOUT_MOVE_BPS) {
      return { action: 'grid_breakdown_no_buy', reason: 'range_breakdown_falling_knife', ...diag };
    }
    return { action: 'grid_buy_zone', reason: 'range_lower_pullback', ...diag };
  }
  // Upper band -> sell the rip, unless price is breaking OUT (don't chase the vertical move).
  if (pricePositionPct >= 100 - GRID_BAND_EDGE_PCT) {
    if (recentMoveBps >= GRID_BREAKOUT_MOVE_BPS) {
      return { action: 'grid_breakout_no_chase', reason: 'range_breakout_no_chase', ...diag };
    }
    return { action: 'grid_sell_zone', reason: 'range_upper_profit', ...diag };
  }
  return { action: 'grid_hold', reason: 'inside_grid_neutral_zone', ...diag };
};

const buildGridChopShadow = (params: {`,
);

// 2) Replace the entry-pnl proxy map with the real band computation.
apply(
  'candidates',
  `    candidates: enabled
      ? params.evaluations.map((evaluation) => {
          const pnlBps = typeof evaluation.pnlBps === 'number' ? evaluation.pnlBps : null;
          const drawdownBps = typeof evaluation.trailingDrawdownBps === 'number' ? evaluation.trailingDrawdownBps : null;
          const tokenClass = evaluation.tokenClass as TokenTradeClass;
          const action = marketRegime !== 'chop'
            ? 'grid_disabled' as const
            : pnlBps !== null && pnlBps >= 60
              ? 'grid_sell_zone' as const
              : drawdownBps !== null && drawdownBps <= -60
                ? 'grid_buy_zone' as const
                : 'grid_hold' as const;
          return {
            mint: String(evaluation.mint),
            symbol: String(evaluation.symbol ?? 'UNKNOWN'),
            tokenClass,
            action,
            pnlBps,
            drawdownBps,
            reason: action === 'grid_disabled'
              ? 'not_chop_regime'
              : action === 'grid_sell_zone'
                ? 'range_upper_profit_zone'
                : action === 'grid_buy_zone'
                  ? 'range_lower_pullback_zone'
                  : 'inside_grid_neutral_zone',
          };
        })
      : [],`,
  `    candidates: enabled
      ? params.evaluations.map((evaluation) => {
          const pnlBps = typeof evaluation.pnlBps === 'number' ? evaluation.pnlBps : null;
          const drawdownBps = typeof evaluation.trailingDrawdownBps === 'number' ? evaluation.trailingDrawdownBps : null;
          const tokenClass = evaluation.tokenClass as TokenTradeClass;
          const band = computeVirtualGridBand(String(evaluation.mint), marketRegime === 'chop');
          return {
            mint: String(evaluation.mint),
            symbol: String(evaluation.symbol ?? 'UNKNOWN'),
            tokenClass,
            action: band.action,
            pnlBps,
            drawdownBps,
            reason: band.reason,
            rangeWidthBps: band.rangeWidthBps,
            pricePositionPct: band.pricePositionPct,
            recentMoveBps: band.recentMoveBps,
            sampleCount: band.sampleCount,
            rangeLow: band.rangeLow,
            rangeHigh: band.rangeHigh,
          };
        })
      : [],`,
);

fs.writeFileSync(file, src, 'utf8');
console.log('done');
