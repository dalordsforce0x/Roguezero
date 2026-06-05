import fs from 'node:fs';
import { Client } from 'pg';
import { sessionSchema } from '../packages/session-schema/src/index.ts';

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

const toIso = (value) => (value === null ? null : new Date(value).toISOString());

const userId = '54d9f25d-9526-4eb9-8e6b-9cb649a97d88';

await client.connect();

try {
  const res = await client.query(
    'select * from sessions where user_id = $1 order by requested_at desc limit 5',
    [userId],
  );

  console.log('ROWS');
  console.log(JSON.stringify(res.rows, null, 2));

  for (const row of res.rows) {
    try {
      sessionSchema.parse({
        id: row.id,
        userId: row.user_id,
        keyAuthUserId: row.key_auth_user_id,
        licenseId: row.license_id,
        ownerWallet: row.owner_wallet,
        sessionWallet: row.session_wallet,
        network: row.network,
        status: row.status,
        requestedAt: toIso(row.requested_at),
        startedAt: toIso(row.started_at),
        endedAt: toIso(row.ended_at),
        stopReason: row.stop_reason,
        userControl: row.user_control,
        serviceControl: row.service_control,
        riskLimits: row.risk_limits,
        funding: row.funding,
        createdBy: row.created_by,
        notes: row.notes,
      });
      console.log('OK', row.id, row.status);
    } catch (error) {
      console.log('FAIL', row.id, row.status);
      console.log(JSON.stringify(error.issues ?? error, null, 2));
    }
  }
} finally {
  await client.end();
}
