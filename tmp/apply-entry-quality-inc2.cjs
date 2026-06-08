'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let content = fs.readFileSync(file, 'utf8');

// Each edit is literal: we use split(old).join(new) so $ and backticks are never
// interpreted. We assert each old string appears exactly once before replacing.
const edits = [];

// EDIT 1 — import classifyTapeRegime
edits.push({
  name: 'import classifyTapeRegime',
  old: [
    '  computeEntryQualityScore,',
    '  resolveTradeGateAssessment,',
  ].join('\n'),
  new: [
    '  computeEntryQualityScore,',
    '  classifyTapeRegime,',
    '  resolveTradeGateAssessment,',
  ].join('\n'),
});

// EDIT 2 — module maps for cached price impact + pending entry quality
edits.push({
  name: 'add ByMint maps',
  old: [
    'const latestJupiterDecimalsByMint = new Map<string, number>();',
    '',
    'const TOKEN_UNIVERSE_REFRESH_MS',
  ].join('\n'),
  new: [
    'const latestJupiterDecimalsByMint = new Map<string, number>();',
    'const latestPriceImpactBpsByMint = new Map<string, number>();',
    'const pendingEntryQualityByMint = new Map<string, { score: number; band: string }>();',
    '',
    'const TOKEN_UNIVERSE_REFRESH_MS',
  ].join('\n'),
});

// EDIT 3 — trend-efficiency threshold env constant
edits.push({
  name: 'add trend efficiency env',
  old: 'const WORKER_ENTRY_QUALITY_ENTER_THRESHOLD = Number(process.env.WORKER_ENTRY_QUALITY_ENTER_THRESHOLD ?? 55);',
  new: [
    'const WORKER_ENTRY_QUALITY_ENTER_THRESHOLD = Number(process.env.WORKER_ENTRY_QUALITY_ENTER_THRESHOLD ?? 55);',
    'const WORKER_ENTRY_QUALITY_TREND_EFFICIENCY_THRESHOLD = Number(process.env.WORKER_ENTRY_QUALITY_TREND_EFFICIENCY_THRESHOLD ?? 0.6);',
  ].join('\n'),
});

// EDIT 4 — cache real price impact per mint during auto-sort probe
edits.push({
  name: 'cache price impact',
  old: [
    '    const priceImpactBps = parseQuotePriceImpactBps(routeCheck.data?.build?.priceImpactPct ?? null);',
    '    const usdPrice = latestJupiterUsdByMint.get(mint) ?? null;',
  ].join('\n'),
  new: [
    '    const priceImpactBps = parseQuotePriceImpactBps(routeCheck.data?.build?.priceImpactPct ?? null);',
    '    if (priceImpactBps !== null) {',
    '      latestPriceImpactBpsByMint.set(mint, priceImpactBps);',
    '    }',
    '    const usdPrice = latestJupiterUsdByMint.get(mint) ?? null;',
  ].join('\n'),
});

