import 'dotenv/config';
import pg from 'pg';

const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const sid = '3951496c-5459-4298-8369-fb873e2ef613';

const cols = await pool.query(
  "select column_name from information_schema.columns where table_name='execution_queue' order by ordinal_position",
);
console.log('COLS:', cols.rows.map((r) => r.column_name).join(', '));

const q = await pool
  .query('select * from execution_queue where session_id = $1 order by created_at desc limit 10', [sid])
  .catch((e) => ({ rows: [], err: e.message }));
if (q.err) console.log('session query err:', q.err);
console.log('rows for session:', q.rows.length);
for (const r of q.rows) console.log(JSON.stringify(r));

const all = await pool.query(
  'select status, count(*) c, min(created_at) oldest, max(updated_at) newest from execution_queue group by status',
);
console.log('--- queue by status ---');
for (const r of all.rows) console.log(r.status, 'count', r.c, 'oldest', r.oldest, 'newest', r.newest);

await pool.end();
