// Disk-edit: add HONEST break-even telemetry to exit-shadow history (Phase 3 move 1, shadow-only).
// Records, per snapshot:
//   honest_floor_bps     = expected REAL sell-side friction = expectedSlippageBps + session platformFeeBps
//                          (NOT the synthetic 50-cap + 35-buffer that inflated the live exit floor)
//   net_after_partial_bps = pnlBps - honest_floor_bps = what a partial-TP RIGHT NOW would actually net
// Pure observation: no trigger change, no execution change. Lets us SEE the corrected break-even
// in live data before designing real partial-TP execution.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');

function replaceOnce(oldStr, newStr, label) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) throw new Error(`anchor "${label}" matched ${count} times (expected 1)`);
  src = src.split(oldStr).join(newStr); // split/join avoids String.replace $$ collapse
}

// --- 1) env const: expected real slippage (default 15 bps, from observed fills ~1-17 bps) ---
replaceOnce(
  `const WORKER_GRID_CHOP_SHADOW_ENABLED = process.env.WORKER_GRID_CHOP_SHADOW_ENABLED === 'true';`,
  `const WORKER_GRID_CHOP_SHADOW_ENABLED = process.env.WORKER_GRID_CHOP_SHADOW_ENABLED === 'true';
// Expected REAL exit-leg slippage in bps (observed confirmed fills ran ~1-17 bps). Used only by the
// honest break-even telemetry below, NOT by the live exit cost-floor. The live floor still uses the
// conservative maxSlippage cap; this measures what a partial-TP would net against ACTUAL friction.
const WORKER_EXIT_EXPECTED_SLIPPAGE_BPS = Number(process.env.WORKER_EXIT_EXPECTED_SLIPPAGE_BPS ?? 15);`,
  'env const',
);

// --- 2) CREATE TABLE: add 2 columns for fresh installs ---
replaceOnce(
  `        trailing_drawdown_bps INTEGER,
        thresholds JSONB,
        evaluation JSONB,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),`,
  `        trailing_drawdown_bps INTEGER,
        honest_floor_bps INTEGER,
        net_after_partial_bps INTEGER,
        thresholds JSONB,
        evaluation JSONB,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),`,
  'CREATE TABLE cols',
);

// --- 3) ensure columns exist on the already-created prod table (ALTER ADD COLUMN IF NOT EXISTS) ---
replaceOnce(
  `      .then(() => dbPool.query(\`
        CREATE INDEX IF NOT EXISTS exit_shadow_decisions_session_time_idx
        ON exit_shadow_decisions (session_id, decided_at DESC)
      \`))`,
  `      .then(() => dbPool.query(\`
        ALTER TABLE exit_shadow_decisions
          ADD COLUMN IF NOT EXISTS honest_floor_bps INTEGER,
          ADD COLUMN IF NOT EXISTS net_after_partial_bps INTEGER
      \`))
      .then(() => dbPool.query(\`
        CREATE INDEX IF NOT EXISTS exit_shadow_decisions_session_time_idx
        ON exit_shadow_decisions (session_id, decided_at DESC)
      \`))`,
  'ALTER add columns',
);

// --- 4) compute honest floor once per append ---
replaceOnce(
  `  const now = Date.now();
  const rows: Array<unknown[]> = [];`,
  `  const now = Date.now();
  // Honest marginal sell-side cost a partial-TP must clear to net positive: REAL expected slippage
  // plus the session's platform fee (taken on the sell output). This is the corrected break-even.
  const honestFloorBps = WORKER_EXIT_EXPECTED_SLIPPAGE_BPS + Number(session.service_control.platformFeeBps ?? 0);
  const rows: Array<unknown[]> = [];`,
  'honest floor compute',
);

// --- 5) per-row values: append honest_floor_bps + net_after_partial_bps ---
replaceOnce(
  `      JSON.stringify(evaluation.thresholds ?? null),
      JSON.stringify(evaluation),
    ]);`,
  `      JSON.stringify(evaluation.thresholds ?? null),
      JSON.stringify(evaluation),
      honestFloorBps,
      (intOrNull(evaluation.pnlBps) === null ? null : (intOrNull(evaluation.pnlBps) as number) - honestFloorBps),
    ]);`,
  'row values',
);

// --- 6) insert internals: cols 21 -> 23, casts, column list ---
replaceOnce(`    const cols = 21;`, `    const cols = 23;`, 'cols count');

replaceOnce(
  `      '::int', '::int', '::int', '::int',
      '::jsonb', '::jsonb',
    ];`,
  `      '::int', '::int', '::int', '::int',
      '::jsonb', '::jsonb',
      '::int', '::int',
    ];`,
  'columnCasts',
);

replaceOnce(
  `          pnl_bps, max_favorable_bps, max_adverse_bps, trailing_drawdown_bps,
          thresholds, evaluation
        ) VALUES \${valuesSql}`,
  `          pnl_bps, max_favorable_bps, max_adverse_bps, trailing_drawdown_bps,
          thresholds, evaluation,
          honest_floor_bps, net_after_partial_bps
        ) VALUES \${valuesSql}`,
  'insert column list',
);

fs.writeFileSync(file, src, 'utf8');
console.log('applied: honest break-even telemetry (move 1, shadow-only)');
