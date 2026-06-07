import pg from 'pg';

const sessionId = process.env.WATCH_SESSION_ID ?? '79fd9603-c735-4248-89bd-c2a44e039fd7';
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
let lastAt = null;

const fmt = (value) => value === null || value === undefined ? 'n/a' : String(value);

async function tick() {
  sample += 1;
  const { rows } = await pool.query(
    `SELECT id, status,
            funding->>'realizedPnlUsd' AS realized_pnl,
            funding->>'unrealizedPnlUsd' AS unrealized_pnl,
            service_control->'lastExitEvaluations' AS evaluations,
            service_control->'adaptiveExitShadow' AS adaptive_shadow,
            service_control->'gridChopShadow' AS grid_shadow
       FROM sessions
      WHERE id = $1`,
    [sessionId],
  );

  const row = rows[0];
  const now = new Date().toISOString();
  if (!row) {
    console.log(`[${now}] sample=${sample} session not found: ${sessionId}`);
    return;
  }

  const evaluations = Array.isArray(row.evaluations) ? row.evaluations : [];
  const currentAt = evaluations[0]?.at ?? null;
  const changed = currentAt !== lastAt;
  lastAt = currentAt;

  console.log(`\n[${now}] sample=${sample}/${maxSamples} status=${row.status} realized=${fmt(row.realized_pnl)} unrealized=${fmt(row.unrealized_pnl)} evals=${evaluations.length} changed=${changed}`);
  for (const evaluation of evaluations) {
    const thresholds = evaluation.thresholds ?? {};
    const alert = evaluation.shouldExit ? 'EXIT' : 'hold';
    console.log(`  ${evaluation.symbol ?? 'UNKNOWN'} ${alert} pnl=${fmt(evaluation.pnlBps)}bps mfe=${fmt(evaluation.maxFavorableBps)}bps mae=${fmt(evaluation.maxAdverseBps)}bps trailDD=${fmt(evaluation.trailingDrawdownBps)}bps regime=${fmt(evaluation.signalRegime)} reason=${fmt(evaluation.reason)} tp=${fmt(thresholds.takeProfitBps)} sl=${fmt(thresholds.stopLossBps)} pending=${fmt(evaluation.pendingExitReason)}`);
  }
  console.log(`  adaptiveShadow=${fmt(row.adaptive_shadow?.enabled)} gridShadow=${fmt(row.grid_shadow?.enabled)} gridRegime=${fmt(row.grid_shadow?.marketRegime)}`);

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
