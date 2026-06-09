require('dotenv').config();
const fs = require('fs');
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const KEEP = [
  'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW',
  'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7',
  '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC',
];
(async () => {
  const client = await p.connect();
  try {
    // 1. Backup the rows to be deleted
    const del = await client.query('select * from swap_executions where not (taker = any($1))', [KEEP]);
    const backupPath = 'tmp/dbclean/swap_executions_deleted_backup.json';
    fs.writeFileSync(backupPath, JSON.stringify(del.rows, null, 2));
    console.log(`Backed up ${del.rows.length} rows -> ${backupPath}`);

    // 2. Transactional delete with verification
    await client.query('BEGIN');
    const keepBefore = await client.query('select count(*) n from swap_executions where taker = any($1)', [KEEP]);
    const totalBefore = await client.query('select count(*) n from swap_executions');
    const r = await client.query('delete from swap_executions where not (taker = any($1))', [KEEP]);
    const keepAfter = await client.query('select count(*) n from swap_executions where taker = any($1)', [KEEP]);
    const totalAfter = await client.query('select count(*) n from swap_executions');

    console.log(`Deleted rows: ${r.rowCount}`);
    console.log(`KEEP before=${keepBefore.rows[0].n} after=${keepAfter.rows[0].n}`);
    console.log(`TOTAL before=${totalBefore.rows[0].n} after=${totalAfter.rows[0].n}`);

    // Safety asserts
    if (Number(keepAfter.rows[0].n) !== Number(keepBefore.rows[0].n)) {
      throw new Error('ABORT: keep-count changed — rolling back');
    }
    if (Number(r.rowCount) !== Number(totalBefore.rows[0].n) - Number(keepBefore.rows[0].n)) {
      throw new Error('ABORT: deleted count mismatch — rolling back');
    }
    await client.query('COMMIT');
    console.log('COMMITTED. Active sessions trade data preserved.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ROLLED BACK:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await p.end();
  }
})();
