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

const userId = '54d9f25d-9526-4eb9-8e6b-9cb649a97d88';
const res = await client.query(
  `SELECT id, status, service_control FROM sessions WHERE user_id = $1 LIMIT 10`,
  [userId],
);

for (const row of res.rows) {
  console.log('---', row.id, row.status, row.updated_at);
  console.log(JSON.stringify(row.service_control, null, 2));
}

await client.end();
