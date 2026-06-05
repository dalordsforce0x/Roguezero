import pg from 'pg';
import 'dotenv/config';

const TAKER = '3csv8ehxVPJo4ft3hTxJ4673ddR8kdCBEHf2bVf9aB5t';
const SESSION_ID = '9911f9a2-7072-4048-ad44-b086070145eb';
const START_AT = '2026-06-05T05:13:00Z';
const INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS ?? 30_000);
const url = process.env.DATABASE_PRIVATE_URL?.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require');

if (!url) throw new Error('DATABASE_PRIVATE_URL is required');

const sql = `
  SELECT
    now() AS ts,
    (SELECT row_to_json(q) FROM (
      SELECT status, attempts, locked_by, locked_until, (locked_until < now()) AS expired, last_error
      FROM execution_queue
      ORDER BY updated_at DESC
      LIMIT 1
    ) q) AS queue,
    (SELECT count(*)::int FROM swap_executions WHERE taker = $1 AND created_at > $2::timestamptz) AS recent_swaps,
    (SELECT row_to_json(e) FROM (
      SELECT id, status, input_mint, output_mint, amount, signature, confirmation_status, last_error, created_at
      FROM swap_executions
      WHERE taker = $1 AND created_at > $2::timestamptz
      ORDER BY created_at DESC
      LIMIT 1
    ) e) AS latest_swap,
    (SELECT service_control->'schedulingState'->>'lastDecisionReason' FROM sessions WHERE id = $3) AS decision,
    (SELECT service_control->'lastTradeGate'->>'reason' FROM sessions WHERE id = $3) AS gate,
    (SELECT service_control->'lastTradeGate' FROM sessions WHERE id = $3) AS gate_detail,
    (SELECT jsonb_object_length(service_control->'positionsState'->'positions') FROM sessions WHERE id = $3) AS positions,
    (SELECT service_control->'positionsState'->'positions' FROM sessions WHERE id = $3) AS positions_detail,
    (SELECT funding->>'currentBalanceAtomic' FROM sessions WHERE id = $3) AS usdc_atomic
`;

let lastLine = '';

async function check() {
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60000,
    query_timeout: 60000,
  });

  try {
    await client.connect();
    const result = await client.query(sql, [TAKER, START_AT, SESSION_ID]);
    const row = result.rows[0];
    const line = JSON.stringify(row);
    if (line !== lastLine) {
      console.log(line);
      lastLine = line;
    } else {
      console.log(JSON.stringify({ ts: row.ts, unchanged: true, decision: row.decision, gate: row.gate, positions: row.positions, recent_swaps: row.recent_swaps }));
    }
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  } finally {
    await client.end().catch(() => undefined);
  }
}

await check();
setInterval(check, INTERVAL_MS);
