import "dotenv/config";
import pg from "pg";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const sid = "3951496c-5459-4298-8369-fb873e2ef613";
const r = await pool.query(`select
  service_control->'lastTradeGate' as gate,
  service_control->'schedulingState'->>'lastDecisionReason' as reason,
  service_control->'schedulingState'->'blockedReasonCounts' as counts,
  service_control->'lastSizing'->>'reason' as sizing_reason,
  service_control->'lastSizing'->'tradeContext'->>'inputSymbol' as in_sym,
  service_control->'lastSizing'->'tradeContext'->>'outputSymbol' as out_sym,
  service_control->'lastSizing'->'tradeContext'->>'amountAtomic' as amt,
  service_control->'lastSignal'->>'strategy' as sig_strategy,
  service_control->'lastSignal'->>'regime' as sig_regime
  from sessions where id=$1`, [sid]);
const x = r.rows[0];
console.log("lastDecisionReason:", x.reason);
console.log("sizing:", x.in_sym, "->", x.out_sym, "amt:", x.amt, "reason:", x.sizing_reason);
console.log("lastSignal strategy:", x.sig_strategy, "regime:", x.sig_regime);
console.log("gate:", JSON.stringify(x.gate));
console.log("blockedReasonCounts:", JSON.stringify(x.counts));
await pool.end();
