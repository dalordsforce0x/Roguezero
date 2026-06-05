import "dotenv/config";
import pg from "pg";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await pool.query(`update execution_queue
  set status='pending', locked_by=null, locked_until=null, available_at=now(), updated_at=now()
  where id=$1 and status='running'`, ['22ea95ff-b690-4dde-b340-9363db394960']);
const q = await pool.query(`select id,status,attempts,available_at,locked_by,locked_until,last_error from execution_queue where id=$1`, ['22ea95ff-b690-4dde-b340-9363db394960']);
console.log(JSON.stringify(q.rows[0], null, 2));
await pool.end();
