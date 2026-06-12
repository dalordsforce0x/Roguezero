require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const SESSIONS = {
  'edd46e65-b21d-4d99-911d-99842d62b428': 'Noah',
  'b1019831-6779-45d1-baf0-693ca610c93a': 'b1019831',
  'a51f955c-2fb2-4acb-bb9d-9500ed35b928': 'a51f955c',
};
(async () => {
  for (const [id, name] of Object.entries(SESSIONS)) {
    const s = await p.query(
      `select status, started_at,
              funding->>'fundingMint' base,
              funding->>'startingBalanceAtomic' start_atomic,
              funding->>'realizedPnlUsd' realized,
              funding->>'capturedFeesUsd' fees,
              service_control->>'platformFeeBps' feebps,
              user_control->>'profitHandling' profit,
              session_wallet
       from sessions where id=$1`, [id]);
    const r = s.rows[0];
    if (!r) { console.log(`${name}: NOT FOUND`); continue; }
    const ageH = ((Date.now() - Date.parse(r.started_at)) / 3600000).toFixed(1);
    console.log(`\n===== ${name} (${id.slice(0,8)}) =====`);
    console.log(`  status=${r.status} base=${r.base==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'?'USDC':r.base==='So11111111111111111111111111111111111111112'?'SOL':r.base} profit=${r.profit} age=${ageH}h`);
    console.log(`  realizedPnlUsd (ALL-TIME)=$${Number(r.realized).toFixed(2)}  capturedFees=$${Number(r.fees||0).toFixed(2)}  feeBps=${r.feebps}`);

    // confirmed trades this session
    const t = await p.query(
      `select count(*) confirmed,
              count(*) filter (where (build_response->>'inAmount') is not null) priced
       from swap_executions where taker=$1 and status='confirmed' and created_at >= $2`,
      [r.session_wallet, r.started_at]);
    // recent decisions (last 2h) from exit_shadow_decisions: what is it deciding
    const d = await p.query(
      `select coalesce(symbol,'?') sym, coalesce(token_class,'?') tc,
              evaluation->>'strategy' strat, current_reason, current_should_exit,
              pnl_bps, created_at
       from exit_shadow_decisions
       where session_id=$1 and created_at >= now() - interval '90 minutes'
       order by created_at desc limit 8`, [id]);
    console.log(`  confirmed swaps this session: ${t.rows[0].confirmed}`);
    console.log(`  recent decisions (last 90m):`);
    if (!d.rows.length) console.log('    (none in last 90m)');
    for (const x of d.rows) {
      console.log(`    ${new Date(x.created_at).toISOString().slice(11,19)} ${String(x.sym).padEnd(6)} ${String(x.tc).padEnd(11)} ${String(x.strat||'?').padEnd(14)} ${x.current_should_exit?'EXIT':'hold'} ${String(x.current_reason||'').padEnd(15)} pnl=${x.pnl_bps}`);
    }
  }
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
