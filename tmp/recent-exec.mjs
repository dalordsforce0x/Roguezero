import "dotenv/config";
import pg from "pg";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const w = "DFcBDWuR4jr8Z4LMH2j2UWs5axKpC3ja7WL4TrQMJxJb";
const r = await pool.query(`select status, swap_path, input_mint, output_mint, amount, signature, confirmation_status,
  created_at, confirmed_at, last_error->>'reason' as reason, last_error->>'stage' as stage
  from swap_executions where taker=$1 order by created_at desc limit 10`, [w]);
for (const x of r.rows) {
  console.log(x.created_at.toISOString(), x.status, x.swap_path||'',
    (x.input_mint||'').slice(0,4)+'->'+(x.output_mint||'').slice(0,4),
    'sig:', x.signature ? x.signature.slice(0,14)+'...' : '-',
    'conf:', x.confirmation_status||'-', x.stage?('['+x.stage+':'+x.reason+']'):'');
}
await pool.end();
