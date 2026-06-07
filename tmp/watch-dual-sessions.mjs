import pg from 'pg';

const sessionIds = (process.env.WATCH_SESSION_IDS ?? '79fd9603-c735-4248-89bd-c2a44e039fd7,4ac5f8b8-6789-45ca-8063-173d217712b3')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const labels = {
  '79fd9603-c735-4248-89bd-c2a44e039fd7': 'main',
  '4ac5f8b8-6789-45ca-8063-173d217712b3': 'Noah',
};
const intervalMs = Number(process.env.WATCH_INTERVAL_MS ?? 30000);
const maxSamples = Number(process.env.WATCH_MAX_SAMPLES ?? 20);
const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim() ?? process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: databaseUrl.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require'),
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60000,
  query_timeout: 60000,
  lock_timeout: 3000,
});

let sample = 0;
let lastExecutionKey = null;

const fmt = (value) => value === null || value === undefined ? 'n/a' : String(value);
const shortId = (value) => value ? String(value).slice(0, 8) : 'n/a';
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function describePositions(positionsState) {
  const positions = asObject(positionsState?.positions);
  const open = Object.values(positions).filter((position) => position?.status === 'long');
  if (open.length === 0) return 'flat';
  return open.map((position) => {
    const symbol = position.positionSymbol ?? shortId(position.positionMint);
    const qty = position.quantityAtomic ?? 'n/a';
    const mfe = position.maxFavorableBps ?? 'n/a';
    const pending = position.pendingExitReason ?? 'none';
    return `${symbol} qty=${qty} mfe=${mfe} pending=${pending}`;
  }).join(' | ');
}

async function tick() {
  sample += 1;
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `SELECT id, status, session_wallet,
            funding->>'currentBalanceAtomic' AS current_balance,
            funding->>'realizedPnlUsd' AS realized_pnl,
            funding->>'unrealizedPnlUsd' AS unrealized_pnl,
            service_control->'positionsState' AS positions_state,
            service_control->'lastTradeGate' AS last_trade_gate,
            service_control->'lastExitEvaluations' AS exit_evaluations,
            service_control->'adaptiveExitShadow' AS adaptive_shadow,
            service_control->'gridChopShadow' AS grid_shadow
       FROM sessions
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [sessionIds],
  );

  const takers = rows.map((row) => row.session_wallet).filter(Boolean);
  const executions = takers.length > 0
    ? (await pool.query(
        `SELECT id, taker, status, input_mint, output_mint, amount, signature, submitted_at, confirmed_at, last_error, metadata
           FROM swap_executions
          WHERE taker = ANY($1::text[])
          ORDER BY created_at DESC
          LIMIT 8`,
        [takers],
      )).rows
    : [];

  const executionKey = executions.map((execution) => `${execution.id}:${execution.status}:${execution.confirmed_at ?? ''}`).join('|');
  const executionChanged = executionKey !== lastExecutionKey;
  lastExecutionKey = executionKey;

  console.log(`\n[${now}] sample=${sample}/${maxSamples} sessions=${rows.length} executionsChanged=${executionChanged}`);
  for (const row of rows) {
    const label = labels[row.id] ?? shortId(row.id);
    const gate = row.last_trade_gate ?? {};
    const evaluations = Array.isArray(row.exit_evaluations) ? row.exit_evaluations : [];
    console.log(`  ${label} status=${row.status} realized=${fmt(row.realized_pnl)} unrealized=${fmt(row.unrealized_pnl)} balance=${fmt(row.current_balance)} gate=${fmt(gate.decision)}/${fmt(gate.reason)} edge=${fmt(gate.expectedEdgeBps)} cost=${fmt(gate.estimatedCostBps)}`);
    console.log(`    positions: ${describePositions(row.positions_state)}`);
    for (const evaluation of evaluations) {
      const thresholds = evaluation.thresholds ?? {};
      console.log(`    eval ${evaluation.symbol ?? shortId(evaluation.mint)} ${evaluation.shouldExit ? 'EXIT' : 'hold'} pnl=${fmt(evaluation.pnlBps)} reason=${fmt(evaluation.reason)} tp=${fmt(thresholds.takeProfitBps)} pending=${fmt(evaluation.pendingExitReason)}`);
    }
    console.log(`    shadows adaptive=${fmt(row.adaptive_shadow?.enabled)} grid=${fmt(row.grid_shadow?.enabled)} regime=${fmt(row.grid_shadow?.marketRegime)}`);
  }

  for (const execution of executions.slice(0, 5)) {
    const session = rows.find((row) => row.session_wallet === execution.taker);
    const label = labels[session?.id] ?? shortId(execution.taker);
    const metadata = execution.metadata ?? {};
    const error = execution.last_error ? `${execution.last_error.stage ?? 'err'}:${execution.last_error.reason ?? JSON.stringify(execution.last_error)}` : '-';
    console.log(`  exec ${label} ${execution.status} amount=${execution.amount} exit=${metadata.exitReason ?? '-'} sig=${shortId(execution.signature)} error=${error} confirmed=${fmt(execution.confirmed_at)}`);
  }

  if (sample >= maxSamples) {
    await pool.end();
    process.exit(0);
  }
}

await tick().catch((err) => {
  console.error(`[${new Date().toISOString()}] watcher error`, err);
});

const timer = setInterval(() => {
  tick().catch(async (err) => {
    console.error(`[${new Date().toISOString()}] watcher error`, err);
    clearInterval(timer);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
}, intervalMs);
