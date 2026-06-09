require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const { rows } = await pool.query(`
    select id, owner_wallet, status,
           user_control->'profitHandling' as profit_handling,
           funding->>'fundingMint' as funding_mint,
           funding->>'fundingTokenSymbol' as funding_symbol
    from sessions
    where status in ('active','ready','starting','stopping','awaiting_funding')
    order by requested_at desc
  `);
  for (const r of rows) {
    console.log(JSON.stringify(r));
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
