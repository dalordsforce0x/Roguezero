import 'dotenv/config';
import pg from 'pg';
import { Connection, PublicKey } from '@solana/web3.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL_USD_APPROX = Number(process.env.FEE_VERIFY_SOL_USD ?? 67.5);

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require');
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');

const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

const symbolForMint = (mint) => mint === SOL ? 'SOL' : mint === USDC ? 'USDC' : mint === USDT ? 'USDT' : 'ALT';
const keyAt = (tx, index) => {
  const key = tx.accountKeys?.[index];
  if (typeof key === 'string') return key;
  return key?.pubkey?.toString?.() ?? String(key);
};

const tokenDelta = (tx, mint, accountAddress) => {
  const pre = tx.preTokenBalances ?? tx.meta?.preTokenBalances ?? [];
  const post = tx.postTokenBalances ?? tx.meta?.postTokenBalances ?? [];
  const indexes = new Set(
    [...pre, ...post]
      .filter((balance) => balance.mint === mint && keyAt(tx, balance.accountIndex) === accountAddress)
      .map((balance) => balance.accountIndex),
  );

  let total = 0n;
  for (const index of indexes) {
    const before = pre.find((balance) => balance.accountIndex === index && balance.mint === mint);
    const after = post.find((balance) => balance.accountIndex === index && balance.mint === mint);
    const beforeAmount = BigInt(before?.uiTokenAmount?.amount ?? '0');
    const afterAmount = BigInt(after?.uiTokenAmount?.amount ?? '0');
    total += afterAmount - beforeAmount;
  }

  return Number(total);
};

const lamportDelta = (tx, accountAddress) => {
  const index = (tx.accountKeys ?? []).findIndex((_, accountIndex) => keyAt(tx, accountIndex) === accountAddress);
  if (index < 0) return 0;
  const preBalances = tx.preBalances ?? tx.meta?.preBalances ?? [];
  const postBalances = tx.postBalances ?? tx.meta?.postBalances ?? [];
  return Number(postBalances[index] ?? 0) - Number(preBalances[index] ?? 0);
};

const quotedSolUsdPrice = (row) => {
  const buildResponse = row.build_response ?? {};
  const inputAtomic = Number(buildResponse.inAmount ?? row.amount);
  const outputAtomic = Number(buildResponse.outAmount ?? NaN);

  if (!Number.isFinite(inputAtomic) || !Number.isFinite(outputAtomic) || inputAtomic <= 0 || outputAtomic <= 0) {
    return null;
  }

  if (row.input_mint === SOL && row.output_mint === USDC) {
    return (outputAtomic / 1e6) / (inputAtomic / 1e9);
  }

  if (row.input_mint === USDC && row.output_mint === SOL) {
    return (inputAtomic / 1e6) / (outputAtomic / 1e9);
  }

  return null;
};

const usdFromActual = (row, atomic) => {
  const feeToken = row.fee_token_symbol;
  if (feeToken === 'USDC' || feeToken === 'USDT') return atomic / 1e6;
  if (feeToken === 'SOL') return (atomic / 1e9) * (quotedSolUsdPrice(row) ?? SOL_USD_APPROX);
  return 0;
};

await client.connect();
try {
  const result = await client.query(`
    SELECT id, status, signature, taker, fee_token_symbol, fee_account,
           input_mint, output_mint, amount, confirmation, confirmed_at
      FROM swap_executions
     WHERE status = 'confirmed'
     ORDER BY confirmed_at ASC
  `);

  let usdcAtomic = 0;
  let usdtAtomic = 0;
  let solAtomic = 0;
  const rows = [];
  const sessions = new Map();

  for (const row of result.rows) {
    const tx = typeof row.confirmation === 'string' ? JSON.parse(row.confirmation) : row.confirmation;
    const feeMint = row.fee_token_symbol === 'USDC' ? USDC : row.fee_token_symbol === 'USDT' ? USDT : SOL;
    const tokenBalanceDelta = tokenDelta(tx, feeMint, row.fee_account);
    const fallbackLamportDelta = row.fee_token_symbol === 'SOL' && tokenBalanceDelta === 0
      ? lamportDelta(tx, row.fee_account)
      : 0;
    const feeAtomic = Math.max(0, tokenBalanceDelta || fallbackLamportDelta);

    if (row.fee_token_symbol === 'USDC') usdcAtomic += feeAtomic;
    if (row.fee_token_symbol === 'USDT') usdtAtomic += feeAtomic;
    if (row.fee_token_symbol === 'SOL') solAtomic += feeAtomic;

    const feeUsdActual = usdFromActual(row, feeAtomic);
    rows.push({
      id: row.id.slice(0, 8),
      sig: row.signature?.slice(0, 8) ?? null,
      feeToken: row.fee_token_symbol,
      route: `${symbolForMint(row.input_mint)}->${symbolForMint(row.output_mint)}`,
      amount: row.amount,
      feeAtomic,
      feeUsdActual: Number(feeUsdActual.toFixed(6)),
      feeUsdIfMisreadAsUsdc: Number((feeAtomic / 1e6).toFixed(6)),
      confirmedAt: row.confirmed_at,
    });

    const session = sessions.get(row.taker) ?? { wallet: row.taker, totalUsdApprox: 0, rows: 0 };
    session.totalUsdApprox += feeUsdActual;
    session.rows += 1;
    sessions.set(row.taker, session);
  }

  console.table(rows);
  console.log(JSON.stringify({
    confirmedRows: result.rows.length,
    solUsdApprox: SOL_USD_APPROX,
    usdcFeeAtomic: usdcAtomic,
    usdcFeeUsd: usdcAtomic / 1e6,
    usdtFeeAtomic: usdtAtomic,
    usdtFeeUsd: usdtAtomic / 1e6,
    solFeeLamports: solAtomic,
    solFeeUsdApprox: (solAtomic / 1e9) * SOL_USD_APPROX,
    totalActualUsdApprox: (usdcAtomic / 1e6) + (usdtAtomic / 1e6) + ((solAtomic / 1e9) * SOL_USD_APPROX),
    totalIfSolMisreadAsUsdc: (usdcAtomic / 1e6) + (usdtAtomic / 1e6) + (solAtomic / 1e6),
  }, null, 2));
  console.table([...sessions.values()].map((session) => ({
    wallet: session.wallet,
    rows: session.rows,
    totalUsdApprox: Number(session.totalUsdApprox.toFixed(6)),
  })));

  if (process.env.HELIUS_RPC_URL) {
    const connection = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
    const accounts = [
      process.env.JUPITER_FEE_ACCOUNT_USDC,
      process.env.JUPITER_FEE_ACCOUNT_SOL,
      process.env.JUPITER_FEE_ACCOUNT_USDT,
    ].filter(Boolean);

    for (const account of accounts) {
      const balance = await connection.getTokenAccountBalance(new PublicKey(account)).catch((error) => ({ error: String(error) }));
      console.log('TOKEN_ACCOUNT_BALANCE', account, JSON.stringify(balance));
    }
  }
} finally {
  await client.end();
}
