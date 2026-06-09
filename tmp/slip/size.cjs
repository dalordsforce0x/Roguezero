require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const SOL_USD = 150; // rough; only for buy-from-SOL notional

(async () => {
  const rows = (await pool.query(`
    SELECT input_mint, output_mint, build_response, metadata,
           (build_response->>'priceImpactPct')::numeric*10000 AS impact_bps
    FROM swap_executions
    WHERE status='confirmed' AND created_at > now() - interval '72 hours'
      AND build_response->>'priceImpactPct' IS NOT NULL
  `)).rows;

  const notionalUsd = (r, dir) => {
    const br = r.build_response;
    if (dir === 'SELL') return Number(br.outAmount) / 1e6;           // out USDC
    // BUY
    if (r.input_mint === USDC) return Number(br.inAmount) / 1e6;     // in USDC
    if (r.input_mint === SOL) return (Number(br.inAmount) / 1e9) * SOL_USD;
    return NaN;
  };

  const buys = [], sells = [];
  for (const r of rows) {
    const inIsBase = r.input_mint === USDC || r.input_mint === SOL;
    const outIsBase = r.output_mint === USDC || r.output_mint === SOL;
    const dir = inIsBase && !outIsBase ? 'BUY' : (!inIsBase && outIsBase ? 'SELL' : null);
    if (!dir) continue;
    const usd = notionalUsd(r, dir);
    if (!Number.isFinite(usd)) continue;
    (dir === 'BUY' ? buys : sells).push({ usd, imp: Number(r.impact_bps), reason: r.metadata?.exitReason });
  }

  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  const summ = (a, f) => {
    const v = a.map(f);
    return `n=${v.length} med=${q(v, .5).toFixed(1)} p90=${q(v, .9).toFixed(1)} max=${Math.max(...v).toFixed(1)}`;
  };
  console.log('BUY  notional$:', summ(buys, x => x.usd));
  console.log('SELL notional$:', summ(sells, x => x.usd));
  console.log('BUY  impact:', summ(buys, x => x.imp));
  console.log('SELL impact:', summ(sells, x => x.imp));

  // sell impact by notional bucket
  console.log('\nSELL impact by notional bucket:');
  const bk = [[0, 5], [5, 15], [15, 40], [40, 100], [100, 1e9]];
  for (const [lo, hi] of bk) {
    const g = sells.filter(s => s.usd >= lo && s.usd < hi);
    if (!g.length) continue;
    const avgImp = g.reduce((p, c) => p + c.imp, 0) / g.length;
    const avgUsd = g.reduce((p, c) => p + c.usd, 0) / g.length;
    console.log(`  $${lo}-${hi}: n=${String(g.length).padStart(3)} avg$=${avgUsd.toFixed(1).padStart(6)} avgImpact=${avgImp.toFixed(1)}bps`);
  }

  // sell impact by exit reason
  console.log('\nSELL impact by exitReason:');
  const byReason = new Map();
  for (const s of sells) { const k = s.reason || '?'; if (!byReason.has(k)) byReason.set(k, []); byReason.get(k).push(s); }
  for (const [k, g] of byReason) {
    const avgImp = g.reduce((p, c) => p + c.imp, 0) / g.length;
    const avgUsd = g.reduce((p, c) => p + c.usd, 0) / g.length;
    console.log(`  ${k.padEnd(16)} n=${String(g.length).padStart(3)} avg$=${avgUsd.toFixed(1).padStart(6)} avgImpact=${avgImp.toFixed(1)}bps`);
  }
  await pool.end();
})().catch((e) => { console.error(e); pool.end(); process.exit(1); });
