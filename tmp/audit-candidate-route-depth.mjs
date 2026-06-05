const candidates = [
  ['USDT','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB','stable'],
  ['JUP','JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN','major'],
  ['RAY','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R','volatile_dex_token'],
  ['ORCA','orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE','volatile_dex_token'],
  ['RENDER','rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof','volatile_depinned'],
  ['BONK','DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263','meme_high_vol'],
  ['mSOL','mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So','lst'],
  ['bSOL','bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1','lst'],
  ['JitoSOL','J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn','lst'],
  ['JTO','jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL','major'],
  ['PYTH','HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3','major'],
  ['W','85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ','major'],
  ['KMNO','KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS','major'],
  ['HNT','hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux','sector'],
  ['MOBILE','mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6','sector'],
  ['WBTC','3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh','wrapped_bluechip'],
];
const SOL = 'So11111111111111111111111111111111111111112';
const amounts = [100000000, 1000000000, 5000000000, 10000000000];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function quote(mint, amount) {
  const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
  url.searchParams.set('inputMint', SOL);
  url.searchParams.set('outputMint', mint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', '50');
  url.searchParams.set('restrictIntermediateTokens', 'true');
  const res = await fetch(url);
  if (!res.ok) return { ok:false, status:res.status, error:(await res.text()).slice(0,120) };
  const data = await res.json();
  return { ok:true, impactBps: Math.round(Number(data.priceImpactPct || 0) * 10000), routePlanLength: data.routePlan?.length ?? null };
}
const rows=[];
for (const [symbol,mint,bucket] of candidates) {
  const impacts=[]; const result={symbol,mint,bucket};
  for (const amount of amounts) {
    const q=await quote(mint, amount); await sleep(175);
    result[`${amount/1e9}SOL`]=q.ok ? {impactBps:q.impactBps, routePlanLength:q.routePlanLength} : {error:q.status, text:q.error};
    if (q.ok) impacts.push(q.impactBps); else impacts.push(999999);
  }
  result.maxImpactBps=Math.max(...impacts);
  result.pass5Sol=typeof result['5SOL']?.impactBps === 'number' && result['5SOL'].impactBps <= 50;
  result.pass10Sol=typeof result['10SOL']?.impactBps === 'number' && result['10SOL'].impactBps <= 100;
  rows.push(result);
}
rows.sort((a,b)=>a.maxImpactBps-b.maxImpactBps);
console.log(JSON.stringify(rows, null, 2));
