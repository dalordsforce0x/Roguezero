require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const { rows } = await pool.query(`
    SELECT created_at, status, input_mint, output_mint, amount, build_response, metadata
    FROM swap_executions
    ORDER BY created_at DESC
    LIMIT 10
  `);
  for (const r of rows) {
    let costs = null, src = '';
    const tryGet = (o) => o && (o.costs ?? o.data?.costs ?? null);
    for (const [k,v] of [['build',r.build_response],['meta',r.metadata]]) {
      try {
        const o = typeof v === 'string' ? JSON.parse(v) : v;
        const c = tryGet(o);
        if (c) { costs = c; src = k; break; }
        // dig for any estimatedNetworkCost key
        const s = JSON.stringify(o||{});
        const m = s.match(/"estimatedNetworkCost[^"]*":\s*\d+/);
        if (m) { costs = m[0]; src = k+'(grep)'; break; }
      } catch {}
    }
    const inSym = r.input_mint.slice(0,4), outSym = r.output_mint.slice(0,4);
    console.log(`${r.created_at.toISOString()} ${r.status} ${inSym}->${outSym} amt=${r.amount} costs[${src}]=${JSON.stringify(costs)}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
