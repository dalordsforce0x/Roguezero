require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

pool.query("SELECT id, status, created_at FROM swap_executions WHERE status = 'prepared' ORDER BY created_at DESC LIMIT 10")
  .then(r => {
    console.log(r.rows.length, 'prepared rows');
    r.rows.forEach(x => console.log(x.id, x.status, x.created_at));
    pool.end();
  })
  .catch(e => { console.error(e.message); pool.end(); });
