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

const CORE_BUCKETS = new Set(['base', 'stable', 'major', 'lst']);
const CORE_PRIORITY_FLOOR = 99_990;

const main = async () => {
  await pool.query('BEGIN');
  try {
    await pool.query(`
      UPDATE public.rz_token_universe u
         SET enabled = false,
             notes = CASE
               WHEN u.notes LIKE 'rejected:%' THEN u.notes
               ELSE 'disabled:not-admitted-current-run'
             END,
             updated_at = now()
       WHERE NOT EXISTS (
         SELECT 1
           FROM public.token_admission_candidates c
          WHERE c.mint = u.mint
            AND c.status = 'admitted'
       )
    `);

    const admitted = await pool.query(`
      SELECT mint, symbol, bucket, priority
        FROM public.token_admission_candidates
       WHERE status = 'admitted'
       ORDER BY priority DESC
    `);

    for (const row of admitted.rows) {
      const notes = CORE_BUCKETS.has(row.bucket) && Number(row.priority) >= CORE_PRIORITY_FLOOR
        ? 'core-seed'
        : `admitted:${row.bucket};layer=route-qualified;safety=verified-audit-liquidity-entry-exit`;

      await pool.query(
        `INSERT INTO public.rz_token_universe (mint, symbol, enabled, priority, notes, updated_at)
         VALUES ($1, $2, true, $3, $4, now())
         ON CONFLICT (mint)
         DO UPDATE SET symbol = EXCLUDED.symbol,
                       enabled = true,
                       priority = EXCLUDED.priority,
                       notes = EXCLUDED.notes,
                       updated_at = now()`,
        [row.mint, row.symbol, row.priority, notes],
      );
    }

    await pool.query(`
      UPDATE public.market_candidates mc
         SET status = 'rejected'
       WHERE mc.status = 'active'
         AND mc.valid_until > now()
         AND NOT EXISTS (
           SELECT 1
             FROM public.rz_token_universe u
            WHERE u.mint = mc.output_mint
              AND u.enabled = true
              AND (u.notes = 'core-seed' OR u.notes LIKE 'admitted:%')
         )
    `);

    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }

  const totals = await pool.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE enabled)::int AS enabled,
           count(*) FILTER (WHERE enabled AND notes = 'core-seed')::int AS core_seed,
           count(*) FILTER (WHERE enabled AND notes LIKE 'admitted:%')::int AS route_qualified,
           count(*) FILTER (WHERE enabled AND notes LIKE 'disabled:%')::int AS enabled_disabled_note,
           count(*) FILTER (WHERE enabled AND notes LIKE 'rejected:%')::int AS enabled_rejected_note
      FROM public.rz_token_universe
  `);

  const missingAdmitted = await pool.query(`
    SELECT c.symbol, c.mint, c.bucket
      FROM public.token_admission_candidates c
      LEFT JOIN public.rz_token_universe u ON u.mint = c.mint
     WHERE c.status = 'admitted'
       AND NOT (u.enabled = true AND (u.notes = 'core-seed' OR u.notes LIKE 'admitted:%'))
     ORDER BY c.priority DESC
  `);

  const invalidEnabled = await pool.query(`
    SELECT symbol, mint, notes
      FROM public.rz_token_universe
     WHERE enabled = true
       AND (notes LIKE 'disabled:%' OR notes LIKE 'rejected:%')
     ORDER BY priority DESC
  `);

  const staleActiveCandidates = await pool.query(`
    SELECT mc.output_symbol, mc.output_mint, count(*)::int AS active_count
      FROM public.market_candidates mc
      LEFT JOIN public.rz_token_universe u ON u.mint = mc.output_mint
     WHERE mc.status = 'active'
       AND mc.valid_until > now()
       AND NOT (u.enabled = true AND (u.notes = 'core-seed' OR u.notes LIKE 'admitted:%'))
     GROUP BY mc.output_symbol, mc.output_mint
     ORDER BY active_count DESC
     LIMIT 20
  `);

  const payload = {
    totals: totals.rows[0],
    missingAdmitted: missingAdmitted.rows,
    invalidEnabled: invalidEnabled.rows,
    staleActiveCandidates: staleActiveCandidates.rows,
  };

  console.log(JSON.stringify(payload, null, 2));

  if (missingAdmitted.rowCount > 0 || invalidEnabled.rowCount > 0) {
    process.exitCode = 1;
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
