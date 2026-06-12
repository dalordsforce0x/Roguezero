require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

pool.query(
  `UPDATE swap_executions SET blockhash = NULL, recommended_compute_unit_limit = NULL WHERE blockhash = '' OR recommended_compute_unit_limit = 0`
).then(r => {
  console.log('updated', r.rowCount, 'rows');
  pool.end();
}).catch(e => {
  console.error(e.message);
  pool.end();
});
