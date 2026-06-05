import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env' });

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EPSILON_USD = 0.01;
const apply = process.argv.includes('--apply');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : null;

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');

const client = new pg.Client({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60000,
  query_timeout: 60000,
});

const getConfirmationTokenBalanceDeltaAtomic = (confirmation, params) => {
  if (!confirmation) return null;
  const meta = confirmation?.meta ?? null;
  const preTokenBalances = Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : [];
  const postTokenBalances = Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : [];
  const matchingIndexes = new Set();

  const matches = (entry) => (
    entry
    && entry.mint === params.mint
    && (!params.owner || entry.owner === params.owner)
    && Number.isInteger(entry.accountIndex)
  );

  for (const entry of preTokenBalances) if (matches(entry)) matchingIndexes.add(entry.accountIndex);
  for (const entry of postTokenBalances) if (matches(entry)) matchingIndexes.add(entry.accountIndex);
  if (matchingIndexes.size === 0) return null;

  const getAtomicAmount = (entry) => {
    const amount = Number(entry?.uiTokenAmount?.amount ?? '0');
    return Number.isFinite(amount) ? amount : 0;
  };

  let delta = 0;
  for (const accountIndex of matchingIndexes) {
    const preEntry = preTokenBalances.find((entry) => entry?.accountIndex === accountIndex);
    const postEntry = postTokenBalances.find((entry) => entry?.accountIndex === accountIndex);
    delta += getAtomicAmount(postEntry) - getAtomicAmount(preEntry);
  }

  return delta;
};

const getConfirmationWalletBalanceSnapshot = (confirmation, wallet) => {
  if (!confirmation) return null;
  const accountKeys = Array.isArray(confirmation.accountKeys) ? confirmation.accountKeys : [];
  const accountIndex = accountKeys.findIndex((key) => key === wallet);
  if (accountIndex < 0) return null;

  const preBalance = Number(confirmation.preBalances?.[accountIndex] ?? NaN);
  const postBalance = Number(confirmation.postBalances?.[accountIndex] ?? NaN);
  if (!Number.isFinite(preBalance) || !Number.isFinite(postBalance)) return null;

  return { preBalance, postBalance, delta: postBalance - preBalance };
};

const getBuildAtomicAmount = (buildResponse, key) => {
  const amount = buildResponse?.[key];
  const numeric = typeof amount === 'string' ? Number(amount) : 0;
  return Number.isFinite(numeric) ? numeric : 0;
};

const reconstructSessionPnl = (session, executions) => {
  const openPosition = { quantityAtomic: 0, costBasisUsd: 0 };
  let reconstructedPnlUsd = 0;
  let roundTrips = 0;
  let skippedExits = 0;

  for (const row of executions) {
    if (row.input_mint === USDC_MINT && row.output_mint === SOL_MINT) {
      const usdcDeltaAtomic = getConfirmationTokenBalanceDeltaAtomic(row.confirmation, {
        mint: USDC_MINT,
        owner: row.session_wallet,
      });
      const walletBalanceSnapshot = getConfirmationWalletBalanceSnapshot(row.confirmation, row.session_wallet);
      const usdcSpentAtomic = usdcDeltaAtomic !== null && usdcDeltaAtomic < 0
        ? Math.abs(usdcDeltaAtomic)
        : getBuildAtomicAmount(row.build_response, 'inAmount');
      const solReceivedAtomic = walletBalanceSnapshot !== null && walletBalanceSnapshot.delta > 0
        ? walletBalanceSnapshot.delta
        : getBuildAtomicAmount(row.build_response, 'outAmount');

      if (usdcSpentAtomic <= 0 || solReceivedAtomic <= 0) continue;
      openPosition.quantityAtomic += solReceivedAtomic;
      openPosition.costBasisUsd += usdcSpentAtomic / 1_000_000;
      continue;
    }

    if (row.input_mint === SOL_MINT && row.output_mint === USDC_MINT) {
      const usdcDeltaAtomic = getConfirmationTokenBalanceDeltaAtomic(row.confirmation, {
        mint: USDC_MINT,
        owner: row.session_wallet,
      });
      const usdcReceivedAtomic = usdcDeltaAtomic !== null && usdcDeltaAtomic > 0
        ? usdcDeltaAtomic
        : getBuildAtomicAmount(row.build_response, 'outAmount');
      const solSoldAtomic = Number(row.amount);

      if (openPosition.quantityAtomic <= 0 || openPosition.costBasisUsd <= 0) {
        skippedExits += 1;
        continue;
      }
      if (usdcReceivedAtomic <= 0 || !Number.isFinite(solSoldAtomic) || solSoldAtomic <= 0) continue;

      const soldFraction = Math.min(1, solSoldAtomic / openPosition.quantityAtomic);
      const costBasisSoldUsd = openPosition.costBasisUsd * soldFraction;
      const proceedsUsd = usdcReceivedAtomic / 1_000_000;
      reconstructedPnlUsd += proceedsUsd - costBasisSoldUsd;
      openPosition.quantityAtomic = Math.max(0, openPosition.quantityAtomic - solSoldAtomic);
      openPosition.costBasisUsd = Math.max(0, openPosition.costBasisUsd - costBasisSoldUsd);
      roundTrips += 1;
    }
  }

  const storedPnlUsd = Number(session.funding?.realizedPnlUsd ?? 0);
  const deltaUsd = storedPnlUsd - reconstructedPnlUsd;

  return {
    sessionId: session.id,
    sessionWallet: session.session_wallet,
    storedPnlUsd,
    reconstructedPnlUsd,
    deltaUsd,
    roundTrips,
    skippedExits,
    safelyReconstructable: skippedExits === 0,
    shouldRepair: Math.abs(deltaUsd) > EPSILON_USD,
  };
};

