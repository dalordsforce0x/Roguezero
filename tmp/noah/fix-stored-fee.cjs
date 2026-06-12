require('dotenv').config();
const fs = require('fs');
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  const c = await p.connect();
  try {
    // 1) Backup current service_control for active sessions
    const before = await c.query(
      `select id, service_control from sessions where status='active'`);
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const backupPath = `tmp/noah/service_control_backup_${stamp}.json`;
    fs.writeFileSync(backupPath, JSON.stringify(before.rows, null, 2));
    console.log(`Backed up ${before.rows.length} active sessions -> ${backupPath}`);
    for (const r of before.rows) console.log(`  before ${r.id}: platformFeeBps=${r.service_control.platformFeeBps}`);

    // 2) Transactional update: only rows where fee != 0
    await c.query('BEGIN');
    const upd = await c.query(
      `update sessions
         set service_control = jsonb_set(service_control, '{platformFeeBps}', '0'::jsonb)
       where status='active'
         and (service_control->>'platformFeeBps') is distinct from '0'
       returning id`);
    console.log(`\nUpdated rows: ${upd.rows.length}`);
    await c.query('COMMIT');

    // 3) Verify
    const after = await c.query(
      `select id, service_control->>'platformFeeBps' fee from sessions where status='active'`);
    console.log('\nafter:');
    for (const r of after.rows) console.log(`  ${r.id}: platformFeeBps=${r.fee}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(()=>{});
    console.error('ROLLED BACK:', e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await p.end();
  }
})();
