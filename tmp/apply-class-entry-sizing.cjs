// Class-weighted entry sizing (Phase: structural earner fix), shadow-first, Noah-scoped.
// Reallocates capital away from trend_liquid (can't clear ~50bps break-even, 62% of effort)
// toward classes that do. SIZING not a gate: never blocks an entry, only scales notional.
// Flag default OFF => shadow-log only until flipped on Noah.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');

const apply = (label, oldStr, newStr) => {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  console.log(`[${label}] applied`);
};

// ── Edit 1: env consts (after the Phase-4 exit-profiles flag) ───────────────────
apply(
  'env-consts',
  `const WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED = process.env.WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED === 'true';
const WORKER_EXIT_SHADOW_HISTORY_ENABLED = process.env.WORKER_EXIT_SHADOW_HISTORY_ENABLED !== 'false';`,
  `const WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED = process.env.WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED === 'true';
// Class-weighted entry sizing (Noah-only, default OFF): reallocate capital away from the
// token class that structurally cannot clear the ~50bps round-trip break-even (trend_liquid,
// median peak ~21bps, 62% of position-time) toward the classes that do (sol_beta/long_tail/
// major). This is SIZING, not a gate: it never blocks an entry, only scales its notional.
// Multipliers are bps of the base entry size (10000 = 1.0x). With the flag OFF the sizing is
// computed for shadow telemetry only and never applied.
const WORKER_CLASS_ENTRY_SIZING_ENABLED = process.env.WORKER_CLASS_ENTRY_SIZING_ENABLED === 'true';
const WORKER_CLASS_SIZE_MAJOR_BPS = Number(process.env.WORKER_CLASS_SIZE_MAJOR_BPS ?? 10000);
const WORKER_CLASS_SIZE_SOL_BETA_BPS = Number(process.env.WORKER_CLASS_SIZE_SOL_BETA_BPS ?? 10000);
const WORKER_CLASS_SIZE_TREND_LIQUID_BPS = Number(process.env.WORKER_CLASS_SIZE_TREND_LIQUID_BPS ?? 5000);
const WORKER_CLASS_SIZE_LONG_TAIL_BPS = Number(process.env.WORKER_CLASS_SIZE_LONG_TAIL_BPS ?? 10000);
const WORKER_EXIT_SHADOW_HISTORY_ENABLED = process.env.WORKER_EXIT_SHADOW_HISTORY_ENABLED !== 'false';`,
);

// ── Edit 2: helper functions (after getTokenClassExitProfile, before isCanaryShadowEnabled) ──
apply(
  'helpers',
  `    case 'long_tail':
    default:
      return { takeProfitMult: 2.6, stopLossMult: 1.2, trailingStopMult: 1.0 };
  }
};

const isCanaryShadowEnabled = (session: RawSession, enabled: boolean): boolean => {`,
  `    case 'long_tail':
    default:
      return { takeProfitMult: 2.6, stopLossMult: 1.2, trailingStopMult: 1.0 };
  }
};

const getTokenClassSizeMultiplierBps = (tokenClass: TokenTradeClass): number => {
  switch (tokenClass) {
    case 'major':
      return WORKER_CLASS_SIZE_MAJOR_BPS;
    case 'sol_beta':
      return WORKER_CLASS_SIZE_SOL_BETA_BPS;
    case 'trend_liquid':
      return WORKER_CLASS_SIZE_TREND_LIQUID_BPS;
    case 'long_tail':
    default:
      return WORKER_CLASS_SIZE_LONG_TAIL_BPS;
  }
};

// Computes the class-weighted entry size for a candidate token. Always runs (so the shadow
// line records what it WOULD do); the caller only applies the result when the flag is enabled
// and canary-scoped. Never blocks: if the down-sized amount would fall below the min trade,
// the base amount is left unchanged (we shrink effort on a weak class, we do not gate it out).
const computeClassEntrySizing = (params: {
  mint: string;
  symbol?: string | null;
  inventory: TradeInventoryContext;
}): {
  tokenClass: TokenTradeClass;
  multiplierBps: number;
  baseAmountAtomic: number;
  adjustedAmountAtomic: number;
  belowMinTrade: boolean;
} => {
  const tokenClass = getTokenTradeClass(params.mint, params.symbol);
  const multiplierBps = getTokenClassSizeMultiplierBps(tokenClass);
  const baseAmountAtomic = params.inventory.amountAtomic ?? 0;
  const adjustedAmountAtomic = Math.floor((baseAmountAtomic * multiplierBps) / 10_000);
  const belowMinTrade = adjustedAmountAtomic < params.inventory.minTradeAtomic;
  return { tokenClass, multiplierBps, baseAmountAtomic, adjustedAmountAtomic, belowMinTrade };
};

const isCanaryShadowEnabled = (session: RawSession, enabled: boolean): boolean => {`,
);

// ── Edit 3: call site (after volatility sizing, before route stability) ─────────
apply(
  'call-site',
  `    const routeStability = await assessEntryRouteStability({
      inputMint: entryInventory.inputMint,
      outputMint: entryInventory.outputMint,
      amountAtomic: entryInventory.amountAtomic ?? 0,`,
  `    const classSizing = computeClassEntrySizing({
      mint: selectedEntryMint,
      symbol: entryInventory.outputSymbol,
      inventory: entryInventory,
    });
    const classSizingActive = isCanaryShadowEnabled(session, WORKER_CLASS_ENTRY_SIZING_ENABLED);
    if (classSizing.multiplierBps !== 10_000) {
      log(
        'info',
        session.id,
        \`class-sizing \${classSizingActive ? 'apply' : 'shadow'}: \${entryInventory.outputSymbol} class=\${classSizing.tokenClass} mult=\${(classSizing.multiplierBps / 10_000).toFixed(2)}x base=\${classSizing.baseAmountAtomic} would=\${classSizing.adjustedAmountAtomic}\${classSizing.belowMinTrade ? ' (below_min_trade=kept_base)' : ''}\`,
      );
    }
    if (
      classSizingActive
      && classSizing.multiplierBps !== 10_000
      && !classSizing.belowMinTrade
      && classSizing.adjustedAmountAtomic > 0
      && classSizing.adjustedAmountAtomic < (entryInventory.amountAtomic ?? 0)
    ) {
      const preClassAmount = entryInventory.amountAtomic ?? 0;
      entryInventory.amountAtomic = classSizing.adjustedAmountAtomic;
      entryInventory.riskAdjustedAmountAtomic = classSizing.adjustedAmountAtomic;
      log(
        'info',
        session.id,
        \`entry size adjusted by class: \${entryInventory.outputSymbol} class=\${classSizing.tokenClass} amount \${preClassAmount} -> \${classSizing.adjustedAmountAtomic} mult=\${(classSizing.multiplierBps / 10_000).toFixed(2)}x\`,
      );
    }

    const routeStability = await assessEntryRouteStability({
      inputMint: entryInventory.inputMint,
      outputMint: entryInventory.outputMint,
      amountAtomic: entryInventory.amountAtomic ?? 0,`,
);

fs.writeFileSync(file, src, 'utf8');
console.log('DONE: class-weighted entry sizing (shadow-first, Noah-scoped, flag default OFF)');
