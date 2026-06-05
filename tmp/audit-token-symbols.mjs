const symbols = new Set(['SOL','USDC','USDT','JUP','JTO','JITOSOL','MSOL','BSOL','PYTH','W','WIF','RAY','ORCA','RENDER','BONK','KMNO','HNT','MOBILE','WETH','WBTC','USDS']);
const res = await fetch('https://cache.jup.ag/tokens');
const tokens = await res.json();
const rows = tokens
  .filter(t => symbols.has(String(t.symbol || '').toUpperCase()))
  .map(t => ({symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals, tags: t.tags}))
  .sort((a,b) => String(a.symbol).localeCompare(String(b.symbol)) || String(a.name).localeCompare(String(b.name)));
console.log(JSON.stringify(rows, null, 2));
