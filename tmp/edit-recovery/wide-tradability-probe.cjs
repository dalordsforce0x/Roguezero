// Wide tradability probe: measures real buy+sell round-trip impact for EVERY token
// in rz_token_universe (enabled + disabled) at multiple notionals, to count how many
// tokens 350 bots could actually trade. Slippage only — fee is our own 0.33% revenue.
require('dotenv').config();
const fs = require('fs');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const BASE = 'https://api.jup.ag/swap/v2';
const KEY = process.env.JUPITER_API_KEY;
const SELL_CAP = 12; // WORKER_MAX_ENTRY_SELL_IMPACT_BPS
const NOTIONALS = [10_000_000, 50_000_000]; // $10, $50

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readUniverse(path) {
  let buf = fs.readFileSync(path);
  // strip UTF-16 LE/BE BOM if present
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le');
  else if (buf[0] === 0xfe && buf[1] === 0xff) { buf = buf.swap16(); text = buf.toString('utf16le'); }
  else text = buf.toString('utf8');
  text = text.replace(/^\uFEFF/, '');
  return JSON.parse(text).rows;
}

async function quote(inputMint, outputMint, amount) {
  const url = `${BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&restrictIntermediateTokens=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'x-api-key': KEY }, signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.outAmount) return null;
    return { outAmount: Number(data.outAmount), impactBps: Math.abs(Number(data.priceImpactPct || 0)) * 10000 };
  } catch { return null; } finally { clearTimeout(timer); }
}

async function probeAt(mint, notional) {
  const buy = await quote(USDC, mint, notional);
  await sleep(120);
  if (!buy) return { route: false };
  const sell = await quote(mint, USDC, buy.outAmount);
  await sleep(120);
  if (!sell) return { route: false };
  return { route: true, buyBps: buy.impactBps, sellBps: sell.impactBps };
}

async function main() {
  const rows = readUniverse('tmp/edit-recovery/full-universe.json')
    .filter((r) => r.mint !== USDC && r.mint !== SOL);
  console.log(`Probing ${rows.length} tokens at $10 and $50...\n`);

  const results = [];
  let done = 0;
  const CONCURRENCY = 8;
  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const t = rows[idx++];
      const r = { mint: t.mint, symbol: t.symbol, enabled: t.enabled === 't' || t.enabled === true };
      const at10 = await probeAt(t.mint, NOTIONALS[0]);
      r.route10 = at10.route;
      if (at10.route) { r.sell10 = at10.sellBps; r.buy10 = at10.buyBps; }
      if (at10.route) {
        const at50 = await probeAt(t.mint, NOTIONALS[1]);
        r.route50 = at50.route;
        if (at50.route) { r.sell50 = at50.sellBps; r.buy50 = at50.buyBps; }
      }
      results.push(r);
      done += 1;
      if (done % 50 === 0) { console.log(`  ...${done}/${rows.length}`); fs.writeFileSync('tmp/edit-recovery/wide-tradability-results.json', JSON.stringify(results, null, 2)); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  fs.writeFileSync('tmp/edit-recovery/wide-tradability-results.json', JSON.stringify(results, null, 2));

  const routed10 = results.filter((r) => r.route10);
  const pass10 = routed10.filter((r) => r.sell10 <= SELL_CAP);
  const pass50 = results.filter((r) => r.route50 && r.sell50 <= SELL_CAP);
  const pass10enabled = pass10.filter((r) => r.enabled).length;
  const pass10disabled = pass10.filter((r) => !r.enabled).length;

  console.log('\n=== WIDE TRADABILITY (sell-leg <= 12bps) ===');
  console.log(`Total probed:            ${results.length}`);
  console.log(`Routed at $10:           ${routed10.length}`);
  console.log(`Exitable @ $10 (<=12bps): ${pass10.length}  (enabled now: ${pass10enabled}, currently DISABLED: ${pass10disabled})`);
  console.log(`Exitable @ $50 (<=12bps): ${pass50.length}`);
  console.log('');
  console.log('Currently-DISABLED tokens that ARE exitable @ $10 (hidden tradable inventory):');
  pass10.filter((r) => !r.enabled).sort((a, b) => a.sell10 - b.sell10).forEach((r) =>
    console.log(`  ${(r.symbol||'?').padEnd(14)} sell@10=${r.sell10.toFixed(1)}bps  sell@50=${r.sell50!=null?r.sell50.toFixed(1):'n/a'}bps`));

  console.log('\nFull results -> tmp/edit-recovery/wide-tradability-results.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
