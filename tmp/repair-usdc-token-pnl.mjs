import pg from 'pg';
import { Connection, PublicKey } from '@solana/web3.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TARGET_SESSION_ID = process.env.REPAIR_SESSION_ID ?? '79fd9603-c735-4248-89bd-c2a44e039fd7';
const APPLY = process.argv.includes('--apply');

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');
const rpcUrl = process.env.HELIUS_RPC_URL?.trim() ?? process.env.SOLANA_RPC_URL?.trim();
if (!rpcUrl) throw new Error('HELIUS_RPC_URL or SOLANA_RPC_URL is required');
const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');
const connection = new Connection(rpcUrl, 'confirmed');

const client = new pg.Client({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60000,
  query_timeout: 60000,
});

const tokenBalances = (confirmation) => [
  ...(confirmation?.meta?.preTokenBalances ?? []),
  ...(confirmation?.meta?.postTokenBalances ?? []),
];

const getDecimals = (confirmation, mint) => {
  const match = tokenBalances(confirmation).find((entry) => entry?.mint === mint && Number.isFinite(entry?.uiTokenAmount?.decimals));
  return Number.isFinite(match?.uiTokenAmount?.decimals) ? Number(match.uiTokenAmount.decimals) : null;
};

const getTokenDeltaAtomic = (confirmation, { mint, owner }) => {
  const meta = confirmation?.meta ?? null;
  const pre = Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : [];
  const post = Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : [];
  const indexes = new Set();
  const matches = (entry) => entry && entry.mint === mint && (!owner || entry.owner === owner) && Number.isInteger(entry.accountIndex);
  for (const entry of pre) if (matches(entry)) indexes.add(entry.accountIndex);
  for (const entry of post) if (matches(entry)) indexes.add(entry.accountIndex);
  if (indexes.size === 0) return null;
  const amount = (entry) => {
    const n = Number(entry?.uiTokenAmount?.amount ?? '0');
    return Number.isFinite(n) ? n : 0;
  };
  let delta = 0;
  for (const idx of indexes) {
    delta += amount(post.find((entry) => entry?.accountIndex === idx)) - amount(pre.find((entry) => entry?.accountIndex === idx));
  }
  return delta;
};

