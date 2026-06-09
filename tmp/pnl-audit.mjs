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
  '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC': 'A (started 22:35)',
  'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7': 'B (started 21:47)',
  'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW': 'C (started 01:07)',
};

await client.connect();

const { rows } = await client.query(
  `SELECT taker, input_mint, output_mint, status, build_response, confirmation, amount, confirmed_at
   FROM swap_executions
   WHERE taker = ANY($1) AND status='confirmed' AND confirmed_at IS NOT NULL
   ORDER BY confirmed_at ASC`,
  [Object.keys(wallets)],
);

// Use actual on-chain wallet balance deltas where possible, fall back to quoted build amounts.
const buildAmt = (br, key) => {
  const v = br?.[key];
  const n = typeof v === 'string' ? Number(v) : Number(v ?? NaN);
  return Number.isFinite(n) ? n : 0;
};

const usdValue = (mint, atomic) => {
  if (mint === USDC || mint === USDT) return atomic / 1e6;
  return null; // non-stable handled via inventory
};

for (const wallet of Object.keys(wallets)) {
  const wr = rows.filter((r) => r.taker === wallet);
  // inventory per token mint: { qtyAtomic, costUsd }
  const inv = new Map();
  let realized = 0;
  let stableSpent = 0; // USDC/USDT put into tokens
  let stableReceived = 0; // USDC/USDT pulled out of tokens
  let nBuys = 0, nSells = 0, nUnpaired = 0;

  for (const r of wr) {
    const inAtomic = buildAmt(r.build_response, 'inAmount') || Number(r.amount) || 0;
    const outAtomic = buildAmt(r.build_response, 'outAmount') || 0;
    const inStable = r.input_mint === USDC || r.input_mint === USDT;
    const outStable = r.output_mint === USDC || r.output_mint === USDT;

    if (inStable && !outStable) {
      // BUY token with stable
      const costUsd = inAtomic / 1e6;
      stableSpent += costUsd;
      const cur = inv.get(r.output_mint) ?? { qty: 0, cost: 0 };
      cur.qty += outAtomic;
      cur.cost += costUsd;
      inv.set(r.output_mint, cur);
      nBuys++;
    } else if (!inStable && outStable) {
      // SELL token for stable
      const proceedsUsd = outAtomic / 1e6;
      stableReceived += proceedsUsd;
      const cur = inv.get(r.input_mint);
      if (cur && cur.qty > 0) {
        const frac = Math.min(1, inAtomic / cur.qty);
        const costSold = cur.cost * frac;
        realized += proceedsUsd - costSold;
        cur.qty = Math.max(0, cur.qty - inAtomic);
        cur.cost = Math.max(0, cur.cost - costSold);
        if (cur.qty <= 0) inv.delete(r.input_mint);
        nSells++;
      } else {
        // exit with no recorded entry (bootstrap / SOL-funded). Count proceeds as pure realized? mark unpaired.
        realized += proceedsUsd; // no cost basis known
        nUnpaired++;
      }
    } else {
      // stable<->stable or token<->token, ignore for stable-denominated pnl
    }
  }

  // remaining open inventory cost (unrealized capital still in tokens)
  let openCost = 0;
  for (const v of inv.values()) openCost += v.cost;

  console.log(`\n=== Session ${wallets[wallet]}  ${wallet} ===`);
  console.log(`  confirmed execs: ${wr.length}  buys: ${nBuys}  sells: ${nSells}  unpaired-sells: ${nUnpaired}`);
  console.log(`  stable spent on tokens:    $${stableSpent.toFixed(2)}`);
  console.log(`  stable received from sells:$${stableReceived.toFixed(2)}`);
  console.log(`  net stable flow (recv-spent): $${(stableReceived - stableSpent).toFixed(2)}`);
  console.log(`  FIFO realized PnL:         $${realized.toFixed(2)}`);
  console.log(`  open inventory cost basis: $${openCost.toFixed(2)} (still held in ${inv.size} tokens)`);
}

await client.end();
