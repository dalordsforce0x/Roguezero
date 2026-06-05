import "dotenv/config";
import pg from "pg";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const sid = "3951496c-5459-4298-8369-fb873e2ef613";
const s = await pool.query(`select id,status,owner_wallet,session_wallet,funding,service_control from sessions where id=$1`, [sid]);
console.log("SESSION", JSON.stringify({
  id:s.rows[0]?.id,
  status:s.rows[0]?.status,
  wallet:s.rows[0]?.session_wallet,
  funding:s.rows[0]?.funding,
  scheduling:s.rows[0]?.service_control?.schedulingState,
  positions:s.rows[0]?.service_control?.positionsState,
  lastSignal:s.rows[0]?.service_control?.lastSignal,
  lastGate:s.rows[0]?.service_control?.lastTradeGate
}, null, 2));
const ex = await pool.query(`select id,status,input_mint,output_mint,amount,signature,created_at,confirmed_at,build_response,confirmation,metadata from swap_executions where taker=$1 order by created_at desc limit 8`, [s.rows[0]?.session_wallet]);
for (const r of ex.rows) console.log("EXEC", r.created_at.toISOString(), r.status, r.input_mint?.slice(0,4)+"->"+r.output_mint?.slice(0,4), r.amount, r.signature, JSON.stringify(r.metadata));
await pool.end();
