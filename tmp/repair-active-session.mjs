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

const res = await client.query(
  `UPDATE sessions SET service_control = jsonb_set(service_control, '{rotationState,rotationIntervalMinutes}', '60')
   WHERE id = '88d6a73a-5969-48c4-bc44-43a61b6c56b9'
     AND NOT (service_control->'rotationState' ? 'rotationIntervalMinutes')
   RETURNING id`,
);
console.log('repaired rows:', res.rowCount);

await client.end();