// EDIT 5 — shadow scorer: feed real regime + cached price impact, stash result
edits.push({
  name: 'shadow regime + impact + stash',
  old: [
    '      const entryQuality = computeEntryQualityScore({',
    '        prices: getMomentumTapeForMint(selectedEntryMint).map((sample) => sample.usdPrice),',
    '        minSamples: WORKER_ENTRY_QUALITY_MIN_SAMPLES,',
    '        chaseLookbackSamples: WORKER_ENTRY_QUALITY_CHASE_LOOKBACK_SAMPLES,',
    '        regime: null,',
    '        priceImpactBps: null,',
    '        idealPullbackBps: WORKER_ENTRY_QUALITY_IDEAL_PULLBACK_BPS,',
    '        maxHealthyPullbackBps: WORKER_ENTRY_QUALITY_MAX_HEALTHY_PULLBACK_BPS,',
    '        maxHealthyPriceImpactBps: WORKER_ENTRY_QUALITY_MAX_HEALTHY_IMPACT_BPS,',
    '        strongScore: WORKER_ENTRY_QUALITY_STRONG_SCORE,',
    '        fairScore: WORKER_ENTRY_QUALITY_FAIR_SCORE,',
    '        enterThreshold: WORKER_ENTRY_QUALITY_ENTER_THRESHOLD,',
    '      });',
  ].join('\n'),
  new: [
    '      const entryQuality = computeEntryQualityScore({',
    '        prices: getMomentumTapeForMint(selectedEntryMint).map((sample) => sample.usdPrice),',
    '        minSamples: WORKER_ENTRY_QUALITY_MIN_SAMPLES,',
    '        chaseLookbackSamples: WORKER_ENTRY_QUALITY_CHASE_LOOKBACK_SAMPLES,',
    '        regime: classifyTapeRegime({',
    '          prices: getMomentumTapeForMint(selectedEntryMint).map((sample) => sample.usdPrice),',
    '          minSamples: WORKER_ENTRY_QUALITY_MIN_SAMPLES,',
    '          trendEfficiencyThreshold: WORKER_ENTRY_QUALITY_TREND_EFFICIENCY_THRESHOLD,',
    '        }),',
    '        priceImpactBps: latestPriceImpactBpsByMint.get(selectedEntryMint) ?? null,',
    '        idealPullbackBps: WORKER_ENTRY_QUALITY_IDEAL_PULLBACK_BPS,',
    '        maxHealthyPullbackBps: WORKER_ENTRY_QUALITY_MAX_HEALTHY_PULLBACK_BPS,',
    '        maxHealthyPriceImpactBps: WORKER_ENTRY_QUALITY_MAX_HEALTHY_IMPACT_BPS,',
    '        strongScore: WORKER_ENTRY_QUALITY_STRONG_SCORE,',
    '        fairScore: WORKER_ENTRY_QUALITY_FAIR_SCORE,',
    '        enterThreshold: WORKER_ENTRY_QUALITY_ENTER_THRESHOLD,',
    '      });',
    '      pendingEntryQualityByMint.set(`${session.id}:${selectedEntryMint}`, { score: entryQuality.score, band: entryQuality.band });',
  ].join('\n'),
});

// EDIT 6a — exit-eval: resolve + attach entry quality onto the position
edits.push({
  name: 'exit-eval resolve + attach',
  old: [
    '      const exitTrigger = evaluateExitTrigger(session, position, signalForPosition);',
    '      exitEvaluations.push({',
  ].join('\n'),
  new: [
    '      const exitTrigger = evaluateExitTrigger(session, position, signalForPosition);',
    '      const stashedEntryQuality = pendingEntryQualityByMint.get(`${session.id}:${mint}`) ?? null;',
    '      const resolvedEntryQualityScore = position.entryQualityScore ?? stashedEntryQuality?.score ?? null;',
    '      const resolvedEntryQualityBand = position.entryQualityBand ?? stashedEntryQuality?.band ?? null;',
    '      if (position.entryQualityScore === null && resolvedEntryQualityScore !== null) {',
    '        nextPositions[mint] = {',
    '          ...(nextPositions[mint] ?? position),',
    '          entryQualityScore: resolvedEntryQualityScore,',
    "          entryQualityBand: resolvedEntryQualityBand as SessionPositionState['entryQualityBand'],",
    '        };',
    '        positionsChanged = true;',
    '      }',
    '      exitEvaluations.push({',
  ].join('\n'),
});

// EDIT 6b — exit-eval: include entry quality in the evaluation row
edits.push({
  name: 'exit-eval row fields',
  old: [
    '        trailingDrawdownBps: exitTrigger.trailingDrawdownBps,',
    '        maxFavorableBps: position.maxFavorableBps ?? null,',
    '        maxAdverseBps: position.maxAdverseBps ?? null,',
    '        entryPriceUsd: position.entryPriceUsd,',
  ].join('\n'),
  new: [
    '        trailingDrawdownBps: exitTrigger.trailingDrawdownBps,',
    '        maxFavorableBps: position.maxFavorableBps ?? null,',
    '        maxAdverseBps: position.maxAdverseBps ?? null,',
    '        entryQualityScore: resolvedEntryQualityScore,',
    '        entryQualityBand: resolvedEntryQualityBand,',
    '        entryPriceUsd: position.entryPriceUsd,',
  ].join('\n'),
});

