// One-shot disk edit: add exit-shadow decision HISTORY persistence to the worker.
// Per "interest now.txt" Step C: the adaptive/grid shadow currently overwrites
// service_control every cycle, so there is no record to compare decisions against
// what price did next. This appends each canary cycle's shadow decisions to a
// dedicated exit_shadow_decisions table (canary-scoped, throttled, no execution).
// Run: node tmp/apply-exit-shadow-history.cjs
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');
const before = src;

// ---- Edit 1: feature flag const (default on; only writes for canary sessions) ----
const flagAnchor = "const WORKER_GRID_CHOP_SHADOW_ENABLED = process.env.WORKER_GRID_CHOP_SHADOW_ENABLED === 'true';\n";
const flagNew = flagAnchor +
  "const WORKER_EXIT_SHADOW_HISTORY_ENABLED = process.env.WORKER_EXIT_SHADOW_HISTORY_ENABLED !== 'false';\n";
if (!src.includes("WORKER_EXIT_SHADOW_HISTORY_ENABLED")) {
  if (!src.includes(flagAnchor)) throw new Error('flag anchor not found');
  src = src.replace(flagAnchor, flagNew);
}

// ---- Edit 2: history table + append helper, inserted before getSessionStrategyConfig ----
const helperAnchor = "const getSessionStrategyConfig = (session: RawSession) => {";
const helper = `let exitShadowHistoryReadyPromise: Promise<void> | null = null;

const ensureExitShadowHistoryReady = async () => {
  if (!exitShadowHistoryReadyPromise) {
    const dbPool = getPool();
    exitShadowHistoryReadyPromise = dbPool.query(\`
      CREATE TABLE IF NOT EXISTS exit_shadow_decisions (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL,
        owner_wallet TEXT,
        mint TEXT NOT NULL,
        symbol TEXT,
        token_class TEXT,
        current_should_exit BOOLEAN,
        current_reason TEXT,
        adaptive_action TEXT,
        adaptive_reason TEXT,
        adaptive_suggested_sell_bps INTEGER,
        adaptive_suggested_stop_bps INTEGER,
        grid_regime TEXT,
        grid_action TEXT,
        grid_reason TEXT,
        pnl_bps INTEGER,
        max_favorable_bps INTEGER,
        max_adverse_bps INTEGER,
        trailing_drawdown_bps INTEGER,
        thresholds JSONB,
        evaluation JSONB,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    \`)
      .then(() => dbPool.query(\`
        CREATE INDEX IF NOT EXISTS exit_shadow_decisions_session_time_idx
        ON exit_shadow_decisions (session_id, decided_at DESC)
      \`))
      .then(() => dbPool.query(\`
        CREATE INDEX IF NOT EXISTS exit_shadow_decisions_session_mint_time_idx
        ON exit_shadow_decisions (session_id, mint, decided_at DESC)
      \`))
      .then(() => undefined);
  }
  return exitShadowHistoryReadyPromise;
};

// Throttle: persist a fresh history row per (session, mint) only when the adaptive
// action changes OR a heartbeat interval elapses, so the table samples the PnL path
// without exploding to one row per position every cycle.
const exitShadowHistoryLastWrite = new Map<string, { at: number; action: string }>();
const EXIT_SHADOW_HISTORY_HEARTBEAT_MS = 30000;

const appendExitShadowHistory = async (
  session: RawSession,
  evaluations: Array<Record<string, unknown>>,
  adaptiveShadow: ReturnType<typeof buildAdaptiveExitShadow>,
  gridShadow: ReturnType<typeof buildGridChopShadow>,
): Promise<void> => {
  if (!WORKER_EXIT_SHADOW_HISTORY_ENABLED) return;
  // Canary-scoped: only accrue history where the shadow itself is active.
  if (!adaptiveShadow.enabled) return;
  if (evaluations.length === 0) return;

  const adaptiveByMint = new Map<string, Record<string, unknown>>();
  for (const decision of adaptiveShadow.decisions) {
    adaptiveByMint.set(String(decision.mint), decision as Record<string, unknown>);
  }
  const gridByMint = new Map<string, Record<string, unknown>>();
  for (const candidate of gridShadow.candidates) {
    gridByMint.set(String(candidate.mint), candidate as Record<string, unknown>);
  }

  const intOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

  const now = Date.now();
  const rows: Array<unknown[]> = [];
  for (const evaluation of evaluations) {
    const mint = String(evaluation.mint);
    const adaptive = adaptiveByMint.get(mint);
    const grid = gridByMint.get(mint);
    const adaptiveAction = adaptive ? String(adaptive.action ?? 'hold') : 'hold';
    const key = \`\${session.id}:\${mint}\`;
    const last = exitShadowHistoryLastWrite.get(key);
    const actionChanged = !last || last.action !== adaptiveAction;
    const heartbeatDue = !last || now - last.at >= EXIT_SHADOW_HISTORY_HEARTBEAT_MS;
    if (!actionChanged && !heartbeatDue) continue;
    exitShadowHistoryLastWrite.set(key, { at: now, action: adaptiveAction });

    rows.push([
      randomUUID(),
      session.id,
      session.owner_wallet ?? null,
      mint,
      evaluation.symbol ? String(evaluation.symbol) : null,
      evaluation.tokenClass ? String(evaluation.tokenClass) : null,
      typeof evaluation.shouldExit === 'boolean' ? evaluation.shouldExit : null,
      evaluation.reason ? String(evaluation.reason) : null,
      adaptiveAction,
      adaptive?.reason ? String(adaptive.reason) : null,
      intOrNull(adaptive?.suggestedSellBps),
      intOrNull(adaptive?.suggestedStopBps),
      gridShadow.marketRegime ?? null,
      grid?.action ? String(grid.action) : null,
      grid?.reason ? String(grid.reason) : null,
      intOrNull(evaluation.pnlBps),
      intOrNull(evaluation.maxFavorableBps),
      intOrNull(evaluation.maxAdverseBps),
      intOrNull(evaluation.trailingDrawdownBps),
      JSON.stringify(evaluation.thresholds ?? null),
      JSON.stringify(evaluation),
    ]);
  }

  if (rows.length === 0) return;

  try {
    await ensureExitShadowHistoryReady();
    const dbPool = getPool();
    const cols = 21;
    const valuesSql = rows
      .map((_, rowIndex) => {
        const base = rowIndex * cols;
        const placeholders = Array.from({ length: cols }, (_, c) => \`$\${base + c + 1}\`);
        return \`(\${placeholders.join(', ')})\`;
      })
      .join(', ');
    await dbPool.query(
      \`
        INSERT INTO exit_shadow_decisions (
          id, session_id, owner_wallet, mint, symbol, token_class,
          current_should_exit, current_reason,
          adaptive_action, adaptive_reason, adaptive_suggested_sell_bps, adaptive_suggested_stop_bps,
          grid_regime, grid_action, grid_reason,
          pnl_bps, max_favorable_bps, max_adverse_bps, trailing_drawdown_bps,
          thresholds, evaluation
        ) VALUES \${valuesSql}
      \`,
      rows.flat(),
    );
  } catch (error) {
    console.warn('[exit-shadow-history] append failed', error instanceof Error ? error.message : error);
  }
};

`;
if (!src.includes("const appendExitShadowHistory")) {
  if (!src.includes(helperAnchor)) throw new Error('helper anchor not found');
  src = src.replace(helperAnchor, helper + helperAnchor);
}

