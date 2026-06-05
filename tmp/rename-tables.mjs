import pg from 'pg';

const connStr = 'postgresql://tsdbadmin:c63so6ufo2ei8jnm@pu4a5j80ut.o5ki8p073c.tsdb.cloud.timescale.com:30575/tsdb';
const pool = new pg.Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });

const tables = [
  'rogueai_token_universe',
  'rogueai_token_universe_metadata',
  'rogueai_token_universe_deadletter',
];

for (const t of tables) {
  const newName = t.replace('rogueai_', 'rz_');
  const exists = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [t],
  );
  if (exists.rows.length) {
    await pool.query(`ALTER TABLE public.${t} RENAME TO ${newName}`);
    console.log('RENAMED:', t, '->', newName);
  } else {
    console.log('SKIP (not found):', t);
  }
}

await pool.end();
