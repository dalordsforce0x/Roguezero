require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  // Find columns on sessions table
  const cols = await p.query(
    `select column_name, data_type from information_schema.columns
     where table_name='sessions' order by ordinal_position`);
  console.log('sessions columns:', cols.rows.map(c=>`${c.column_name}:${c.data_type}`).join(', '));

  // Show where platformFeeBps lives for active sessions
  const r = await p.query(
    `select id, status,
            service_control->>'platformFeeBps' as fee_in_service_control
     from sessions
     where status='active'`);
  console.log('\nactive sessions service_control.platformFeeBps:');
  for (const row of r.rows) console.log(`  ${row.id}  status=${row.status}  fee=${row.fee_in_service_control}`);
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
