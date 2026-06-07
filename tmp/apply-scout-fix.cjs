const fs = require('fs');
const path = 'services/worker/src/index.ts';
let s = fs.readFileSync(path, 'utf8');
if (!s.includes('getUniverseScoutPreEntryBlockReason')) {
  const helper = `
const getUniverseScoutPreEntryBlockReason = (sample: UniverseScoutSample): string | null => {
  if (
    sample.priceImpactBps !== null
    && sample.priceImpactBps > WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS
  ) {
    return 'universe_scout_entry_impact_too_high';
  }

  const appliesTrendingShapeGate = WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED
    && sample.mint !== SOL_MINT
    && !TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(sample.mint);
  if (appliesTrendingShapeGate) {
    const shapeGate = computeTrendingEntryShapeGate({
      enabled: true,
      prices: getMomentumTapeForMint(sample.mint).map((tapeSample) => tapeSample.usdPrice),
      minSamples: WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES,
      chaseLookbackSamples: WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES,
      maxRecentSurgeBps: WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS,
      minPullbackFromHighBps: WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS,
      minReclaimFromLowBps: WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS,
      maxRangePositionBps: WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS,
      maxNegativeWindowMomentumBps: WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS,
    });

    if (!shapeGate.allowed) {
      return shapeGate.reason;
    }
  }

  return null;
};
`;
  s = s.replace(/(\nconst scoutEntryUniverse = async \(params: \{)/, `${helper}$1`);
}
s = s.replace(/  const ranked = samples\r?\n    \.filter\(\(sample\) => sample\.routeFound\)\r?\n    \.sort\(\(a, b\) => b\.score - a\.score\);\r?\n\r?\n  const bestBullishSample = ranked\.find\(\(sample\) => sample\.persistentBullish\)\r?\n    \?\? \(WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH\r?\n      \? null\r?\n      : ranked\.find\(\(sample\) => sample\.signalStatus === 'ready' && sample\.regime === 'bullish'\)\)\r?\n    \?\? null;\r?\n  const bestRoutedFallbackSample = WORKER_UNIVERSE_SCOUT_ALLOW_ROUTED_FALLBACK\r?\n    \? \(ranked\[0\] \?\? null\)\r?\n    : null;\r?\n  const bestSample = bestBullishSample \?\? bestRoutedFallbackSample;\r?\n\r?\n  return \{\r?\n    candidates,\r?\n    ranked,\r?\n    bestMint: bestSample\?\.mint \?\? null,/, `  const ranked = samples
    .filter((sample) => sample.routeFound)
    .sort((a, b) => b.score - a.score);
  const selectableRanked = ranked.filter((sample) => getUniverseScoutPreEntryBlockReason(sample) === null);

  const bestBullishSample = selectableRanked.find((sample) => sample.persistentBullish)
    ?? (WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH
      ? null
      : selectableRanked.find((sample) => sample.signalStatus === 'ready' && sample.regime === 'bullish'))
    ?? null;
  const bestRoutedFallbackSample = WORKER_UNIVERSE_SCOUT_ALLOW_ROUTED_FALLBACK
    ? (selectableRanked[0] ?? null)
    : null;
  const bestSample = bestBullishSample ?? bestRoutedFallbackSample;

  return {
    candidates,
    ranked,
    selectableRanked,
    bestMint: bestSample?.mint ?? null,`);
s = s.replace(/        const scoutBlockedReason = scoutSnapshot\.routeFoundCount > 0\r?\n          \? 'universe_scout_no_bullish_candidate'\r?\n          : 'universe_scout_no_route';/, `        const scoutBlockedReason = scoutSnapshot.routeFoundCount > 0
          ? (scout.selectableRanked.length > 0
            ? 'universe_scout_no_bullish_candidate'
            : 'universe_scout_no_preentry_eligible_candidate')
          : 'universe_scout_no_route';`);
s = s.replace(/          scoutBlockedReason === 'universe_scout_no_bullish_candidate'\r?\n            \? `universe scout blocked entry: no bullish candidate \(routes=\$\{scoutSnapshot\.routeFoundCount\}\/\$\{scoutSnapshot\.candidateCount\}, bullish=\$\{scoutSnapshot\.bullishRouteCount\}\)`\r?\n            : `universe scout blocked entry: no route \(candidates=\$\{scout\.candidates\.length\}\)`,/, `          scoutBlockedReason === 'universe_scout_no_bullish_candidate'
            ? \`universe scout blocked entry: no bullish candidate (routes=\${scoutSnapshot.routeFoundCount}/\${scoutSnapshot.candidateCount}, bullish=\${scoutSnapshot.bullishRouteCount})\`
            : scoutBlockedReason === 'universe_scout_no_preentry_eligible_candidate'
              ? \`universe scout blocked entry: no pre-entry eligible candidate (routes=\${scoutSnapshot.routeFoundCount}/\${scoutSnapshot.candidateCount}, bullish=\${scoutSnapshot.bullishRouteCount})\`
              : \`universe scout blocked entry: no route (candidates=\${scout.candidates.length})\`,`);
fs.writeFileSync(path, s);
