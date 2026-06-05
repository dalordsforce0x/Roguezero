import 'dotenv/config';

function findRpc() {
  for (const k of Object.keys(process.env)) {
    if (/HELIUS|RPC|SOLANA_RPC/i.test(k) && /^https?:/i.test(process.env[k] || '')) {
      return { key: k, url: process.env[k] };
    }
  }
  return null;
}

const rpc = findRpc();
console.log('RPC env key:', rpc ? rpc.key : '<none found>');
console.log('API_URL:', process.env.API_URL);

if (rpc) {
  const start = Date.now();
  try {
    const res = await fetch(rpc.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    console.log(`Helius RPC getHealth: ${res.status} ${JSON.stringify(j)} (${Date.now() - start}ms)`);
  } catch (e) {
    console.log(`Helius RPC FETCH FAILED -> ${e.name}: ${e.message}${e.cause ? ' | cause: ' + (e.cause.code || e.cause.message) : ''}`);
  }
}

// Simulate keep-alive reuse to the local API across many calls (mimics worker pool)
console.log('--- keep-alive reuse test to API ---');
let okN = 0, failN = 0;
for (let i = 0; i < 6; i++) {
  try {
    const res = await fetch(`${process.env.API_URL}/health`);
    okN++;
  } catch (e) {
    failN++;
    console.log(`  reuse #${i}: FAILED ${e.message} | cause ${e.cause ? (e.cause.code||e.cause.message):''}`);
  }
}
console.log(`API keep-alive reuse: ok=${okN} fail=${failN}`);
