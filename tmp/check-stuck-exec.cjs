require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

pool.query(
  `SELECT id, status, swap_path, blockhash, recommended_compute_unit_limit, created_at
   FROM swap_executions
   WHERE status IN ('prepared','submitted')
   ORDER BY created_at DESC LIMIT 5`
).then(r => {
  console.log(JSON.stringify(r.rows, null, 2));
  pool.end();
}).catch(e => {
  console.error(e.message);
  pool.end();
});
