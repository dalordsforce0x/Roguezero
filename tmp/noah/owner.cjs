require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
p.query(`select owner_wallet, session_wallet from sessions where id='edd46e65-b21d-4d99-911d-99842d62b428'`)
  .then(r => { console.log('Noah owner_wallet :', r.rows[0].owner_wallet); console.log('Noah session_wallet:', r.rows[0].session_wallet); return p.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });
