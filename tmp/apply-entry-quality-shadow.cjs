/**
 * Entry-quality score SHADOW wiring (Noah-only, no gating).
 *  1) import computeEntryQualityScore from tradeExecutionPolicy
 *  2) env consts for the score config (shadow defaults on)
 *  3) at the REAL entry path, compute + log the score for the about-to-be-taken
 *     entry, scoped to the canary (Noah) via isCanaryShadowEnabled. Pure
 *     measurement so we can correlate score -> realized MAE before gating live.
 */
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

// 1) Import the scorer alongside the shape gate.
apply(
  'import',
  `  computeTrendingEntryShapeGate,
  resolveTradeGateAssessment,`,
  `  computeTrendingEntryShapeGate,
  computeEntryQualityScore,
  resolveTradeGateAssessment,`,
);

// 2) Env config for the entry-quality score (shadow on by default; Noah-scoped).
apply(
  'env-consts',
  `const WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS ?? 250);`,
  `const WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS ?? 250);
// Entry-quality score (shadow-first): records a 0..100 timing score for every
// entry the canary is about to take so we can correlate score vs realized MAE
// (the -70 bps adverse-excursion problem) before letting it gate a live entry.
const WORKER_ENTRY_QUALITY_SHADOW_ENABLED = process.env.WORKER_ENTRY_QUALITY_SHADOW_ENABLED !== 'false';
const WORKER_ENTRY_QUALITY_MIN_SAMPLES = Number(process.env.WORKER_ENTRY_QUALITY_MIN_SAMPLES ?? 8);
const WORKER_ENTRY_QUALITY_CHASE_LOOKBACK_SAMPLES = Number(process.env.WORKER_ENTRY_QUALITY_CHASE_LOOKBACK_SAMPLES ?? 3);
const WORKER_ENTRY_QUALITY_IDEAL_PULLBACK_BPS = Number(process.env.WORKER_ENTRY_QUALITY_IDEAL_PULLBACK_BPS ?? 40);
const WORKER_ENTRY_QUALITY_MAX_HEALTHY_PULLBACK_BPS = Number(process.env.WORKER_ENTRY_QUALITY_MAX_HEALTHY_PULLBACK_BPS ?? 150);
const WORKER_ENTRY_QUALITY_MAX_HEALTHY_IMPACT_BPS = Number(process.env.WORKER_ENTRY_QUALITY_MAX_HEALTHY_IMPACT_BPS ?? 200);
const WORKER_ENTRY_QUALITY_STRONG_SCORE = Number(process.env.WORKER_ENTRY_QUALITY_STRONG_SCORE ?? 70);
const WORKER_ENTRY_QUALITY_FAIR_SCORE = Number(process.env.WORKER_ENTRY_QUALITY_FAIR_SCORE ?? 50);
const WORKER_ENTRY_QUALITY_ENTER_THRESHOLD = Number(process.env.WORKER_ENTRY_QUALITY_ENTER_THRESHOLD ?? 55);`,
);

// 3) Compute + log the score at the real entry path (just before the shape gate),
//    Noah-only, no gating. Anchored on the unique "momentum not persistent" block.
apply(
  'entry-shadow',
  `        \`entry blocked: \${resolveTokenSymbol(selectedEntryMint)} momentum not persistent (\${MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES} samples required)\`,
      );
      return;
    }

    const appliesTrendingShapeGate = WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED
      && selectedEntryMint !== SOL_MINT
      && !TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(selectedEntryMint);`,
  `        \`entry blocked: \${resolveTokenSymbol(selectedEntryMint)} momentum not persistent (\${MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES} samples required)\`,
      );
      return;
    }

    // Entry-quality score (SHADOW, canary-only, no gating). Scores the entry the
    // worker is about to take so we can later join score -> realized MAE and prove
    // whether a live entry-quality gate would cut the systematic adverse excursion.
    if (WORKER_ENTRY_QUALITY_SHADOW_ENABLED && isCanaryShadowEnabled(session, true)) {
      const entryQuality = computeEntryQualityScore({
        prices: getMomentumTapeForMint(selectedEntryMint).map((sample) => sample.usdPrice),
        minSamples: WORKER_ENTRY_QUALITY_MIN_SAMPLES,
        chaseLookbackSamples: WORKER_ENTRY_QUALITY_CHASE_LOOKBACK_SAMPLES,
        regime: null,
        priceImpactBps: null,
        idealPullbackBps: WORKER_ENTRY_QUALITY_IDEAL_PULLBACK_BPS,
        maxHealthyPullbackBps: WORKER_ENTRY_QUALITY_MAX_HEALTHY_PULLBACK_BPS,
        maxHealthyPriceImpactBps: WORKER_ENTRY_QUALITY_MAX_HEALTHY_IMPACT_BPS,
        strongScore: WORKER_ENTRY_QUALITY_STRONG_SCORE,
        fairScore: WORKER_ENTRY_QUALITY_FAIR_SCORE,
        enterThreshold: WORKER_ENTRY_QUALITY_ENTER_THRESHOLD,
      });
      const eqSymbol = resolveTokenSymbol(selectedEntryMint);
      const eqClass = getTokenTradeClass(selectedEntryMint, eqSymbol);
      const eqC = entryQuality.components;
      log(
        'info',
        session.id,
        \`entry-quality shadow: \${eqSymbol} (\${selectedEntryMint}) class=\${eqClass} score=\${entryQuality.score} band=\${entryQuality.band} wouldEnter=\${entryQuality.wouldEnter} pull=\${eqC.pullback.toFixed(2)} reclaim=\${eqC.reclaim.toFixed(2)} rangePos=\${eqC.rangePosition.toFixed(2)} surge=\${eqC.surgeRestraint.toFixed(2)} liq=\${eqC.liquidity.toFixed(2)} pbHighBps=\${entryQuality.metrics?.pullbackFromHighBps ?? 'na'} reclaimLowBps=\${entryQuality.metrics?.reclaimFromLowBps ?? 'na'} rangeBps=\${entryQuality.metrics?.rangePositionBps ?? 'na'}\`,
      );
    }

    const appliesTrendingShapeGate = WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED
      && selectedEntryMint !== SOL_MINT
      && !TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(selectedEntryMint);`,
);

fs.writeFileSync(path, src, 'utf8');
console.log('DONE');
