import pg from 'pg';
import 'dotenv/config';

const pollMs = Number(process.env.WATCH_POLL_MS ?? 5000);
const ownerFilter = process.env.WATCH_OWNER_WALLET?.trim() || null;
const sessionFilter = process.env.WATCH_SESSION_ID?.trim() || null;
const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();

if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const url = databaseUrl.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require');
const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 15000,
  query_timeout: 15000,
  lock_timeout: 3000,
});

const dangerStates = new Set(['gas_danger', 'exit_blocked', 'recovery_required', 'error']);
const activeStatuses = ['awaiting_funding', 'ready', 'starting', 'active', 'paused', 'stopping'];
let lastFingerprint = '';
let lastSessionId = null;
let lastExecId = null;

const short = (value) => (typeof value === 'string' && value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);
const fmt = (value) => value == null ? '—' : String(value);
const sol = (atomic) => {
  const n = Number(atomic ?? 0);
  if (!Number.isFinite(n)) return String(atomic ?? '0');
  return `${(n / 1_000_000_000).toFixed(6)} SOL`;
};

async function getWatchedSession() {
  if (sessionFilter) {
    const res = await client.query(`
      SELECT * FROM sessions WHERE id = $1 LIMIT 1
    `, [sessionFilter]);
    return res.rows[0] ?? null;
  }

  const params = [];
  let where = `status = ANY($1::text[])`;
  params.push(activeStatuses);

  if (ownerFilter) {
    params.push(ownerFilter);
    where += ` AND owner_wallet = $${params.length}`;
  }

  let res = await client.query(`
    SELECT * FROM sessions
    WHERE ${where}
    ORDER BY requested_at DESC
    LIMIT 1
  `, params);
  if (res.rows[0]) return res.rows[0];

  res = await client.query(`
    SELECT * FROM sessions
    ${ownerFilter ? 'WHERE owner_wallet = $1' : ''}
    ORDER BY requested_at DESC
    LIMIT 1
  `, ownerFilter ? [ownerFilter] : []);
  return res.rows[0] ?? null;
}

async function getLatestExecution(sessionWallet) {
  const res = await client.query(`
    SELECT id, status, input_mint, output_mint, amount, signature, confirmation_status, last_error, created_at, updated_at
    FROM swap_executions
    WHERE taker = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [sessionWallet]);
  return res.rows[0] ?? null;
}

function summarizeSession(row, exec) {
  const sc = row.service_control ?? {};
  const funding = row.funding ?? {};
  const health = sc.healthState ?? null;
  const sched = sc.schedulingState ?? {};
  const residual = sc.residualRecovery ?? null;
  const positions = sc.positionsState?.positions ?? {};
  const openPositions = Object.values(positions).filter((p) => p?.status === 'long' || p?.status === 'long_sol');
  const healthState = health?.state ?? 'no_health_yet';
  const healthReason = health?.reason ?? sched.lastBlockedReason ?? null;
  const blockerCount = health?.blockerCount ?? (healthReason && sched.blockedReasonCounts ? sched.blockedReasonCounts[healthReason] : 0) ?? 0;

  return {
    id: row.id,
    status: row.status,
    wallet: row.session_wallet,
    owner: row.owner_wallet,
    balance: funding.currentBalanceAtomic ?? '0',
    healthState,
    healthSeverity: health?.severity ?? '—',
    healthReason,
    blockerCount,
    lastDecisionOutcome: sched.lastDecisionOutcome ?? null,
    lastDecisionReason: sched.lastDecisionReason ?? null,
    openPositions: openPositions.length,
    residual: residual ? residual.state ?? 'present' : null,
    execStatus: exec?.status ?? null,
    execConfirm: exec?.confirmation_status ?? null,
    execError: exec?.last_error ?? null,
    execSig: exec?.signature ?? null,
    execId: exec?.id ?? null,
  };
}

function fingerprint(s) {
  return JSON.stringify(s);
}

function printSummary(s) {
  const danger = dangerStates.has(s.healthState) || s.residual;
  const prefix = danger ? '🚨' : s.status === 'active' ? '🟢' : s.status === 'stopping' ? '🟠' : '🔎';
  console.log(`\n${prefix} ${new Date().toISOString()} session=${s.id} status=${s.status} wallet=${short(s.wallet)} balance=${sol(s.balance)}`);
  console.log(`   health=${s.healthState}/${s.healthSeverity} reason=${fmt(s.healthReason)} count=${fmt(s.blockerCount)} openPositions=${s.openPositions}`);
  console.log(`   decision=${fmt(s.lastDecisionOutcome)}:${fmt(s.lastDecisionReason)} residual=${fmt(s.residual)}`);
  if (s.execId) {
    console.log(`   latestExec=${s.execId} status=${fmt(s.execStatus)} confirm=${fmt(s.execConfirm)} sig=${short(s.execSig)} err=${fmt(s.execError)}`);
  } else {
    console.log('   latestExec=—');
  }
  if (danger) {
    console.log('   ACTION: intervene now — do not let this sit as merely running.');
  }
}

await client.connect();
console.log(`watch-live-session-health started pollMs=${pollMs} owner=${ownerFilter ?? 'any'} session=${sessionFilter ?? 'latest active/newest'}`);

async function tick() {
  try {
    const session = await getWatchedSession();
    if (!session) {
      const fp = 'no-session';
      if (lastFingerprint !== fp) {
        lastFingerprint = fp;
        console.log(`\n🔎 ${new Date().toISOString()} no sessions found`);
      }
      return;
    }

    if (lastSessionId !== session.id) {
      lastSessionId = session.id;
      lastExecId = null;
      lastFingerprint = '';
      console.log(`\n👀 Now watching session ${session.id} owner=${short(session.owner_wallet)} sessionWallet=${session.session_wallet}`);
    }

    const exec = await getLatestExecution(session.session_wallet);
    const summary = summarizeSession(session, exec);
    const fp = fingerprint(summary);
    if (fp !== lastFingerprint || exec?.id !== lastExecId) {
      lastFingerprint = fp;
      lastExecId = exec?.id ?? null;
      printSummary(summary);
    }
  } catch (err) {
    console.error(`\nwatch error ${new Date().toISOString()}:`, err?.message ?? err);
  }
}

await tick();
const timer = setInterval(tick, pollMs);

const shutdown = async () => {
  clearInterval(timer);
  await client.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
