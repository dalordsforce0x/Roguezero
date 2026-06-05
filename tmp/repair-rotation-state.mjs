import fs from 'node:fs';
import { Client } from 'pg';

const envLines = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((line) => !line.startsWith('#'));

for (const line of envLines) {
  const index = line.indexOf('=');
  if (index > 0) {
    process.env[line.slice(0, index)] = line.slice(index + 1);
  }
}

const rawConnectionString = process.env.DATABASE_PRIVATE_URL?.trim();
if (!rawConnectionString) throw new Error('DATABASE_PRIVATE_URL is required');
if (!rawConnectionString) {
  throw new Error('DATABASE url missing');
}

const parsed = new URL(rawConnectionString);
parsed.searchParams.delete('sslmode');

const client = new Client({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
});

await client.connect();

try {
  const preview = await client.query(`
    select id, status, service_control->'rotationState' as rotation_state
    from sessions
    where service_control ? 'rotationState'
      and not ((service_control->'rotationState') ? 'rotationIntervalMinutes')
    order by requested_at desc
  `);

  console.log('BROKEN_ROWS_BEFORE');
  console.log(JSON.stringify(preview.rows, null, 2));

  const update = await client.query(`
    update sessions
       set service_control = jsonb_set(
         service_control,
         '{rotationState,rotationIntervalMinutes}',
         '60'::jsonb,
         true
       )
     where service_control ? 'rotationState'
       and not ((service_control->'rotationState') ? 'rotationIntervalMinutes')
     returning id, status, service_control->'rotationState' as rotation_state
  `);

  console.log('UPDATED_ROWS');
  console.log(JSON.stringify(update.rows, null, 2));
} finally {
  await client.end();
}
