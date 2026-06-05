import "dotenv/config";
import pg from "pg";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const sid = "3951496c-5459-4298-8369-fb873e2ef613";
const w = "DFcBDWuR4jr8Z4LMH2j2UWs5axKpC3ja7WL4TrQMJxJb";
const f = await pool.query(`select funding->>'realizedPnlUsd' as pnl,
  service_control->'positionsState' as pos,
  service_control->'lastSignal' as sig from sessions where id=$1`, [sid]);
console.log("realizedPnlUsd:", f.rows[0].pnl);
console.log("positionsState:", JSON.stringify(f.rows[0].pos));
console.log("lastSignal:", JSON.stringify(f.rows[0].sig));
const r = await pool.query(`select status, swap_path, input_mint, output_mint, amount, signature,
  confirmed_at, metadata from swap_executions where taker=$1 and signature is not null order by created_at desc limit 2`, [w]);
for (const x of r.rows) {
  console.log("---", x.swap_path, (x.input_mint||'').slice(0,4)+'->'+(x.output_mint||'').slice(0,4), "amount:", x.amount, "sig:", x.signature);
  console.log("   metadata:", JSON.stringify(x.metadata));
}
await pool.end();
