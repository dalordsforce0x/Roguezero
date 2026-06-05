require('dotenv').config();
const pg = require('pg');
const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');
const url = new URL(databaseUrl);
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
pool.query(`SELECT id, status, signature, confirmation_status, confirmed_at, last_error->>'stage' as err_stage, last_error->>'reason' as err_reason, created_at FROM swap_executions WHERE status = 'confirmed' OR signature IS NOT NULL ORDER BY created_at DESC LIMIT 10`)
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); pool.end(); })
  .catch(e => { console.error(e.message); pool.end(); });
