const pg = require('pg');
require('dotenv/config');
const { sessionSchema } = require('../packages/session-schema/dist/index.js');

async function test() {
  const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL required');
  const url = databaseUrl.replace('sslmode=require','uselibpqcompat=true&sslmode=require');
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const r = await client.query(`
    SELECT * FROM sessions ORDER BY requested_at DESC LIMIT 72
  `);
  let ok = 0;
  for (const row of r.rows) {
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
        requestedAt: row.requested_at?.toISOString?.() ?? row.requested_at,
        startedAt: row.started_at?.toISOString?.() ?? null,
        endedAt: row.ended_at?.toISOString?.() ?? null,
        stopReason: row.stop_reason,
        userControl: row.user_control,
        serviceControl: row.service_control,
        riskLimits: row.risk_limits,
        funding: row.funding,
        createdBy: row.created_by,
        notes: row.notes,
      });
      ok++;
    } catch (e) {
      console.error('FAILED session', row.id, row.status);
      for (const issue of (e.issues ?? []).slice(0, 5)) {
        console.error('  ', issue.path?.join('.'), ':', issue.message);
      }
    }
  }
  console.log(`${ok}/${r.rows.length} sessions parsed OK`);
  await client.end();
}
test().catch(console.error);
