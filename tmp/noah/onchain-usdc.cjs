require('dotenv').config();
const RPC = process.env.HELIUS_RPC_URL;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const WALLETS = {
  'OLD session 8FvnRY': '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC',
  'NEW session ZfnpgA': 'ZfnpgA1mGBecTL3aCgriYe2oiEbSnofsjY9Fi73kgpD',
  'owner GJmDpM':       'GJmDpMoaKQzLdHxqwJL5rzA53cU2bsaVn4uwPfDQrx6g',
};

async function rpc(method, params) {
  const res = await fetch(RPC, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) });
  return (await res.json()).result;
}

(async () => {
  for (const [label, addr] of Object.entries(WALLETS)) {
    const r = await rpc('getTokenAccountsByOwner', [addr, { mint: USDC }, { encoding:'jsonParsed' }]);
    let usdc = 0;
    for (const acc of (r?.value ?? [])) {
      usdc += Number(acc.account.data.parsed.info.tokenAmount.uiAmount || 0);
    }
    console.log(`${label.padEnd(22)} USDC = ${usdc}`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
