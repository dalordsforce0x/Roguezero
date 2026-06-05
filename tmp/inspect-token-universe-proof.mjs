import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env' });

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');

const url = new URL(databaseUrl);
url.searchParams.delete('sslmode');

const pool = new pg.Pool({
  connectionString: url.toString(),
  ssl: { rejectUnauthorized: false },
});

try {
  const breakdown = await pool.query(`
    SELECT enabled,
           split_part(coalesce(notes, ''), ':', 1) AS note_prefix,
           count(*)::int AS count
      FROM public.rz_token_universe
     GROUP BY enabled, note_prefix
     ORDER BY enabled DESC, count DESC
  `);

  const enabledSample = await pool.query(`
    SELECT mint, symbol, priority, notes, updated_at
      FROM public.rz_token_universe
     WHERE enabled = true
     ORDER BY priority DESC
     LIMIT 40
  `);

  const admission = await pool.query(`
    SELECT status, count(*)::int AS count
      FROM public.token_admission_candidates
     GROUP BY status
     ORDER BY status
  `);

  console.log(JSON.stringify({
    breakdown: breakdown.rows,
    enabledSample: enabledSample.rows,
    admission: admission.rows,
  }, null, 2));
} finally {
  await pool.end();
}
