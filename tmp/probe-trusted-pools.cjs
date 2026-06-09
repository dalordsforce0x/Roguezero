// Probe trusted mints (excl SOL/stables) with 3s spacing to confirm pools exist.
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const SOL = 'So11111111111111111111111111111111111111112';
const stables = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const trusted = [
  SOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',
  'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',
  'SHDWyBxihqiCjDYwvisits5jfez2EfbR347c5cKAgqje',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchJson = async (url) => {
  for (let a = 0; a < 3; a++) {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (r.status === 429) { await sleep(3000 * (a + 1)); continue; }
    if (!r.ok) return { __status: r.status };
    return r.json();
  }
  return { __429: true };
};
(async () => {
  const mints = trusted.filter((m) => m !== SOL && !stables.has(m));
  let withPool = 0, withCandles = 0;
  for (const mint of mints) {
    await sleep(3000);
    const p = await fetchJson(`${GT}/tokens/${mint}/pools?page=1`);
    const pool = p?.data?.[0]?.attributes?.address;
    if (!pool) { console.log(mint.slice(0, 6), 'NO POOL', p?.__status || p?.__429 || ''); continue; }
    withPool++;
    await sleep(3000);
    const now = Math.floor(Date.now() / 1000);
    const o = await fetchJson(`${GT}/pools/${pool}/ohlcv/minute?aggregate=1&before_timestamp=${now + 60}&limit=200&currency=usd`);
    const list = o?.data?.attributes?.ohlcv_list || [];
    if (list.length >= 30) withCandles++;
    console.log(mint.slice(0, 6), 'pool', 'candles=' + list.length, list[0] ? 'ageMin=' + ((now - Number(list[0][0])) / 60).toFixed(1) : '');
  }
  console.log(`\nSUMMARY: ${mints.length} mints, ${withPool} have pools, ${withCandles} have >=30 candles`);
})();
