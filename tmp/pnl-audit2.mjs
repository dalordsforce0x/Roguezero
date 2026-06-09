import pg from 'pg';
import 'dotenv/config';

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');
const url = databaseUrl.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL = 'So11111111111111111111111111111111111111112';

const wallets = {
  '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC': 'A (start 22:35)',
  'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7': 'B (start 21:47)',
  'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW': 'C (start 01:07)',
};

await client.connect();
const { rows } = await client.query(
  `SELECT taker, input_mint, output_mint, status, confirmation, confirmed_at
   FROM swap_executions
   WHERE taker = ANY($1) AND status='confirmed' AND confirmation IS NOT NULL AND confirmed_at IS NOT NULL
   ORDER BY confirmed_at ASC`,
  [Object.keys(wallets)],
);

// token balance delta for a given mint owned by wallet (sum across matching token accounts)
function tokenDelta(conf, mint, owner) {
  const pre = Array.isArray(conf.preTokenBalances) ? conf.preTokenBalances : [];
  const post = Array.isArray(conf.postTokenBalances) ? conf.postTokenBalances : [];
  const sum = (arr) => arr
    .filter((b) => b && b.mint === mint && (!owner || b.owner === owner))
    .reduce((a, b) => a + Number(b.uiTokenAmount?.amount ?? 0), 0);
  return sum(post) - sum(pre);
}

// native SOL lamport delta for wallet
function solDelta(conf, wallet) {
  const keys = Array.isArray(conf.accountKeys) ? conf.accountKeys : [];
  const idx = keys.indexOf(wallet);
  if (idx < 0) return null;
  const pre = Array.isArray(conf.preBalances) ? conf.preBalances : [];
  const post = Array.isArray(conf.postBalances) ? conf.postBalances : [];
  const p = Number(pre[idx] ?? NaN), q = Number(post[idx] ?? NaN);
  if (!Number.isFinite(p) || !Number.isFinite(q)) return null;
  return q - p;
}

const isStable = (m) => m === USDC || m === USDT;

for (const wallet of Object.keys(wallets)) {
  const wr = rows.filter((r) => r.taker === wallet);
  const inv = new Map(); // mint -> {qty, cost}
  let realized = 0, stableSpent = 0, stableReceived = 0;
  let nBuy = 0, nSell = 0, nUnpaired = 0, nOther = 0;

  for (const r of wr) {
    const conf = r.confirmation;
    const inStable = isStable(r.input_mint);
    const outStable = isStable(r.output_mint);

    if (inStable && !outStable) {
      // BUY token: stable out, token in. cost = actual stable spent
      const stableD = tokenDelta(conf, r.input_mint, wallet); // negative
      const costUsd = Math.abs(stableD) / 1e6;
      let tokenIn;
      if (r.output_mint === SOL) {
        const d = solDelta(conf, wallet); tokenIn = d == null ? 0 : d; // includes fee noise
      } else {
        tokenIn = tokenDelta(conf, r.output_mint, wallet);
      }
      if (costUsd <= 0 || tokenIn <= 0) { nOther++; continue; }
      stableSpent += costUsd;
      const cur = inv.get(r.output_mint) ?? { qty: 0, cost: 0 };
      cur.qty += tokenIn; cur.cost += costUsd; inv.set(r.output_mint, cur);
      nBuy++;
    } else if (!inStable && outStable) {
      // SELL token: token out, stable in. proceeds = actual stable received
      const stableD = tokenDelta(conf, r.output_mint, wallet); // positive
      const proceedsUsd = Math.abs(stableD) / 1e6;
      let tokenOut;
      if (r.input_mint === SOL) {
        const d = solDelta(conf, wallet); tokenOut = d == null ? 0 : Math.abs(Math.min(0, d));
      } else {
        tokenOut = Math.abs(tokenDelta(conf, r.input_mint, wallet));
      }
      if (proceedsUsd <= 0) { nOther++; continue; }
      stableReceived += proceedsUsd;
      const cur = inv.get(r.input_mint);
      if (cur && cur.qty > 0 && tokenOut > 0) {
        const frac = Math.min(1, tokenOut / cur.qty);
        const costSold = cur.cost * frac;
        realized += proceedsUsd - costSold;
        cur.qty = Math.max(0, cur.qty - tokenOut);
        cur.cost = Math.max(0, cur.cost - costSold);
        if (cur.qty <= 0) inv.delete(r.input_mint);
        nSell++;
      } else {
        realized += proceedsUsd; // no cost basis -> treat as windfall (flag)
        nUnpaired++;
      }
    } else {
      nOther++;
    }
  }

  let openCost = 0; for (const v of inv.values()) openCost += v.cost;
  console.log(`\n=== Session ${wallets[wallet]}  ${wallet} ===`);
  console.log(`  confirmed: ${wr.length}  buys: ${nBuy}  sells: ${nSell}  unpaired-sells: ${nUnpaired}  other/skipped: ${nOther}`);
  console.log(`  stable spent:    $${stableSpent.toFixed(2)}`);
  console.log(`  stable received: $${stableReceived.toFixed(2)}`);
  console.log(`  net stable flow: $${(stableReceived - stableSpent).toFixed(2)}`);
  console.log(`  FIFO realized PnL (real fills): $${realized.toFixed(2)}`);
  console.log(`  open inventory cost (still held): $${openCost.toFixed(2)} in ${inv.size} tokens`);
}

await client.end();
