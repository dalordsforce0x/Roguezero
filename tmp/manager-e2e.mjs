import pg from 'pg';
import 'dotenv/config';

const WEB = process.env.E2E_WEB_BASE ?? 'https://roguezero.io';
const MANAGER_ID = '230da4b0-edda-4793-a33a-941db7923a14';

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');
const url = databaseUrl.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });

const redact = (k) => (k ? `${k.slice(0, 9)}…(${k.length} chars)` : 'NULL');

await client.connect();
const { rows } = await client.query(
  'SELECT management_key FROM rz_managers WHERE id = $1 LIMIT 1',
  [MANAGER_ID],
);
await client.end();
const managementKey = rows[0]?.management_key ?? null;
console.log(`manager key (redacted): ${redact(managementKey)}`);
if (!managementKey) { console.error('no management_key on manager'); process.exit(1); }

// 1) UNLOCK
const unlockRes = await fetch(`${WEB}/api/manager/unlock`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ managementKey }),
  redirect: 'manual',
});
const unlockJson = await unlockRes.json().catch(() => ({}));
console.log(`\n[1] POST /api/manager/unlock -> ${unlockRes.status}`);
console.log(JSON.stringify({
  ok: unlockJson.ok,
  manager: unlockJson.manager,
  groupCount: unlockJson.groupCount,
  userCount: unlockJson.userCount,
  error: unlockJson.error,
  details: unlockJson.details,
}, null, 2));

const setCookie = unlockRes.headers.get('set-cookie') ?? '';
const cookieMatch = setCookie.match(/rz_manager_session=([^;]+)/);
const cookie = cookieMatch ? `rz_manager_session=${cookieMatch[1]}` : '';
console.log(`session cookie set: ${cookie ? 'yes' : 'NO'}`);
if (!cookie) { console.error('no manager session cookie — aborting'); process.exit(1); }

// 2) OVERVIEW
const ovRes = await fetch(`${WEB}/api/manager/overview`, { headers: { cookie }, redirect: 'manual' });
const ov = await ovRes.json().catch(() => ({}));
console.log(`\n[2] GET /api/manager/overview -> ${ovRes.status}`);
console.log(JSON.stringify({
  manager: ov.manager?.name ?? ov.manager,
  groups: (ov.groups ?? []).map((g) => ({ name: g.name, botLimit: g.botLimit })),
  users: (ov.users ?? []).map((u) => ({ username: u.username, group: u.groupName, enabled: u.accessEnabled })),
}, null, 2));

// 3) SESSIONS
const sesRes = await fetch(`${WEB}/api/manager/sessions`, { headers: { cookie }, redirect: 'manual' });
const ses = await sesRes.json().catch(() => ({}));
console.log(`\n[3] GET /api/manager/sessions -> ${sesRes.status}`);
console.log(JSON.stringify({
  count: ses.count ?? (ses.sessions ?? []).length,
  sessions: (ses.sessions ?? []).map((s) => ({
    id: s.id?.slice(0, 8),
    userId: s.userId?.slice(0, 8),
    status: s.status,
    realizedPnlUsd: s.funding?.realizedPnlUsd,
  })),
}, null, 2));

// 4) NEGATIVE: no cookie should 401
const noAuth = await fetch(`${WEB}/api/manager/overview`, { redirect: 'manual' });
console.log(`\n[4] GET /api/manager/overview (no cookie) -> ${noAuth.status} (expect 401)`);

console.log('\nE2E done.');
