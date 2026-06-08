/*
 * Phase 3 move 2 (shadow-only): token-class partial-TP shadow.
 * Records, per position snapshot, whether a per-class partial-TP trigger (calibrated to
 * CLEAR the honest break-even) would fire and what net bps it would bank. NO execution.
 * Disk-edit script (worker file served stale by buffer tools). Uses split/join (never
 * String.replace) to avoid the $$ -> $ collapse hazard.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');

const edits = [];
function apply(label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  edits.push(label);
}

// 1) Add the helper function right after the heartbeat const, before appendExitShadowHistory.
apply(
  'helper',
  `const exitShadowHistoryLastWrite = new Map<string, { at: number; action: string }>();
const EXIT_SHADOW_HISTORY_HEARTBEAT_MS = 30000;
`,
  `const exitShadowHistoryLastWrite = new Map<string, { at: number; action: string }>();
const EXIT_SHADOW_HISTORY_HEARTBEAT_MS = 30000;

// Phase 3 move 2 (shadow-only): token-class partial-TP that must CLEAR the honest break-even.
// Faster/larger partials for runner-prone classes, slower/smaller for majors. The trigger is
// honest break-even + a class margin so the sold fraction nets clearly positive. NO execution;
// this records what a per-class partial WOULD bank so we can validate it before flipping exec.
const computePartialTpShadow = (
  tokenClass: TokenTradeClass,
  pnlBps: number | null,
  honestFloorBps: number,
): { triggerBps: number; sellBps: number; fired: boolean; netBps: number | null } => {
  const profile =
    tokenClass === 'major'
      ? { marginBps: 50, sellBps: 3000 }
      : tokenClass === 'sol_beta'
        ? { marginBps: 20, sellBps: 3500 }
        : tokenClass === 'trend_liquid'
          ? { marginBps: 15, sellBps: 4000 }
          : { marginBps: 10, sellBps: 5000 };
  const triggerBps = honestFloorBps + profile.marginBps;
  const fired = pnlBps !== null && pnlBps >= triggerBps;
  const netBps = fired ? (pnlBps as number) - honestFloorBps : null;
  return { triggerBps, sellBps: profile.sellBps, fired, netBps };
};
`,
);

// 2) Compute the partial shadow inside the row loop, before rows.push.
apply(
  'compute',
  `    exitShadowHistoryLastWrite.set(key, { at: now, action: adaptiveAction });

    rows.push([`,
  `    exitShadowHistoryLastWrite.set(key, { at: now, action: adaptiveAction });

    const pnlForPartial = intOrNull(evaluation.pnlBps);
    const partialShadow = computePartialTpShadow(
      (evaluation.tokenClass as TokenTradeClass) ?? 'long_tail',
      pnlForPartial,
      honestFloorBps,
    );

    rows.push([`,
);

// 3) Append the 4 partial-shadow values to each pushed row.
apply(
  'rowtail',
  `      honestFloorBps,
      (intOrNull(evaluation.pnlBps) === null ? null : (intOrNull(evaluation.pnlBps) as number) - honestFloorBps),
    ]);`,
  `      honestFloorBps,
      pnlForPartial === null ? null : pnlForPartial - honestFloorBps,
      partialShadow.triggerBps,
      partialShadow.sellBps,
      partialShadow.fired,
      partialShadow.netBps,
    ]);`,
);

// 4) Bump column count + casts.
apply(
  'cols',
  `    const cols = 23;
    const columnCasts = [
      '::uuid', '::uuid', '::text', '::text', '::text', '::text',
      '::boolean', '::text',
      '::text', '::text', '::int', '::int',
      '::text', '::text', '::text',
      '::int', '::int', '::int', '::int',
      '::jsonb', '::jsonb',
      '::int', '::int',
    ];`,
  `    const cols = 27;
    const columnCasts = [
      '::uuid', '::uuid', '::text', '::text', '::text', '::text',
      '::boolean', '::text',
      '::text', '::text', '::int', '::int',
      '::text', '::text', '::text',
      '::int', '::int', '::int', '::int',
      '::jsonb', '::jsonb',
      '::int', '::int',
      '::int', '::int', '::boolean', '::int',
    ];`,
);

// 5) Extend the INSERT column list.
apply(
  'insertcols',
  `          honest_floor_bps, net_after_partial_bps
        ) VALUES \${valuesSql}`,
  `          honest_floor_bps, net_after_partial_bps,
          partial_trigger_bps, partial_sell_bps, partial_fired, partial_net_bps
        ) VALUES \${valuesSql}`,
);

// 6) CREATE TABLE: add the 4 partial columns.
apply(
  'createtable',
  `        honest_floor_bps INTEGER,
        net_after_partial_bps INTEGER,
        thresholds JSONB,`,
  `        honest_floor_bps INTEGER,
        net_after_partial_bps INTEGER,
        partial_trigger_bps INTEGER,
        partial_sell_bps INTEGER,
        partial_fired BOOLEAN,
        partial_net_bps INTEGER,
        thresholds JSONB,`,
);

// 7) ALTER TABLE: add the 4 partial columns for the already-existing prod table.
apply(
  'altertable',
  `          ADD COLUMN IF NOT EXISTS honest_floor_bps INTEGER,
          ADD COLUMN IF NOT EXISTS net_after_partial_bps INTEGER
      `,
  `          ADD COLUMN IF NOT EXISTS honest_floor_bps INTEGER,
          ADD COLUMN IF NOT EXISTS net_after_partial_bps INTEGER,
          ADD COLUMN IF NOT EXISTS partial_trigger_bps INTEGER,
          ADD COLUMN IF NOT EXISTS partial_sell_bps INTEGER,
          ADD COLUMN IF NOT EXISTS partial_fired BOOLEAN,
          ADD COLUMN IF NOT EXISTS partial_net_bps INTEGER
      `,
);

fs.writeFileSync(file, src, 'utf8');
console.log('applied edits:', edits.join(', '));
