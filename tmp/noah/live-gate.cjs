require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const { rows } = await pool.query(`
    SELECT id, status,
           service_control->'lastTradeGate' as gate,
           service_control->'lastSizing'->'tradeContext' as sizing,
           service_control->'lastSignal' as signal
    FROM sessions
    WHERE status IN ('active','starting')
    ORDER BY started_at DESC
  `);
  for (const r of rows) {
    console.log('=== session', r.id.slice(0,8), r.status, '===');
    console.log('  GATE  :', JSON.stringify(r.gate));
    console.log('  SIZING:', JSON.stringify(r.sizing));
    console.log('  SIGNAL:', JSON.stringify(r.signal));
    console.log('');
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