await client.connect();
try {
  const sessionsResult = await client.query(`
    select id, session_wallet, funding
    from sessions
    order by requested_at asc
  `);
  const executionsResult = await client.query(`
    select
      s.id as session_id,
      s.session_wallet,
      e.input_mint,
      e.output_mint,
      e.amount,
      e.build_response,
      e.confirmation,
      e.confirmed_at
    from swap_executions e
    inner join sessions s on s.session_wallet = e.taker
    where e.status = 'confirmed'
      and e.confirmation is not null
      and e.confirmed_at is not null
    order by s.session_wallet asc, e.confirmed_at asc, e.created_at asc
  `);

  const executionsBySession = new Map();
  for (const row of executionsResult.rows) {
    const list = executionsBySession.get(row.session_id) ?? [];
    list.push(row);
    executionsBySession.set(row.session_id, list);
  }

  const repairs = sessionsResult.rows
    .map((session) => ({
      session,
      audit: reconstructSessionPnl(session, executionsBySession.get(session.id) ?? []),
    }))
    .filter((item) => item.audit.shouldRepair)
    .sort((left, right) => Math.abs(right.audit.deltaUsd) - Math.abs(left.audit.deltaUsd));

  const safelyReconstructableRepairs = repairs.filter((item) => item.audit.safelyReconstructable);
  const selectedRepairs = limit ? repairs.slice(0, limit) : repairs;
  const selectedApplicableRepairs = (limit ? safelyReconstructableRepairs.slice(0, limit) : safelyReconstructableRepairs);

  if (apply) {
    await client.query('BEGIN');
    for (const item of selectedApplicableRepairs) {
      const currentFunding = item.session.funding ?? {};
      const nextFunding = {
        ...currentFunding,
        realizedPnlUsd: item.audit.reconstructedPnlUsd,
      };
      await client.query(
        `update sessions set funding = $2::jsonb where id = $1`,
        [item.session.id, JSON.stringify(nextFunding)],
      );
    }
    await client.query('COMMIT');
  }

  console.log(JSON.stringify({
    apply,
    selectedRepairs: selectedRepairs.length,
    safelyReconstructableRepairs: safelyReconstructableRepairs.length,
    applicableRepairs: selectedApplicableRepairs.length,
    preview: selectedRepairs.slice(0, 25).map((item) => ({
      sessionId: item.audit.sessionId,
      sessionWallet: item.audit.sessionWallet,
      storedPnlUsd: item.audit.storedPnlUsd,
      reconstructedPnlUsd: item.audit.reconstructedPnlUsd,
      deltaUsd: item.audit.deltaUsd,
      roundTrips: item.audit.roundTrips,
      skippedExits: item.audit.skippedExits,
      safelyReconstructable: item.audit.safelyReconstructable,
    })),
  }, null, 2));
} catch (error) {
  if (apply) {
    await client.query('ROLLBACK').catch(() => {});
  }
  throw error;
} finally {
  await client.end();
}
