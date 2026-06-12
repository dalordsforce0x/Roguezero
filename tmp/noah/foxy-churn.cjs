require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const FOXY = 'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7';
const SOL='So11111111111111111111111111111111111111112', USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sym=m=>m===SOL?'SOL':m===USDC?'USDC':(m?m.slice(0,4):'?');
(async () => {
  // Full Foxy tape last 90 min, ordered ascending, with amount + how long since prev
  const r = await p.query(
    `SELECT e.status, e.input_mint, e.output_mint, e.amount, e.metadata, e.last_error,
            e.created_at, e.confirmed_at
     FROM swap_executions e
     WHERE e.taker=$1 AND e.created_at >= now() - interval '90 minutes'
     ORDER BY e.created_at ASC`, [FOXY]);
  console.log(`Foxy tape, last 90 min (${r.rows.length} rows):\n`);
  console.log('TIME      STATUS     ROUTE       AMOUNT          TAG                    held/gap');
  let lastBuy=null;
  for (const x of r.rows) {
    const m=x.metadata||{};
    const tag = m.exitReason?`exit·${m.exitReason}`:m.entryStrategy?`entry·${m.entryStrategy}`:'reconcile';
    const t=(x.confirmed_at||x.created_at);
    let gap='';
    const buying = x.output_mint===SOL;
    if (buying){ lastBuy=t; }
    else if (x.input_mint===SOL && lastBuy){ gap=`held ${Math.round((t-lastBuy)/1000)}s`; }
    console.log(
      `${t.toISOString().slice(11,19)}  ${String(x.status).padEnd(9)}  ${(sym(x.input_mint)+'->'+sym(x.output_mint)).padEnd(10)}  ${String(x.amount).padStart(14)}  ${tag.padEnd(22)}  ${gap}`);
  }

  // count confirmed buys vs confirmed sells
  const c = await p.query(
    `SELECT count(*) filter (where output_mint=$2 and status='confirmed') buys,
            count(*) filter (where input_mint=$2 and status='confirmed') sells,
            count(*) filter (where last_error->>'stage'='worker_cancel') cancels
     FROM swap_executions WHERE taker=$1 AND created_at >= now() - interval '90 minutes'`,
    [FOXY, SOL]);
  console.log('\nConfirmed SOL buys:', c.rows[0].buys, ' SOL sells:', c.rows[0].sells, ' worker_cancels:', c.rows[0].cancels);
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
