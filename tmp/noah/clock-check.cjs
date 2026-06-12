require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  // raw timestamptz — node-pg parses to correct absolute instant
  const r = await pool.query(`SELECT now() AS ts, extract(epoch from now()) AS epoch`);
  console.log('DB now() timestamptz .toISOString():', r.rows[0].ts.toISOString());
  console.log('DB now() epoch seconds          :', Number(r.rows[0].epoch));
  console.log('Local machine epoch seconds     :', Math.floor(Date.now()/1000));
  const skew = Math.floor(Date.now()/1000) - Number(r.rows[0].epoch);
  console.log('Skew (local - DB) seconds       :', skew);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
