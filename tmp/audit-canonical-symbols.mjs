const want = new Set(['SOL','USDC','USDT','JUP','JTO','JITOSOL','MSOL','BSOL','PYTH','W','WIF','RAY','ORCA','RENDER','BONK','KMNO','HNT','MOBILE','WETH','WBTC','USDS']);
const tokens = await (await fetch('https://cache.jup.ag/tokens')).json();
const rows = tokens
  .filter(t => want.has(String(t.symbol || '').toUpperCase()))
  .filter(t => Array.isArray(t.tags) && (t.tags.includes('old-registry') || t.tags.includes('strict') || t.tags.includes('verified')))
  .map(t => ({symbol: String(t.symbol).toUpperCase(), name: t.name, address: t.address, decimals: t.decimals, tags: t.tags}))
  .sort((a,b) => a.symbol.localeCompare(b.symbol) || a.name.localeCompare(b.name));
console.log(JSON.stringify(rows, null, 2));
