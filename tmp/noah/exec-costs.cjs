require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  // find columns
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='swap_executions' ORDER BY ordinal_position`);
  console.log('cols:', cols.rows.map(r=>r.column_name).join(', '));
  const { rows } = await pool.query(`
    SELECT created_at, status, stage, reason, amount, build_response, prepare_response
    FROM swap_executions
    ORDER BY created_at DESC
    LIMIT 8
  `);
  for (const r of rows) {
    let costs = null;
    try {
      const pr = typeof r.prepare_response === 'string' ? JSON.parse(r.prepare_response) : r.prepare_response;
      costs = pr?.costs ?? pr?.data?.costs ?? null;
    } catch {}
    console.log(`${r.created_at.toISOString()} ${r.status}/${r.stage} ${r.reason ?? ''} amount=${r.amount} costs=${JSON.stringify(costs)}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
