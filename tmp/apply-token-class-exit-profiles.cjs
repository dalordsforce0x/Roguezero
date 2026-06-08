/*
 * Phase 4: token-class exit profiles. The exit thresholds currently use ONE global set of ATR
 * multipliers (TP 1.8x, SL 1.0x, trail 0.8x) for every token. Shadow data showed long_tail
 * RUNNERS are where the money is (let them run) while core trend_liquid/sol_beta chop-bleed
 * (don't give them a wide leash). This makes the ATR multipliers class-aware so a runner gets a
 * wider take-profit (TP scales with its real ATR) while majors/betas bank quicker. Floors
 * (cost floor) and the no-TP-below-breakeven rule are UNCHANGED -> stops are never disabled.
 * Flag-gated + Noah-scoped, default OFF => identical to current behavior until flipped.
 * Disk-edit; split/join only.
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

// 1) Flag const, placed next to the partial-TP flag.
apply(
  'flag',
  `const WORKER_PARTIAL_TP_MAX_FRACTION_BPS = Number(process.env.WORKER_PARTIAL_TP_MAX_FRACTION_BPS ?? 6000);`,
  `const WORKER_PARTIAL_TP_MAX_FRACTION_BPS = Number(process.env.WORKER_PARTIAL_TP_MAX_FRACTION_BPS ?? 6000);
// Phase 4 (Noah-only, default OFF): when enabled + canary-scoped, exit ATR multipliers become
// token-class aware (runners get a wider take-profit leash; majors/betas bank quicker). Floors
// and the no-TP-below-breakeven rule are unchanged, so stops are never disabled.
const WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED = process.env.WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED === 'true';`,
);

// 2) Per-class profile lookup, placed right after getTokenTradeClass.
apply(
  'profile-fn',
  `  if (TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(mint)) {
    return 'trend_liquid';
  }
  return 'long_tail';
};`,
  `  if (TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(mint)) {
    return 'trend_liquid';
  }
  return 'long_tail';
};

type TokenClassExitProfile = { takeProfitMult: number; stopLossMult: number; trailingStopMult: number };

// Per-class ATR exit multipliers. Baseline global was TP 1.8 / SL 1.0 / trail 0.8.
// long_tail = runners -> wide TP leash so a real move runs; slightly wider SL to ride noise; trailing locks.
// major / sol_beta / trend_liquid -> tighter TP so chop-prone names bank quicker. All floored downstream.
const getTokenClassExitProfile = (tokenClass: TokenTradeClass): TokenClassExitProfile => {
  switch (tokenClass) {
    case 'major':
      return { takeProfitMult: 1.4, stopLossMult: 1.0, trailingStopMult: 0.7 };
    case 'sol_beta':
      return { takeProfitMult: 1.6, stopLossMult: 1.0, trailingStopMult: 0.8 };
    case 'trend_liquid':
      return { takeProfitMult: 1.7, stopLossMult: 1.0, trailingStopMult: 0.8 };
    case 'long_tail':
    default:
      return { takeProfitMult: 2.6, stopLossMult: 1.2, trailingStopMult: 1.0 };
  }
};`,
);

// 3) Resolve effective multipliers once near the top of computeDynamicExitThresholds.
apply(
  'resolve',
  `  const costFloorBps = computeExitCostFloorBps(session);
  const atrBps = positionState.lastComputedAtrBps ?? null;`,
  `  const costFloorBps = computeExitCostFloorBps(session);
  const atrBps = positionState.lastComputedAtrBps ?? null;
  // Token-class exit profile (flag-gated, Noah-scoped). OFF => exact global multipliers as before.
  const exitProfilesActive = isCanaryShadowEnabled(session, WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED);
  const exitProfile: TokenClassExitProfile = exitProfilesActive
    ? getTokenClassExitProfile(getTokenTradeClass(positionState.positionMint ?? '', positionState.positionSymbol))
    : {
        takeProfitMult: positionExitPolicy.atrTakeProfitMultiplier,
        stopLossMult: positionExitPolicy.atrStopLossMultiplier,
        trailingStopMult: positionExitPolicy.atrTrailingStopMultiplier,
      };`,
);

// 4) Use the resolved multipliers in the ATR branch.
apply(
  'apply-mults',
  `    takeProfitBps: applyTakeProfitTimeDecay(Math.max(
      costFloorBps,
      Math.round(atrBps * positionExitPolicy.atrTakeProfitMultiplier * (1 + signalStrengthBoost)),
    )),
    stopLossBps: Math.max(
      costFloorBps,
      Math.round(atrBps * positionExitPolicy.atrStopLossMultiplier),
    ),
    trailingStopBps: Math.max(
      costFloorBps,
      Math.round(atrBps * positionExitPolicy.atrTrailingStopMultiplier),
    ),`,
  `    takeProfitBps: applyTakeProfitTimeDecay(Math.max(
      costFloorBps,
      Math.round(atrBps * exitProfile.takeProfitMult * (1 + signalStrengthBoost)),
    )),
    stopLossBps: Math.max(
      costFloorBps,
      Math.round(atrBps * exitProfile.stopLossMult),
    ),
    trailingStopBps: Math.max(
      costFloorBps,
      Math.round(atrBps * exitProfile.trailingStopMult),
    ),`,
);

fs.writeFileSync(file, src, 'utf8');
console.log('done');
