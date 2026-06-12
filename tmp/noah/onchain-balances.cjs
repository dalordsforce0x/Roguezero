require('dotenv').config();

const RPC = process.env.HELIUS_RPC_URL;
const WALLETS = {
  'NEW RogueCEO session_wallet': 'ZfnpgA1mGBecTL3aCgriYe2oiEbSnofsjY9Fi73kgpD',
  'OLD RogueCEO session_wallet': '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC',
  'RogueCEO owner_wallet':       'GJmDpMoaKQzLdHxqwJL5rzA53cU2bsaVn4uwPfDQrx6g',
};

(async () => {
  for (const [label, addr] of Object.entries(WALLETS)) {
    const body = { jsonrpc:'2.0', id:1, method:'getBalance', params:[addr] };
    const res = await fetch(RPC, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const j = await res.json();
    const lamports = j.result?.value ?? null;
    const sol = lamports == null ? '?' : (lamports/1e9).toFixed(6);
    console.log(`${label.padEnd(30)} ${addr}  = ${lamports} lamports (${sol} SOL)`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
