import dotenv from 'dotenv';
import pg from 'pg';

const [, , taker, status, limitArg] = process.argv;
const limit = Number(limitArg ?? 10);

if (!taker) {
  throw new Error('Usage: node scripts/list-session-executions.mjs <sessionWallet> [status] [limit]');
}

dotenv.config({ path: '.env' });

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');

const client = new pg.Client({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  const query = status
    ? `select id, status, input_mint, output_mint, signature, confirmed_at, created_at
         from swap_executions
        where taker = $1 and status = $2
        order by created_at desc
        limit $3`
    : `select id, status, input_mint, output_mint, signature, confirmed_at, created_at
         from swap_executions
        where taker = $1
        order by created_at desc
        limit $2`;
  const params = status ? [taker, status, limit] : [taker, limit];
  const result = await client.query(query, params);

  console.log(JSON.stringify(result.rows, null, 2));
} finally {
  await client.end();
}
