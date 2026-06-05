import "dotenv/config";
import pg from "pg";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const sid = "3951496c-5459-4298-8369-fb873e2ef613";
const reconstructedPnl = -0.582221;
await pool.query('begin');
const before = await pool.query(`select status, funding->>'realizedPnlUsd' as pnl, service_control->'schedulingState'->>'transferredProfitUsd' as transferred from sessions where id=$1 for update`, [sid]);
console.log('before', before.rows[0]);
await pool.query(`update sessions
set funding = jsonb_set(funding, '{realizedPnlUsd}', to_jsonb($2::numeric), true),
    service_control = jsonb_set(
      jsonb_set(service_control, '{riskState,dailyRealizedPnlUsd}', to_jsonb($2::numeric), true),
      '{riskState,lastLossAt}', to_jsonb(now()::text), true
    )
where id=$1`, [sid, reconstructedPnl]);
const after = await pool.query(`select status, funding->>'realizedPnlUsd' as pnl, service_control->'riskState' as risk, service_control->'schedulingState'->>'transferredProfitUsd' as transferred from sessions where id=$1`, [sid]);
console.log('after', JSON.stringify(after.rows[0], null, 2));
await pool.query('commit');
await pool.end();
