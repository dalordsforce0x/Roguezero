import 'dotenv/config';

const WALLET = '4gCXvwijgnF83ZenbHUP3LCiTtKh55ZFzyLuRynEVezD';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JTO = 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL';
const HNT = 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function findRpc() {
  for (const k of Object.keys(process.env)) {
    if (/HELIUS|RPC|SOLANA_RPC/i.test(k) && /^https?:/i.test(process.env[k] || '')) {
      return process.env[k];
    }
  }
  return null;
}

const url = findRpc();
if (!url) { console.log('no rpc'); process.exit(1); }

async function rpc(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

const bal = await rpc('getBalance', [WALLET]);
console.log('SOL lamports:', bal.result?.value, '=', (bal.result?.value ?? 0) / 1e9, 'SOL');

for (const prog of [TOKEN_PROGRAM, TOKEN_2022]) {
  const accts = await rpc('getTokenAccountsByOwner', [
    WALLET,
    { programId: prog },
    { encoding: 'jsonParsed' },
  ]);
  const list = accts.result?.value ?? [];
  console.log(`\n--- program ${prog === TOKEN_PROGRAM ? 'TOKEN' : 'TOKEN-2022'}: ${list.length} accounts ---`);
  for (const a of list) {
    const info = a.account.data.parsed.info;
    const mint = info.mint;
    const amt = info.tokenAmount.uiAmountString;
    const label = mint === USDC ? 'USDC' : mint === JTO ? 'JTO' : mint === HNT ? 'HNT' : mint.slice(0, 8);
    console.log(`  ${label.padEnd(6)} mint=${mint} amount=${amt} acct=${a.pubkey}`);
  }
}

console.log('\nATA existence check:');
console.log('  USDC ATA exists?', '(see above list)');
