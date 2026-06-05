const tokenHints = [
  ['SOL','So11111111111111111111111111111111111111112'],
  ['USDC','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  ['USDT','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'],
  ['JUP','JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'],
  ['RAY','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'],
  ['ORCA','orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'],
  ['RENDER','rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'],
  ['BONK','DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
  ['mSOL','mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'],
  ['bSOL','bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'],
  ['JitoSOL','J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'],
  ['JTO','jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'],
  ['PYTH','HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RUy4D5uT9YFuA'],
  ['W','WSoLZyWbN6gQYc4QgQm4hQWnP3LoVqKj9eV2uQGqk3m'],
  ['WIF','EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzL262Piw38Fq'],
  ['WETH','7vfCXTUXx4r3JNKC1VkS4e3s9kU4Mcgo9wPwZygQpBS'],
  ['WBTC','9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E'],
];
const SOL = 'So11111111111111111111111111111111111111112';
const amounts = [100000000, 1000000000, 5000000000]; // 0.1, 1, 5 SOL
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quote = async (mint, amount) => {
  const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
  url.searchParams.set('inputMint', SOL);
  url.searchParams.set('outputMint', mint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', '50');
  url.searchParams.set('restrictIntermediateTokens', 'true');
  const res = await fetch(url);
  if (!res.ok) return { ok:false, status:res.status, error:(await res.text()).slice(0,160) };
  const data = await res.json();
  return { ok:true, outAmount:data.outAmount, priceImpactPct:data.priceImpactPct, routePlanLength:data.routePlan?.length ?? null };
};
const rows = [];
for (const [symbol, mint] of tokenHints) {
  if (mint === SOL || mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') continue;
  const row = { symbol, mint };
  for (const amount of amounts) {
    const q = await quote(mint, amount);
    row[`${amount/1e9}SOL`] = q.ok ? { impactBps: Math.round(Number(q.priceImpactPct || 0) * 10000), routePlanLength:q.routePlanLength } : { error:q.status, text:q.error };
    await sleep(175);
  }
  rows.push(row);
}
console.log(JSON.stringify(rows, null, 2));
