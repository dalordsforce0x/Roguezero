require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const isBase = (m) => m === USDC || m === SOL;

(async () => {
  const rows = (await pool.query(`
    SELECT input_mint, output_mint, build_response, metadata,
           (build_response->>'priceImpactPct')::numeric*10000 AS impact_bps
    FROM swap_executions
    WHERE status='confirmed' AND created_at > now() - interval '72 hours'
      AND build_response->>'priceImpactPct' IS NOT NULL
  `)).rows;

  // per-token: collect buy impacts (base->token) and sell impacts (token->base), with hop count
  const tok = new Map();
  for (const r of rows) {
    const buy = isBase(r.input_mint) && !isBase(r.output_mint);
    const sell = !isBase(r.input_mint) && isBase(r.output_mint);
    const mint = buy ? r.output_mint : sell ? r.input_mint : null;
    if (!mint) continue;
    const hops = Array.isArray(r.build_response?.routePlan) ? r.build_response.routePlan.length : 1;
    if (!tok.has(mint)) tok.set(mint, { sym: null, buys: [], sells: [], sellHops: [] });
    const t = tok.get(mint);
    if (buy) t.buys.push(Number(r.impact_bps));
    else { t.sells.push(Number(r.impact_bps)); t.sellHops.push(hops); }
  }

  // symbol lookup
  const symRows = (await pool.query(`SELECT mint, symbol FROM rz_token_universe`)).rows;
  const symOf = new Map(symRows.map(r => [r.mint, r.symbol]));

  const avg = (a) => a.length ? a.reduce((p, c) => p + c, 0) / a.length : null;
  const out = [];
  for (const [mint, t] of tok) {
    if (t.buys.length < 2 || t.sells.length < 2) continue;
    out.push({
      sym: symOf.get(mint) || mint.slice(0, 5),
      nBuy: t.buys.length, nSell: t.sells.length,
      buyImp: avg(t.buys), sellImp: avg(t.sells),
      avgSellHops: avg(t.sellHops),
    });
  }
  out.sort((a, b) => b.sellImp - a.sellImp);
  console.log('symbol    nBuy nSell  buyImp  sellImp  asym(sell-buy)  sellHops');
  for (const o of out) {
    console.log(
      `${o.sym.padEnd(9)} ${String(o.nBuy).padStart(3)}  ${String(o.nSell).padStart(4)}  ${o.buyImp.toFixed(1).padStart(6)}  ${o.sellImp.toFixed(1).padStart(6)}  ${(o.sellImp - o.buyImp).toFixed(1).padStart(13)}  ${o.avgSellHops.toFixed(2).padStart(7)}`,
    );
  }
  await pool.end();
})().catch((e) => { console.error(e); pool.end(); process.exit(1); });
