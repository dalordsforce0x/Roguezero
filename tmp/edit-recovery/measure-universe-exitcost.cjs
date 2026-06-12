// Proof: does the live scan universe actually contain tokens the bot can exit cheaply?
// Measures real round-trip cost (buy USDC->mint, then sell mint->USDC) for every enabled
// token via the SAME Jupiter quote path the worker uses, at the bot's probe notional ($10).
require('dotenv').config();
const fs = require('fs');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE = 'https://api.jup.ag/swap/v2';
const KEY = process.env.JUPITER_API_KEY;
const NOTIONAL = 10_000_000; // $10 USDC, 6 decimals — the worker's probe notional
const PLATFORM_FEE_BPS = 35;
const SELL_IMPACT_CAP_BPS = 12; // WORKER_MAX_ENTRY_SELL_IMPACT_BPS

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(inputMint, outputMint, amount) {
  const url = `${BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&restrictIntermediateTokens=true`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'x-api-key': KEY } });
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();
  return { ok: true, outAmount: Number(data.outAmount), impactBps: Math.abs(Number(data.priceImpactPct || 0)) * 10000 };
}

async function main() {
  const schemaPath = process.argv[2];
  const rows = JSON.parse(fs.readFileSync(schemaPath, 'utf8')).rows;
  const tokens = rows.filter((r) => r.mint !== USDC && r.mint !== 'So11111111111111111111111111111111111111112');
  console.log(`Testing ${tokens.length} enabled tokens (excluding USDC/SOL) at $10 notional...\n`);

  const results = [];
  for (const t of tokens) {
    try {
      const buy = await quote(USDC, t.mint, NOTIONAL);
      await sleep(180);
      if (!buy.ok || !buy.outAmount) { results.push({ ...t, noRoute: true }); continue; }
      const sell = await quote(t.mint, USDC, buy.outAmount);
      await sleep(180);
      if (!sell.ok || !sell.outAmount) { results.push({ ...t, noRoute: true }); continue; }
      const buyBps = buy.impactBps;
      const sellBps = sell.impactBps;
      const roundTripImpact = buyBps + sellBps;
      // total round-trip cost incl 2x platform fee (fee taken each leg)
      const totalCost = roundTripImpact + PLATFORM_FEE_BPS * 2;
      results.push({ ...t, buyBps, sellBps, roundTripImpact, totalCost });
    } catch (e) {
      results.push({ ...t, error: String(e).slice(0, 60) });
    }
  }

  const priced = results.filter((r) => r.totalCost != null);
  const noRoute = results.filter((r) => r.noRoute);
  const errored = results.filter((r) => r.error);

  const sellPass = priced.filter((r) => r.sellBps <= SELL_IMPACT_CAP_BPS);
  const rtUnder70 = priced.filter((r) => r.totalCost <= 70);
  const rtUnder120 = priced.filter((r) => r.totalCost <= 120);

  console.log('=== RESULTS ===');
  console.log(`Priced (both legs routed): ${priced.length}`);
  console.log(`No route:                  ${noRoute.length}`);
  console.log(`Errored:                   ${errored.length}`);
  console.log('');
  console.log(`Sell-leg impact <= ${SELL_IMPACT_CAP_BPS}bps (the bot's exit cap): ${sellPass.length} / ${priced.length}`);
  console.log(`Round-trip total cost <= 70bps:  ${rtUnder70.length} / ${priced.length}`);
  console.log(`Round-trip total cost <= 120bps: ${rtUnder120.length} / ${priced.length}`);
  console.log('');
  console.log('Tokens passing the 12bps sell cap:');
  sellPass.sort((a, b) => a.sellBps - b.sellBps).forEach((r) =>
    console.log(`  ${(r.symbol||'?').padEnd(12)} sell=${r.sellBps.toFixed(1)}bps buy=${r.buyBps.toFixed(1)}bps rt+fees=${r.totalCost.toFixed(0)}bps`));
  console.log('');
  console.log('Worst 15 sell-leg tokens (most expensive to exit):');
  priced.sort((a, b) => b.sellBps - a.sellBps).slice(0, 15).forEach((r) =>
    console.log(`  ${(r.symbol||'?').padEnd(12)} sell=${r.sellBps.toFixed(1)}bps buy=${r.buyBps.toFixed(1)}bps`));

  fs.writeFileSync('tmp/edit-recovery/universe-exitcost-results.json', JSON.stringify(results, null, 2));
  console.log('\nFull results written to tmp/edit-recovery/universe-exitcost-results.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
