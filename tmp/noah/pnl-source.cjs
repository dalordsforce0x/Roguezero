require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const SESS = {
  'Foxy':     'b1019831-6779-45d1-baf0-693ca610c93a',
  'Noah':     'edd46e65-b21d-4d99-911d-99842d62b428',
  'RogueCEO': 'a51f955c-2fb2-4acb-bb9d-9500ed35b928',
};

(async () => {
  for (const [name, id] of Object.entries(SESS)) {
    const r = await pool.query(
      `SELECT status,
              (funding->>'realizedPnlUsd')::double precision realized,
              (funding->>'unrealizedPnlUsd')::double precision unreal,
              (funding->>'capturedFeesUsd')::double precision fees,
              funding->>'fundingMint' base,
              (funding->>'currentBalanceUsd')::double precision bal
         FROM sessions WHERE id=$1`, [id]);
    if (!r.rows.length) { console.log(`${name}: not found`); continue; }
    const x = r.rows[0];
    const real = x.realized ?? 0, un = x.unreal ?? 0;
    console.log(`${name.padEnd(9)} status=${String(x.status).padEnd(8)} realized=$${real.toFixed(2)} unrealized=$${(un).toFixed(2)} total=$${(real+un).toFixed(2)} fees=$${(x.fees??0).toFixed(2)} bal=$${(x.bal??0).toFixed(2)}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
