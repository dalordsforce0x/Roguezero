import 'dotenv/config';
import pg from 'pg';
import { appendFileSync, writeFileSync } from 'node:fs';

const SESSION_ID = process.argv[2] || 'c43727e8-d2ca-4345-933b-1a4dceced8a3';
const SESSION_WALLET = process.argv[3] || '4gCXvwijgnF83ZenbHUP3LCiTtKh55ZFzyLuRynEVezD';
const DURATION_MIN = Number(process.argv[4] || 60);
const INTERVAL_MS = Number(process.argv[5] || 120000);
const LOG = `tmp/session-watch-${SESSION_ID.slice(0, 8)}.log`;

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL required');
const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } });

const line = (obj) => {
  const s = JSON.stringify(obj);
  appendFileSync(LOG, s + '\n');
  console.log(s);
};

const snapshot = async (tick) => {
  const out = { tick, ts: new Date().toISOString() };
  try {
    const sess = await pool.query(
      `SELECT status, started_at, ended_at, stop_reason, service_control
         FROM public.sessions WHERE id = $1`,
      [SESSION_ID],
    );
    if (sess.rows.length === 0) { out.error = 'session_not_found'; line(out); return; }
    const row = sess.rows[0];
    out.status = row.status;
    out.stopReason = row.stop_reason;
    const sc = row.service_control || {};
    const risk = sc.riskState || {};
    out.pnlUsd = risk.dailyRealizedPnlUsd ?? null;
    out.consecutiveLosses = risk.consecutiveLosses ?? null;
    out.badFillStreak = risk.badFillStreak ?? null;
    const ps = sc.positionsState || {};
    const positions = ps.positions || {};
    out.openPositions = Object.values(positions)
      .filter((p) => p && p.status === 'long')
      .map((p) => ({
        sym: p.positionSymbol,
        entry: p.entryPriceUsd,
        mark: p.lastMarkedPriceUsd,
        bps: p.entryPriceUsd ? Math.round(((p.lastMarkedPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 10000) : null,
      }));
    out.openCount = out.openPositions.length;
    out.activeStrategy = sc.rotationState?.activeStrategy ?? null;
    const sched = sc.schedulingState || {};
    out.blockedReasonCounts = sched.blockedReasonCounts || {};
    out.lastDecisionReason = sched.lastDecisionReason ?? null;
    out.lastBlockedReason = sched.lastBlockedReason ?? null;
    const audit = sc.lastExecutionAudit || null;
    out.lastTrade = audit ? { at: audit.at, dir: audit.direction, badFill: audit.badFill, outBps: audit.outputDeltaBps } : null;

    const ex = await pool.query(
      `SELECT status, count(*)::int AS n
         FROM public.swap_executions
        WHERE taker = $1 AND created_at > now() - interval '90 minutes'
        GROUP BY status`,
      [SESSION_WALLET],
    );
    out.execCounts = Object.fromEntries(ex.rows.map((r) => [r.status, r.n]));
  } catch (err) {
    out.error = String(err);
  }
  line(out);
  return out;
};

const main = async () => {
  writeFileSync(LOG, '');
  line({ event: 'watch_start', session: SESSION_ID, wallet: SESSION_WALLET, durationMin: DURATION_MIN, intervalMs: INTERVAL_MS });
  const ticks = Math.ceil((DURATION_MIN * 60000) / INTERVAL_MS);
  let firstPnl = null;
  for (let i = 0; i <= ticks; i += 1) {
    const snap = await snapshot(i);
    if (snap && typeof snap.pnlUsd === 'number' && firstPnl === null) firstPnl = snap.pnlUsd;
    if (snap && (snap.status === 'stopped' || snap.status === 'ended')) {
      line({ event: 'session_ended', status: snap.status, stopReason: snap.stopReason, finalPnlUsd: snap.pnlUsd });
      break;
    }
    if (i < ticks) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  line({ event: 'watch_complete', firstPnlUsd: firstPnl });
  await pool.end();
};

main().catch((e) => { line({ event: 'watch_fatal', error: String(e) }); process.exitCode = 1; });
