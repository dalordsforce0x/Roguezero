import 'dotenv/config';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const url = new URL(databaseUrl);
url.searchParams.delete('sslmode');

const client = new pg.Client({
  connectionString: url.toString(),
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60000,
  query_timeout: 60000,
});

const SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'session_keys_session_id_fkey'
  ) THEN
    ALTER TABLE session_keys
    ADD CONSTRAINT session_keys_session_id_fkey
    FOREIGN KEY (session_id)
    REFERENCES sessions(id)
    ON DELETE CASCADE;
  END IF;
END
$$;
`;

await client.connect();
try {
  await client.query(SQL);
  const r = await client.query(
    "SELECT conname FROM pg_constraint WHERE conname = 'session_keys_session_id_fkey'",
  );
  console.log(JSON.stringify({ ok: true, present: r.rowCount > 0 }));
} catch (err) {
  console.error('ERR', err.code, err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
