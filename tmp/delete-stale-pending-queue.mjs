import "dotenv/config";
import pg from "pg";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await pool.query(`delete from execution_queue where id=$1 and status='pending'`, ['22ea95ff-b690-4dde-b340-9363db394960']);
const q = await pool.query(`select id,status,attempts,locked_by,locked_until,last_error,created_at from execution_queue where session_id=$1 order by created_at`, ['3951496c-5459-4298-8369-fb873e2ef613']);
console.log(JSON.stringify(q.rows, null, 2));
await pool.end();