const buildAmount = (row, key) => {
  const n = Number(row.build_response?.[key] ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const ui = (atomic, decimals) => atomic / 10 ** decimals;

const fetchMintDecimals = async (mint) => {
  const account = await connection.getParsedAccountInfo(new PublicKey(mint));
  const decimals = account.value?.data && 'parsed' in account.value.data
    ? account.value.data.parsed?.info?.decimals
    : null;
  return Number.isInteger(decimals) ? Number(decimals) : null;
};

await client.connect();
try {
  const sessionResult = await client.query(`select id, session_wallet, funding, service_control from sessions where id=$1`, [TARGET_SESSION_ID]);
  const session = sessionResult.rows[0];
  if (!session) throw new Error(`session not found: ${TARGET_SESSION_ID}`);

  const execResult = await client.query(`
    select id,input_mint,output_mint,amount,build_response,confirmation,confirmed_at,created_at
    from swap_executions
    where taker=$1 and status='confirmed' and confirmation is not null and confirmed_at is not null
    order by confirmed_at asc, created_at asc
  `, [session.session_wallet]);

  const decimalsByMint = new Map();
  const sessionPositions = session.service_control?.positionsState?.positions ?? {};
  for (const [mint, position] of Object.entries(sessionPositions)) {
    if (Number.isInteger(position?.tokenDecimals)) {
      decimalsByMint.set(mint, Number(position.tokenDecimals));
    }
  }
  const executionMints = new Set();
  for (const row of execResult.rows) {
    if (row.input_mint !== USDC_MINT) executionMints.add(row.input_mint);
    if (row.output_mint !== USDC_MINT) executionMints.add(row.output_mint);
  }
  for (const mint of executionMints) {
    if (decimalsByMint.has(mint)) continue;
    const fromConfirmation = execResult.rows
      .map((row) => getDecimals(row.confirmation, mint))
      .find((value) => value !== null);
    if (fromConfirmation !== undefined && fromConfirmation !== null) {
      decimalsByMint.set(mint, fromConfirmation);
      continue;
    }
    try {
      const onchainDecimals = await fetchMintDecimals(mint);
      if (onchainDecimals !== null) decimalsByMint.set(mint, onchainDecimals);
    } catch (error) {
      console.warn(`failed to fetch decimals for ${mint}: ${String(error)}`);
    }
  }

  const lotsByMint = new Map();
  const realizedEvents = [];
  let reconstructedRealizedPnlUsd = 0;

  const getLots = (mint) => {
    const lots = lotsByMint.get(mint) ?? [];
    lotsByMint.set(mint, lots);
    return lots;
  };

  for (const row of execResult.rows) {
    if (row.input_mint === USDC_MINT && row.output_mint !== USDC_MINT && row.output_mint !== SOL_MINT) {
      const mint = row.output_mint;
      const usdcDelta = getTokenDeltaAtomic(row.confirmation, { mint: USDC_MINT, owner: session.session_wallet });
      const tokenDelta = getTokenDeltaAtomic(row.confirmation, { mint, owner: session.session_wallet });
      const usdcSpentAtomic = usdcDelta !== null && usdcDelta < 0 ? Math.abs(usdcDelta) : buildAmount(row, 'inAmount');
      const tokenReceivedAtomic = tokenDelta !== null && tokenDelta > 0 ? tokenDelta : buildAmount(row, 'outAmount');
      const decimals = getDecimals(row.confirmation, mint) ?? decimalsByMint.get(mint) ?? 6;
      if (usdcSpentAtomic <= 0 || tokenReceivedAtomic <= 0) continue;
      getLots(mint).push({ quantityAtomic: tokenReceivedAtomic, costBasisUsd: usdcSpentAtomic / 1_000_000, decimals });
      continue;
    }

    if (row.input_mint !== USDC_MINT && row.input_mint !== SOL_MINT && row.output_mint === USDC_MINT) {
      const mint = row.input_mint;
      const lots = getLots(mint);
      const usdcDelta = getTokenDeltaAtomic(row.confirmation, { mint: USDC_MINT, owner: session.session_wallet });
      const tokenDelta = getTokenDeltaAtomic(row.confirmation, { mint, owner: session.session_wallet });
      const usdcReceivedAtomic = usdcDelta !== null && usdcDelta > 0 ? usdcDelta : buildAmount(row, 'outAmount');
      let soldAtomic = tokenDelta !== null && tokenDelta < 0 ? Math.abs(tokenDelta) : Number(row.amount);
      if (usdcReceivedAtomic <= 0 || !Number.isFinite(soldAtomic) || soldAtomic <= 0) continue;

      const originalSoldAtomic = soldAtomic;
      let costBasisSoldUsd = 0;
      while (soldAtomic > 0 && lots.length > 0) {
        const lot = lots[0];
        const takeAtomic = Math.min(soldAtomic, lot.quantityAtomic);
        const fraction = lot.quantityAtomic > 0 ? takeAtomic / lot.quantityAtomic : 0;
        costBasisSoldUsd += lot.costBasisUsd * fraction;
        lot.quantityAtomic -= takeAtomic;
        lot.costBasisUsd -= lot.costBasisUsd * fraction;
        soldAtomic -= takeAtomic;
        if (lot.quantityAtomic <= 0.5) lots.shift();
      }

      const proceedsUsd = usdcReceivedAtomic / 1_000_000;
      const realizedPnlUsd = proceedsUsd - costBasisSoldUsd;
      reconstructedRealizedPnlUsd += realizedPnlUsd;
      realizedEvents.push({
        id: row.id,
        confirmedAt: row.confirmed_at,
        mint,
        soldAtomic: originalSoldAtomic,
        proceedsUsd,
        costBasisSoldUsd,
        realizedPnlUsd,
      });
    }
  }

  const dayKey = new Date().toISOString().slice(0, 10);
  let dailyRealizedPnlUsd = 0;
  let consecutiveLosses = 0;
  let lastLossAt = session.service_control?.riskState?.lastLossAt ?? null;
  for (const event of realizedEvents) {
    const eventDay = new Date(event.confirmedAt).toISOString().slice(0, 10);
    if (event.realizedPnlUsd < 0) {
      consecutiveLosses += 1;
      lastLossAt = new Date(event.confirmedAt).toISOString();
    } else if (event.realizedPnlUsd > 0) {
      consecutiveLosses = 0;
    }
    if (eventDay === dayKey) dailyRealizedPnlUsd += event.realizedPnlUsd;
  }

  const openLots = [...lotsByMint.entries()].map(([mint, lots]) => ({
    mint,
    lots: lots.map((lot) => ({ ...lot })),
    totalQuantityAtomic: lots.reduce((sum, lot) => sum + lot.quantityAtomic, 0),
    remainingCostBasisUsd: lots.reduce((sum, lot) => sum + lot.costBasisUsd, 0),
  })).filter((item) => item.totalQuantityAtomic > 0.5 || item.remainingCostBasisUsd > 0.000001);

  const storedRealizedPnlUsd = Number(session.funding?.realizedPnlUsd ?? 0);
  const nextFunding = {
    ...(session.funding ?? {}),
    realizedPnlUsd: Number(reconstructedRealizedPnlUsd.toFixed(6)),
  };
  const nextServiceControl = {
    ...(session.service_control ?? {}),
    riskState: {
      ...((session.service_control ?? {}).riskState ?? {}),
      dayKey,
      dailyRealizedPnlUsd: Number(dailyRealizedPnlUsd.toFixed(6)),
      consecutiveLosses,
      badFillStreak: (session.service_control ?? {}).riskState?.badFillStreak ?? 0,
      lastLossAt,
      lastBadFillAt: (session.service_control ?? {}).riskState?.lastBadFillAt ?? null,
    },
  };

  const summary = {
    apply: APPLY,
    sessionId: session.id,
    sessionWallet: session.session_wallet,
    confirmedExecutions: execResult.rows.length,
    realizedEvents: realizedEvents.length,
    storedRealizedPnlUsd,
    reconstructedRealizedPnlUsd: nextFunding.realizedPnlUsd,
    deltaUsd: Number((storedRealizedPnlUsd - nextFunding.realizedPnlUsd).toFixed(6)),
    nextRiskState: nextServiceControl.riskState,
    decimalsByMint: Object.fromEntries([...decimalsByMint.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    largestAbsoluteRealizedEvents: [...realizedEvents]
      .sort((left, right) => Math.abs(right.realizedPnlUsd) - Math.abs(left.realizedPnlUsd))
      .slice(0, 15),
    latestRealizedEvents: realizedEvents.slice(-10),
    openLots,
  };

  if (APPLY) {
    await client.query('begin');
    await client.query(`update sessions set funding=$2::jsonb, service_control=$3::jsonb where id=$1`, [session.id, JSON.stringify(nextFunding), JSON.stringify(nextServiceControl)]);
    await client.query('commit');
  }

  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (APPLY) await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}
