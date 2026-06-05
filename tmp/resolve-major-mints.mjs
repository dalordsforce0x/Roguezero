const needles = ['PYTH','W','WIF','WETH','WBTC','JTO','JitoSOL','JITOSOL','KMNO','HNT','MOBILE'];
const tokens = await (await fetch('https://cache.jup.ag/tokens')).json();
for (const needle of needles) {
  const rows = tokens
    .filter(t => String(t.symbol || '').toUpperCase() === needle.toUpperCase() || String(t.name || '').toUpperCase().includes(needle.toUpperCase()))
    .map(t => ({symbol:t.symbol, name:t.name, address:t.address, decimals:t.decimals, tags:t.tags}))
    .slice(0, 20);
  console.log('\n###', needle, rows.length);
  console.log(JSON.stringify(rows, null, 2));
}
