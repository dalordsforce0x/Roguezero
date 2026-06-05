import 'dotenv/config';
import { createCipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';

const keySource = process.env.SESSION_KEY_ENCRYPTION_KEY ?? '';
if (!keySource || keySource.length < 32) throw new Error('SESSION_KEY_ENCRYPTION_KEY missing/too short');
const keyBytes = keySource.length === 64 ? Buffer.from(keySource, 'hex') : Buffer.from(keySource.slice(0, 32), 'utf8');
const key = keyBytes.subarray(0, 32);
if (key.length !== 32) throw new Error('SESSION_KEY_ENCRYPTION_KEY did not produce 32 bytes');

const encrypt = (plaintext) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
};

const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const before = await client.query(`select count(*)::int as total, count(*) filter (where keypair_base58 like 'enc:%')::int as encrypted, count(*) filter (where keypair_base58 not like 'enc:%')::int as legacy from session_keys`);
  const rows = await client.query(`select session_id, keypair_base58 from session_keys where keypair_base58 not like 'enc:%' for update`);
  let updated = 0;
  for (const row of rows.rows) {
    const encrypted = encrypt(row.keypair_base58);
    await client.query('update session_keys set keypair_base58=$1 where session_id=$2', [encrypted, row.session_id]);
    updated++;
  }
  const after = await client.query(`select count(*)::int as total, count(*) filter (where keypair_base58 like 'enc:%')::int as encrypted, count(*) filter (where keypair_base58 not like 'enc:%')::int as legacy from session_keys`);
  await client.query('COMMIT');
  console.log(JSON.stringify({ before: before.rows[0], updated, after: after.rows[0] }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
