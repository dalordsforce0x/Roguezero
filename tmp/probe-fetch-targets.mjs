import 'dotenv/config';

const targets = [
  { name: 'API', url: (process.env.API_URL || 'http://127.0.0.1:4000') + '/health' },
  { name: 'API_root', url: (process.env.API_URL || 'http://127.0.0.1:4000') + '/' },
  { name: 'PythHermes', url: 'https://hermes.pyth.network/v2/updates/price/latest?ids[]=ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d' },
  { name: 'JupiterPrice', url: 'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112' },
];

console.log('API_URL env =', JSON.stringify(process.env.API_URL));

for (const t of targets) {
  const start = Date.now();
  try {
    const res = await fetch(t.url, { signal: AbortSignal.timeout(8000) });
    console.log(`${t.name}: ${res.status} ${res.statusText} (${Date.now() - start}ms)`);
  } catch (e) {
    console.log(`${t.name}: FETCH FAILED -> ${e.name}: ${e.message}${e.cause ? ' | cause: ' + (e.cause.code || e.cause.message) : ''} (${Date.now() - start}ms)`);
  }
}
