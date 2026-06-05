import 'dotenv/config';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();

if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');

const pool = new pg.Pool({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
});

const DISABLE_NON_SEED_ROWS = process.env.TOKEN_UNIVERSE_DISABLE_NON_SEED_ROWS !== 'false';

const DEFAULT_TOKENS = [
  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', priority: 100, enabled: true },
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', priority: 99, enabled: true },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', priority: 98, enabled: true },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', priority: 97, enabled: true },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL', priority: 96, enabled: true },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', priority: 95, enabled: true },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', priority: 94, enabled: true },
  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO', priority: 93, enabled: true },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', priority: 92, enabled: true },
  { mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', symbol: 'KMNO', priority: 91, enabled: true },
  { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', symbol: 'WBTC', priority: 90, enabled: true },
  { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', symbol: 'W', priority: 89, enabled: true },
  { mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', symbol: 'HNT', priority: 88, enabled: true },
];

const isSolanaMint = (value) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

const parseEnvUniverse = () => {
  const raw = process.env.TOKEN_UNIVERSE_MINTS?.trim();
  if (!raw) return [];

  return raw
    .split(',')
    .map((mint) => mint.trim())
    .filter((mint) => mint.length > 0)
    .filter((mint) => isSolanaMint(mint))
    .map((mint, idx) => ({
      mint,
      symbol: process.env[`TOKEN_SYMBOL_${idx + 1}`] ?? `TKN${idx + 1}`,
      priority: Math.max(1, 50 - idx),
      enabled: true,
    }));
};

const dedupeByMint = (tokens) => {
  const map = new Map();
  for (const token of tokens) {
    if (!isSolanaMint(token.mint)) continue;
    if (!map.has(token.mint)) map.set(token.mint, token);
  }
  return [...map.values()];
};

const main = async () => {
  const envUniverse = parseEnvUniverse();
  const seeds = dedupeByMint([...DEFAULT_TOKENS, ...envUniverse]);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.rz_token_universe (
      mint TEXT PRIMARY KEY,
      symbol TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      priority INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    ALTER TABLE public.rz_token_universe
      ADD COLUMN IF NOT EXISTS notes TEXT
  `);

  if (DISABLE_NON_SEED_ROWS) {
    await pool.query(
      `UPDATE public.rz_token_universe
          SET enabled = false,
              priority = LEAST(priority, 0),
              notes = COALESCE(notes, 'disabled by curated bootstrap'),
              updated_at = now()
        WHERE NOT (mint = ANY($1::text[]))`,
      [seeds.map((token) => token.mint)],
    );
  }

  for (const token of seeds) {
    await pool.query(
      `INSERT INTO public.rz_token_universe (mint, symbol, enabled, priority, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (mint)
       DO UPDATE SET
         symbol = EXCLUDED.symbol,
         enabled = EXCLUDED.enabled,
         priority = EXCLUDED.priority,
         notes = CASE WHEN EXCLUDED.enabled THEN NULL ELSE public.rz_token_universe.notes END,
         updated_at = now()`,
      [token.mint, token.symbol, token.enabled, token.priority],
    );
  }

  const result = await pool.query(`
    SELECT mint, symbol, enabled, priority
    FROM public.rz_token_universe
    ORDER BY priority DESC, symbol ASC
    LIMIT 200
  `);

  console.log(JSON.stringify({
    table: 'public.rz_token_universe',
    upserted: seeds.length,
    disabledNonSeedRows: DISABLE_NON_SEED_ROWS,
    rows: result.rows.length,
    sample: result.rows.slice(0, 10),
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
