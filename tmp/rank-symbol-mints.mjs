const want = ['PYTH','W','WIF','WETH','WBTC','JTO','JitoSOL','KMNO','HNT','MOBILE','USDS'];
const tokens = await (await fetch('https://cache.jup.ag/tokens')).json();
const tagScore = (tags=[]) => (tags.includes('strict')?100:0)+(tags.includes('verified')?80:0)+(tags.includes('old-registry')?60:0)+(tags.includes('solana-fm')?20:0)+(tags.includes('community')?5:0)-(tags.includes('unknown')?50:0)-(tags.includes('token-2022')?5:0);
for (const sym of want) {
  const rows = tokens
    .filter(t => String(t.symbol || '').toUpperCase() === sym.toUpperCase())
    .map(t => ({symbol:t.symbol, name:t.name, address:t.address, decimals:t.decimals, tags:t.tags, score:tagScore(t.tags)}))
    .sort((a,b) => b.score-a.score || String(a.name).localeCompare(String(b.name)))
    .slice(0, 8);
  console.log('\n### ' + sym);
  for (const r of rows) console.log(JSON.stringify(r));
}
