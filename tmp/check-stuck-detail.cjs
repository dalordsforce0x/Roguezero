require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

pool.query(
  `SELECT * FROM swap_executions WHERE id = '02e48ecb-db49-4db9-a365-65d6e031ebc6'`
).then(r => {
  const row = r.rows[0];
  console.log(JSON.stringify(row, null, 2));
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  console.log('Age (seconds):', Math.round(ageMs / 1000));
  pool.end();
}).catch(e => {
  console.error(e.message);
  pool.end();
});
