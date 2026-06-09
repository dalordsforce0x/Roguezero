require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const TAKER = 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
const SID = 'edd46e65-b21d-4d99-911d-99842d62b428';

(async () => {
  const s = (await pool.query(`select funding, started_at from sessions where id=$1`, [SID])).rows[0];
  console.log('Funding JSON:', JSON.stringify(s.funding));
  console.log('Started:', new Date(s.started_at).toISOString());

  // on-chain current balance via Helius RPC
  const rpc = process.env.HELIUS_RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : null);
  if (rpc) {
    const res = await fetch(rpc, { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getBalance', params:[TAKER] }) });
    const j = await res.json();
    const lamports = j.result?.value ?? null;
    console.log('On-chain SOL balance now:', lamports!==null ? (lamports/1e9).toFixed(6)+' SOL' : 'unknown', `(${lamports} lamports)`);
  } else {
    console.log('No Helius RPC env to check on-chain balance');
  }
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
