require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const SESSIONS = {
  'b1019831-6779-45d1-baf0-693ca610c93a': 'b1019831',
  'a51f955c-2fb2-4acb-bb9d-9500ed35b928': 'a51f955c',
};
(async () => {
  for (const [id, name] of Object.entries(SESSIONS)) {
    // last decision, last swap, open positions
    const lastDec = await p.query(
      `select max(created_at) t from exit_shadow_decisions where session_id=$1`, [id]);
    const s = await p.query(
      `select session_wallet, user_control->>'desiredState' desired, status,
              service_control->'positionState' pos,
              service_control->>'lastError' err,
              service_control->>'schedulingState' sched
       from sessions where id=$1`, [id]);
    const r = s.rows[0];
    const lastSwap = await p.query(
      `select max(created_at) t, count(*) n from swap_executions where taker=$1`, [r.session_wallet]);
    const open = await p.query(
      `select symbol, mint, token_class, pnl_bps, created_at
       from exit_shadow_decisions where session_id=$1
       order by created_at desc limit 5`, [id]);
    const minsDec = lastDec.rows[0].t ? ((Date.now()-Date.parse(lastDec.rows[0].t))/60000).toFixed(0) : 'never';
    const minsSwap = lastSwap.rows[0].t ? ((Date.now()-Date.parse(lastSwap.rows[0].t))/60000).toFixed(0) : 'never';
    console.log(`\n===== ${name} =====`);
    console.log(`  status=${r.status} desiredState=${r.desired}`);
    console.log(`  last decision: ${minsDec} min ago   last swap: ${minsSwap} min ago`);
    console.log(`  lastError: ${r.err ?? 'none'}`);
    const pos = r.pos;
    if (pos && pos.positions) {
      const keys = Object.keys(pos.positions);
      console.log(`  open positions: ${keys.length}`);
      for (const k of keys) {
        const pp = pos.positions[k];
        console.log(`    ${pp.positionSymbol ?? k.slice(0,6)} entry=${pp.entryPriceUsd} qty=${pp.quantityAtomic ?? '?'} status=${pp.status}`);
      }
    } else {
      console.log(`  open positions: none/flat`);
    }
    console.log(`  recent decision rows:`);
    for (const x of open.rows) {
      console.log(`    ${new Date(x.created_at).toISOString().slice(11,19)} ${x.symbol} ${x.token_class} pnl=${x.pnl_bps}`);
    }
  }
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
