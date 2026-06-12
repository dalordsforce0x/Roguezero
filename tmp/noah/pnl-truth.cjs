require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const { rows } = await pool.query(`
    SELECT id, status, user_id, owner_wallet, session_wallet, base_mint,
           funding,
           service_control->'lastSizing'->'tradeContext'->>'inputSymbol' as base_sym,
           started_at
    FROM sessions
    WHERE status IN ('active','starting','paused','stopping')
    ORDER BY started_at DESC
  `);
  for (const r of rows) {
    const f = r.funding || {};
    console.log('=== ', r.id.slice(0,8), r.status, ' user=', r.user_id, '===');
    console.log('   base_mint:', r.base_mint, ' base_sym:', r.base_sym);
    console.log('   funding keys:', Object.keys(f).join(', '));
    console.log('   realizedPnlUsd   :', f.realizedPnlUsd);
    console.log('   unrealizedPnlUsd :', f.unrealizedPnlUsd);
    console.log('   fundedAmountUsd  :', f.fundedAmountUsd ?? f.fundedUsd ?? f.initialUsd);
    console.log('   currentValueUsd  :', f.currentValueUsd ?? f.currentBalanceUsd);
    console.log('   feesGeneratedUsd :', f.feesGeneratedUsd ?? f.platformFeesUsd);
    console.log('');
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
