import { Connection, PublicKey } from '@solana/web3.js';
const rpc = process.env.HELIUS_RPC_URL ? process.env.HELIUS_RPC_URL : (process.env.SOLANA_RPC_URL ? process.env.SOLANA_RPC_URL : 'https://api.mainnet-beta.solana.com');
const c = new Connection(rpc, 'confirmed');
const acct = 'AbYg67jNv8iqEWco6Gh9m91SsFLG2sBKHyKiihvJj1P4';
const info = await c.getParsedAccountInfo(new PublicKey(acct));
console.log(JSON.stringify({
  exists: Boolean(info.value),
  owner: info.value?.owner?.toBase58?.() ?? null,
  lamports: info.value?.lamports ?? null,
  data: info.value?.data?.parsed?.info ?? null,
}, null, 2));
