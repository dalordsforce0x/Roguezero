import 'dotenv/config';
import pg from 'pg';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_API_BASE = process.env.API_URL ?? 'http://localhost:4000';
const DEFAULT_SESSION_COUNT = 10;
const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_WAIT_SECONDS = 300;
const DEFAULT_SAMPLE_MS = 5_000;

const parseArgs = (argv) => {
  const options = {
    apiBase: DEFAULT_API_BASE,
    sessionCount: DEFAULT_SESSION_COUNT,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    waitSeconds: DEFAULT_WAIT_SECONDS,
    sampleMs: DEFAULT_SAMPLE_MS,
    targetWallet: null,
    stopAfter: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--api-base':
        options.apiBase = next;
        index += 1;
        break;
      case '--sessions':
        options.sessionCount = Number(next);
        index += 1;
        break;
      case '--duration-seconds':
        options.durationSeconds = Number(next);
        index += 1;
        break;
      case '--wait-seconds':
        options.waitSeconds = Number(next);
        index += 1;
        break;
      case '--sample-ms':
        options.sampleMs = Number(next);
        index += 1;
        break;
      case '--wallet':
        options.targetWallet = next;
        index += 1;
        break;
      case '--stop-after':
        options.stopAfter = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const dbUrl = new URL(databaseUrl);
dbUrl.searchParams.delete('sslmode');
const pool = new pg.Pool({
  connectionString: dbUrl.toString(),
  ssl: { rejectUnauthorized: false },
});

const loadTargetUser = async (targetWallet) => {
  const result = targetWallet
    ? await pool.query(
        `select id, username, wallet_address, license_key, access_enabled, expiry_date
           from rz_users
          where wallet_address = $1
          limit 1`,
        [targetWallet],
      )
    : await pool.query(
        `select id, username, wallet_address, license_key, access_enabled, expiry_date
           from rz_users
          where access_enabled = true
            and (expiry_date is null or expiry_date > now())
          order by created_at asc nulls last, id asc
          limit 1`,
      );

  return result.rows[0] ?? null;
};

const RZ_INTERNAL_SECRET = process.env.RZ_INTERNAL_SECRET ?? '';

const createSession = async (apiBase, user) => {
  const response = await fetch(`${apiBase}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-rz-internal-secret': RZ_INTERNAL_SECRET },
    body: JSON.stringify({
      userId: user.id,
      keyAuthUserId: user.id,
      licenseId: user.license_key ?? user.id,
      ownerWallet: user.wallet_address,
      fundingMint: SOL_MINT,
      fundingTokenSymbol: 'SOL',
      startingBalanceAtomic: '0',
      targetDurationMinutes: 60,
      stopLossBehavior: 'stop',
      riskLimits: {
        maxSessionLossUsd: 50,
        maxDailyLossUsd: 100,
        maxPositionSizeUsd: 20,
        maxOpenPositions: 1,
        maxSlippageBps: 50,
        cooldownMs: 30_000,
      },
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Session creation failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
};

const loadSessions = async (sessionIds) => {
  const result = await pool.query(
    `select id, status, session_wallet, requested_at, service_control
       from sessions
      where id = any($1::uuid[])
      order by requested_at asc`,
    [sessionIds],
  );

  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    sessionWallet: row.session_wallet,
    requestedAt: row.requested_at,
    serviceControl: row.service_control,
  }));
};

const summarizeStatuses = (sessions) => {
  const summary = new Map();
  for (const session of sessions) {
    summary.set(session.status, (summary.get(session.status) ?? 0) + 1);
  }
  return Object.fromEntries([...summary.entries()].sort(([a], [b]) => a.localeCompare(b)));
};

const loadExecutionCounts = async (sessionWallets) => {
  const result = await pool.query(
    `select taker, status, count(*)::int as count
       from swap_executions
      where taker = any($1::text[])
      group by taker, status`,
    [sessionWallets],
  );

  const counts = new Map();
  for (const row of result.rows) {
    const existing = counts.get(row.taker) ?? { prepared: 0, submitted: 0, confirmed: 0, failed: 0, total: 0 };
    existing[row.status] = row.count;
    existing.total += row.count;
    counts.set(row.taker, existing);
  }
  return counts;
};

const loadProviderBuckets = async () => {
  const result = await pool.query(
    `select bucket_key, round(available_tokens::numeric, 2) as available_tokens, round(max_tokens::numeric, 2) as max_tokens, round(refill_rate_per_sec::numeric, 2) as refill_rate_per_sec, updated_at
       from provider_rate_limits
      order by bucket_key asc`,
  );
  return result.rows;
};

const stopSessions = async (apiBase, sessionIds) => {
  for (const sessionId of sessionIds) {
    const response = await fetch(`${apiBase}/sessions/${sessionId}/action`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-rz-internal-secret': RZ_INTERNAL_SECRET },
      body: JSON.stringify({ action: 'stop' }),
    });
    if (!response.ok) {
      const payload = await response.text();
      console.warn(`stop failed for ${sessionId}: ${response.status} ${payload}`);
    }
  }
};

const main = async () => {
  const options = parseArgs(process.argv);
  console.log(`Stage 2 proof runner -> api=${options.apiBase} sessions=${options.sessionCount} duration=${options.durationSeconds}s wait=${options.waitSeconds}s stopAfter=${options.stopAfter}`);

  const user = await loadTargetUser(options.targetWallet);
  if (!user) {
    throw new Error('No eligible user found for Stage 2 proof');
  }

  console.log(`Using user ${user.username} (${user.id})`);

  const created = [];
  for (let index = 0; index < options.sessionCount; index += 1) {
    const payload = await createSession(options.apiBase, user);
    created.push({
      id: payload.session.id,
      sessionWallet: payload.sessionWallet,
      minimumFundingLamports: payload.fundingInstructions.minimumFundingLamports,
      minimumFundingSol: payload.fundingInstructions.minimumFundingSol,
    });
  }

  console.log('Created sessions:');
  console.table(created.map((entry, index) => ({
    index: index + 1,
    sessionId: entry.id,
    sessionWallet: entry.sessionWallet,
    minimumFundingSol: entry.minimumFundingSol,
  })));

  const minimumFundingSol = created[0]?.minimumFundingSol ?? 0;
  const totalFundingSol = Number((minimumFundingSol * created.length).toFixed(6));
  console.log(`Fund each session wallet with at least ${minimumFundingSol.toFixed(6)} SOL (total batch minimum ${totalFundingSol.toFixed(6)} SOL).`);
  console.log('Waiting for all sessions to become active...');

  const deadline = Date.now() + options.waitSeconds * 1000;
  let sessions = await loadSessions(created.map((entry) => entry.id));
  while (Date.now() < deadline) {
    const activeCount = sessions.filter((session) => session.status === 'active').length;
    console.log(`[wait] statuses=${JSON.stringify(summarizeStatuses(sessions))} active=${activeCount}/${created.length}`);
    if (activeCount === created.length) {
      break;
    }
    await sleep(options.sampleMs);
    sessions = await loadSessions(created.map((entry) => entry.id));
  }

  const activeCount = sessions.filter((session) => session.status === 'active').length;
  if (activeCount !== created.length) {
    console.log('Not all sessions became active within the wait window.');
    console.table(sessions.map((session) => ({ id: session.id, status: session.status, sessionWallet: session.sessionWallet })));
    process.exitCode = 1;
    return;
  }

  const sessionWallets = sessions.map((session) => session.sessionWallet);
  const baselineExecutions = await loadExecutionCounts(sessionWallets);
  const monitorStartedAtIso = new Date().toISOString();
  console.log(`All ${created.length} sessions active. Monitoring progress for ${options.durationSeconds}s starting at ${monitorStartedAtIso}.`);

  const monitorDeadline = Date.now() + options.durationSeconds * 1000;
  while (Date.now() < monitorDeadline) {
    await sleep(options.sampleMs);
    sessions = await loadSessions(created.map((entry) => entry.id));
    const executionCounts = await loadExecutionCounts(sessionWallets);
    const progressed = sessions.filter((session) => {
      const schedulingState = session.serviceControl?.schedulingState ?? {};
      const lastTradeSubmittedAt = schedulingState.lastTradeSubmittedAt ?? null;
      const executionDelta = (executionCounts.get(session.sessionWallet)?.total ?? 0) - (baselineExecutions.get(session.sessionWallet)?.total ?? 0);
      return executionDelta > 0 || (lastTradeSubmittedAt && lastTradeSubmittedAt >= monitorStartedAtIso);
    }).length;
    console.log(`[monitor] statuses=${JSON.stringify(summarizeStatuses(sessions))} progressed=${progressed}/${created.length}`);
  }

  const finalExecutions = await loadExecutionCounts(sessionWallets);
  const providerBuckets = await loadProviderBuckets();

  const perSessionProgress = sessions.map((session) => {
    const schedulingState = session.serviceControl?.schedulingState ?? {};
    const baseline = baselineExecutions.get(session.sessionWallet) ?? { prepared: 0, submitted: 0, confirmed: 0, failed: 0, total: 0 };
    const final = finalExecutions.get(session.sessionWallet) ?? { prepared: 0, submitted: 0, confirmed: 0, failed: 0, total: 0 };
    return {
      id: session.id,
      status: session.status,
      sessionWallet: session.sessionWallet,
      lastTradeSubmittedAt: schedulingState.lastTradeSubmittedAt ?? null,
      newExecutions: final.total - baseline.total,
      newConfirmed: final.confirmed - baseline.confirmed,
      newSubmitted: final.submitted - baseline.submitted,
      newFailed: final.failed - baseline.failed,
    };
  });

  console.log('Per-session progress summary:');
  console.table(perSessionProgress);
  console.log('Provider bucket snapshot:');
  console.table(providerBuckets);
  console.log('NOTE: confirm zero 429s by checking the API + worker runtime logs during this window.');

  if (options.stopAfter) {
    console.log('Stopping created sessions...');
    await stopSessions(options.apiBase, created.map((entry) => entry.id));
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