// ---- Edit 3: capture shadow results + append history in the persist block ----
const persistOld = `    if (WORKER_EXIT_TELEMETRY_ENABLED && exitEvaluations.length > 0) {
      await persistServiceControl(session, {
        lastExitEvaluations: exitEvaluations,
        lastExitEvaluation: exitEvaluations,
        adaptiveExitShadow: buildAdaptiveExitShadow({ session, evaluations: exitEvaluations }),
        gridChopShadow: buildGridChopShadow({ session, evaluations: exitEvaluations }),
      } as any);
    }`;
const persistNew = `    if (WORKER_EXIT_TELEMETRY_ENABLED && exitEvaluations.length > 0) {
      const adaptiveExitShadow = buildAdaptiveExitShadow({ session, evaluations: exitEvaluations });
      const gridChopShadow = buildGridChopShadow({ session, evaluations: exitEvaluations });
      await persistServiceControl(session, {
        lastExitEvaluations: exitEvaluations,
        lastExitEvaluation: exitEvaluations,
        adaptiveExitShadow,
        gridChopShadow,
      } as any);
      await appendExitShadowHistory(session, exitEvaluations, adaptiveExitShadow, gridChopShadow);
    }`;
if (!src.includes("await appendExitShadowHistory(session, exitEvaluations")) {
  if (!src.includes(persistOld)) throw new Error('persist block anchor not found');
  src = src.replace(persistOld, persistNew);
}

if (src === before) {
  console.log('no changes needed (already applied)');
} else {
  fs.writeFileSync(file, src, 'utf8');
  console.log('applied: exit-shadow decision history');
}