// EDIT 6c — preserve attached entry quality through the pendingExitReason reset
edits.push({
  name: 'preserve attach on pendingExitReason reset',
  old: [
    '        if (position.pendingExitReason !== null) {',
    '          nextPositions[mint] = {',
    '            ...position,',
    '            pendingExitReason: null,',
    '          };',
    '          positionsChanged = true;',
    '        }',
  ].join('\n'),
  new: [
    '        if (position.pendingExitReason !== null) {',
    '          nextPositions[mint] = {',
    '            ...(nextPositions[mint] ?? position),',
    '            pendingExitReason: null,',
    '          };',
    '          positionsChanged = true;',
    '        }',
  ].join('\n'),
});

// EDIT 7 — exit_shadow_decisions: new columns in the idempotent ALTER
edits.push({
  name: 'exit_shadow ALTER columns',
  old: [
    '          ADD COLUMN IF NOT EXISTS grid_recent_move_bps INTEGER',
    '      `))',
  ].join('\n'),
  new: [
    '          ADD COLUMN IF NOT EXISTS grid_recent_move_bps INTEGER,',
    '          ADD COLUMN IF NOT EXISTS entry_quality_score INTEGER,',
    '          ADD COLUMN IF NOT EXISTS entry_quality_band TEXT',
    '      `))',
  ].join('\n'),
});

// EDIT 8a — exit_shadow row values
edits.push({
  name: 'exit_shadow row values',
  old: [
    '      intOrNull(grid?.rangeWidthBps),',
    '      intOrNull(grid?.pricePositionPct),',
    '      intOrNull(grid?.recentMoveBps),',
    '    ]);',
  ].join('\n'),
  new: [
    '      intOrNull(grid?.rangeWidthBps),',
    '      intOrNull(grid?.pricePositionPct),',
    '      intOrNull(grid?.recentMoveBps),',
    '      intOrNull(evaluation.entryQualityScore),',
    '      evaluation.entryQualityBand ? String(evaluation.entryQualityBand) : null,',
    '    ]);',
  ].join('\n'),
});

// EDIT 8b — column count 30 -> 32
edits.push({
  name: 'cols 30 -> 32',
  old: '    const cols = 30;',
  new: '    const cols = 32;',
});

// EDIT 8c — column casts
edits.push({
  name: 'column casts',
  old: [
    "      '::int', '::int', '::int',",
    '    ];',
  ].join('\n'),
  new: [
    "      '::int', '::int', '::int',",
    "      '::int', '::text',",
    '    ];',
  ].join('\n'),
});

// EDIT 8d — INSERT column list
edits.push({
  name: 'INSERT column list',
  old: [
    '          grid_range_width_bps, grid_price_position_pct, grid_recent_move_bps',
    '        ) VALUES ${valuesSql}',
  ].join('\n'),
  new: [
    '          grid_range_width_bps, grid_price_position_pct, grid_recent_move_bps,',
    '          entry_quality_score, entry_quality_band',
    '        ) VALUES ${valuesSql}',
  ].join('\n'),
});

let failures = 0;
for (const edit of edits) {
  const count = content.split(edit.old).length - 1;
  if (count !== 1) {
    console.error(`FAIL [${edit.name}]: expected 1 occurrence, found ${count}`);
    failures += 1;
    continue;
  }
  content = content.split(edit.old).join(edit.new);
  console.log(`OK   [${edit.name}]`);
}

if (failures > 0) {
  console.error(`\n${failures} edit(s) failed — NOT writing file.`);
  process.exit(1);
}

fs.writeFileSync(file, content, 'utf8');
console.log('\nAll edits applied. Wrote ' + file);
