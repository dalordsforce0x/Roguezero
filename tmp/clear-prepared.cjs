require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

pool.query("UPDATE swap_executions SET status = 'failed', last_error = '{\"stage\":\"manual\",\"reason\":\"stale_prepared_cleared\"}' WHERE status = 'prepared'")
  .then(r => {
    console.log('cleared', r.rowCount, 'prepared rows');
    pool.end();
  })
  .catch(e => { console.error(e.message); pool.end(); });
