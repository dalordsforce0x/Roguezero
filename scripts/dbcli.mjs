import pg from 'pg';
import 'dotenv/config';

const sql = process.argv.slice(2).join(' ');
if (!sql) { console.error('usage: node dbcli.mjs "<SQL>"'); process.exit(2); }

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const url = databaseUrl.replace('sslmode=require','uselibpqcompat=true&sslmode=require');
const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60000,
  query_timeout: 60000,
  lock_timeout: 3000,
});

const t = setTimeout(() => { console.error('HARD TIMEOUT 90s'); process.exit(3); }, 90000);
try {
  await client.connect();
  const r = await client.query(sql);
  if (Array.isArray(r)) {
    for (const x of r) console.log(JSON.stringify({ cmd: x.command, rows: x.rows, n: x.rowCount }, null, 2));
  } else {
    console.log(JSON.stringify({ cmd: r.command, rows: r.rows, n: r.rowCount }, null, 2));
  }
} catch (e) {
  console.error('ERR', e.code, e.message);
  process.exit(1);
} finally {
  clearTimeout(t);
  await client.end().catch(()=>{});
}
