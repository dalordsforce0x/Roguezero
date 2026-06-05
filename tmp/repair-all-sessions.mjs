import fs from 'node:fs';
import { Client } from 'pg';

const envLines = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(Boolean).filter((l) => !l.startsWith('#'));
for (const line of envLines) {
  const i = line.indexOf('=');
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1);
}

const raw = process.env.DATABASE_PRIVATE_URL?.trim();
if (!raw) throw new Error('DATABASE_PRIVATE_URL is required');
const parsed = new URL(raw);
parsed.searchParams.delete('sslmode');

const client = new Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } });
await client.connect();

// Fix ALL sessions missing rotationIntervalMinutes
const res = await client.query(
  `UPDATE sessions
   SET service_control = jsonb_set(service_control, '{rotationState,rotationIntervalMinutes}', '60')
   WHERE service_control->'rotationState' IS NOT NULL
     AND NOT (service_control->'rotationState' ? 'rotationIntervalMinutes')
   RETURNING id, status`,
);
console.log('repaired:', res.rowCount);
for (const row of res.rows) console.log(' ', row.id, row.status);

await client.end();
