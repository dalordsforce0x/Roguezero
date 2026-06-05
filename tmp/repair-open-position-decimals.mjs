import "dotenv/config";
import pg from "pg";
const sid = "3951496c-5459-4298-8369-fb873e2ef613";
const mint = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await pool.query(`
update sessions
set service_control = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(service_control, array['positionsState','positions',$2,'tokenDecimals'], to_jsonb(9), true),
      array['positionsState','positions',$2,'lastMarkedPriceUsd'], 'null'::jsonb, true
    ),
    array['positionsState','positions',$2,'lastMarkedAt'], 'null'::jsonb, true
  ),
  '{positionState}', (service_control->'positionsState'->'positions'->$2), true
)
where id=$1`, [sid, mint]);
const r = await pool.query(`select status, funding, service_control->'positionsState' as positions, service_control->'positionState' as summary from sessions where id=$1`, [sid]);
console.log(JSON.stringify(r.rows[0], null, 2));
await pool.end();
