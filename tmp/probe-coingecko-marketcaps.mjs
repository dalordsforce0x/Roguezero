import 'dotenv/config';
import pg from 'pg';
import { buildMintMarketDataMap, coingeckoMeta } from '../scripts/coingeckoMarketData.mjs';

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } });

const { rows } = await pool.query(
  `SELECT mint, symbol FROM public.rz_token_universe WHERE enabled ORDER BY priority DESC LIMIT 200`,
);
console.log('meta:', coingeckoMeta());
console.log('enabled universe rows:', rows.length);

const map = await buildMintMarketDataMap(rows.map((r) => r.mint));
const symByMint = new Map(rows.map((r) => [r.mint, r.symbol]));

const enriched = [];
for (const [mint, data] of map) {
  enriched.push({ symbol: symByMint.get(mint) ?? data.symbol, cap: data.marketCapUsd, rank: data.marketCapRank });
}
enriched.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));

const fmt = (n) => (Number.isFinite(n) ? '$' + Math.round(n).toLocaleString() : 'n/a');
console.log(`\nmatched ${enriched.length}/${rows.length} on CoinGecko\n`);
for (const e of enriched) {
  console.log(`${(e.symbol ?? '?').padEnd(10)} rank=${String(e.rank ?? '-').padStart(6)}  cap=${fmt(e.cap)}`);
}

const caps = enriched.map((e) => e.cap).filter((c) => Number.isFinite(c)).sort((a, b) => a - b);
if (caps.length) {
  const pct = (p) => caps[Math.min(caps.length - 1, Math.floor((p / 100) * caps.length))];
  console.log(`\ncap distribution: min=${fmt(caps[0])} p10=${fmt(pct(10))} p25=${fmt(pct(25))} median=${fmt(pct(50))} max=${fmt(caps[caps.length - 1])}`);
  console.log(`unlisted (no CoinGecko): ${rows.length - enriched.length}`);
}
await pool.end();
