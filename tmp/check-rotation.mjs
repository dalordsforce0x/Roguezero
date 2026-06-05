import "dotenv/config";
import pg from "pg";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const sid = "3951496c-5459-4298-8369-fb873e2ef613";
const r = await pool.query(`select
  service_control->'rotationState' as rot,
  service_control->'lastSignal'->>'strategy' as sig_strategy,
  service_control->'lastSignal'->>'regime' as regime,
  service_control->'positionsState'->'positions' as positions
  from sessions where id=$1`, [sid]);
console.log("rotationState:", JSON.stringify(r.rows[0].rot));
console.log("lastSignal.strategy:", r.rows[0].sig_strategy, "regime:", r.rows[0].regime);
const pos = r.rows[0].positions || {};
console.log("open positions count:", Object.keys(pos).length, "mints:", Object.keys(pos).map(m=>m.slice(0,4)).join(","));
await pool.end();
