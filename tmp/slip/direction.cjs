require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const lbl = (m) => m === USDC ? 'USDC' : m === SOL ? 'SOL' : m.slice(0, 4);

(async () => {
  const rows = (await pool.query(`
    SELECT input_mint, output_mint, build_response, metadata,
           (build_response->>'priceImpactPct')::numeric*10000 AS impact_bps
    FROM swap_executions
    WHERE status='confirmed' AND created_at > now() - interval '72 hours'
      AND build_response->>'priceImpactPct' IS NOT NULL
  `)).rows;

  // classify each leg: buy (stable/SOL -> token) vs sell (token -> stable/SOL)
  const buckets = new Map(); // key -> {impacts:[], hops:[]}
  const add = (k, imp, hops) => {
    if (!buckets.has(k)) buckets.set(k, { impacts: [], hops: [] });
    buckets.get(k).impacts.push(imp); buckets.get(k).hops.push(hops);
  };

  for (const r of rows) {
    const inIsBase = r.input_mint === USDC || r.input_mint === SOL;
    const outIsBase = r.output_mint === USDC || r.output_mint === SOL;
    const dir = inIsBase && !outIsBase ? 'BUY' : (!inIsBase && outIsBase ? 'SELL' : 'OTHER');
    const hops = Array.isArray(r.build_response?.routePlan) ? r.build_response.routePlan.length : 1;
    const imp = Number(r.impact_bps);
    add(dir, imp, hops);
    add(`${dir} ${hops}hop`, imp, hops);
    add(`${dir} ->${lbl(r.output_mint)}`, imp, hops);
  }

  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const n = s.length, avg = s.reduce((p, c) => p + c, 0) / (n || 1);
    const med = n ? s[Math.floor(n / 2)] : 0;
    return { n, avg, med };
  };

  console.log('bucket                 n    avgImpact  medImpact  avgHops');
  const order = ['BUY', 'SELL', 'OTHER', 'BUY 1hop', 'BUY 2hop', 'SELL 1hop', 'SELL 2hop',
    'SELL ->USDC', 'SELL ->SOL', 'BUY ->USDC', 'BUY ->SOL'];
  for (const k of order) {
    const b = buckets.get(k); if (!b) continue;
    const s = stat(b.impacts);
    const ah = b.hops.reduce((p, c) => p + c, 0) / b.hops.length;
    console.log(`${k.padEnd(22)} ${String(s.n).padStart(3)}  ${s.avg.toFixed(1).padStart(8)}  ${s.med.toFixed(1).padStart(8)}  ${ah.toFixed(2).padStart(6)}`);
  }
  await pool.end();
})().catch((e) => { console.error(e); pool.end(); process.exit(1); });
