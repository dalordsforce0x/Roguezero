// Verify: is RogueCEO (SOL-based) stuck because SOL-funded entries cost more than
// USDC-funded entries on the same tokens? Measures the BUY leg price impact both ways
// at the bot's real $10 notional, on the genuine movers.
require('dotenv').config();

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const BASE = 'https://api.jup.ag/swap/v2';
const KEY = process.env.JUPITER_API_KEY;
const USDC_10 = 10_000_000;       // $10 in USDC (6 dp)
const SOL_FOR_10 = 154_070_000;   // ~$10 in SOL lamports (SOL ~ $64.91 -> 0.1541 SOL)

// the real movers that pass the exit cap (from the wide probe)
const MOVERS = [
  { sym: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { sym: 'ORCA', mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' },
  { sym: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { sym: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { sym: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { sym: 'Fartcoin', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' },
  { sym: 'DRIFT', mint: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm' },
  { sym: 'KMNO', mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS' },
  { sym: 'JTO', mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL' },
  { sym: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function impact(inputMint, outputMint, amount) {
  const url = `${BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&restrictIntermediateTokens=true`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'x-api-key': KEY }, signal: ctrl.signal });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.outAmount) return null;
    return Math.abs(Number(d.priceImpactPct || 0)) * 10000;
  } catch { return null; } finally { clearTimeout(t); }
}

async function main() {
  console.log('Entry-leg price impact, $10 notional — USDC->token vs SOL->token\n');
  console.log('Token        USDC-entry   SOL-entry    SOL penalty');
  console.log('-----------  ----------   ---------    -----------');
  let sumU = 0, sumS = 0, n = 0;
  for (const m of MOVERS) {
    const u = await impact(USDC, m.mint, USDC_10); await sleep(150);
    const s = await impact(SOL, m.mint, SOL_FOR_10); await sleep(150);
    const uStr = u == null ? 'no route' : u.toFixed(1) + 'bps';
    const sStr = s == null ? 'no route' : s.toFixed(1) + 'bps';
    const pen = (u != null && s != null) ? (s - u).toFixed(1) + 'bps' : '-';
    if (u != null && s != null) { sumU += u; sumS += s; n++; }
    console.log(`${m.sym.padEnd(11)}  ${uStr.padStart(9)}   ${sStr.padStart(9)}    ${pen.padStart(9)}`);
  }
  if (n) {
    console.log('-----------  ----------   ---------    -----------');
    console.log(`AVG (${n})      ${(sumU/n).toFixed(1).padStart(7)}bps   ${(sumS/n).toFixed(1).padStart(7)}bps    ${((sumS-sumU)/n).toFixed(1).padStart(7)}bps`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
