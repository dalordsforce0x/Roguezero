import 'dotenv/config';
import pg from 'pg';
import { buildMintMarketDataMap, coingeckoMeta } from '../scripts/coingeckoMarketData.mjs';

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');
const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } });

await pool.query(`
  CREATE TABLE IF NOT EXISTS public.rz_token_marketdata (
    mint TEXT PRIMARY KEY,
    coingecko_id TEXT,
    symbol TEXT,
    name TEXT,
    market_cap_usd DOUBLE PRECISION,
    market_cap_rank INTEGER,
    fdv_usd DOUBLE PRECISION,
    volume_24h_usd DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

const { rows } = await pool.query(`SELECT mint, symbol FROM public.rz_token_universe ORDER BY priority DESC`);
console.log('meta:', coingeckoMeta());
console.log('universe rows:', rows.length);

const map = await buildMintMarketDataMap(rows.map((r) => r.mint));
let written = 0;
for (const [mint, data] of map) {
  await pool.query(
    `INSERT INTO public.rz_token_marketdata (mint, coingecko_id, symbol, name, market_cap_usd, market_cap_rank, fdv_usd, volume_24h_usd, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (mint) DO UPDATE SET coingecko_id=EXCLUDED.coingecko_id, symbol=EXCLUDED.symbol, name=EXCLUDED.name,
       market_cap_usd=EXCLUDED.market_cap_usd, market_cap_rank=EXCLUDED.market_cap_rank, fdv_usd=EXCLUDED.fdv_usd,
       volume_24h_usd=EXCLUDED.volume_24h_usd, updated_at=now()`,
    [
      mint,
      data.coingeckoId ?? null,
      data.symbol ?? null,
      data.name ?? null,
      Number.isFinite(Number(data.marketCapUsd)) ? Number(data.marketCapUsd) : null,
      Number.isFinite(Number(data.marketCapRank)) ? Number(data.marketCapRank) : null,
      Number.isFinite(Number(data.fdvUsd)) ? Number(data.fdvUsd) : null,
      Number.isFinite(Number(data.volume24hUsd)) ? Number(data.volume24hUsd) : null,
    ],
  );
  written++;
}
console.log(`wrote ${written}/${rows.length} market-data rows`);
await pool.end();
