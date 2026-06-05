import "dotenv/config";
import pg from "pg";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const wallet = "DFcBDWuR4jr8Z4LMH2j2UWs5axKpC3ja7WL4TrQMJxJb";
const r = await pool.query(`select id,status,signature from swap_executions where taker=$1 and status='confirmed' order by created_at desc limit 1`, [wallet]);
const id = r.rows[0].id;
console.log('Reconciling', id);
const res = await fetch(`http://localhost:4000/jupiter/swap/executions/${id}/reconcile`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-rz-internal-secret': process.env.RZ_INTERNAL_SECRET ?? '' },
  body: '{}',
});
console.log('HTTP', res.status, await res.text());
await pool.end();
