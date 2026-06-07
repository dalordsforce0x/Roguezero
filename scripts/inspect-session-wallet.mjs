/**
 * Read-only inspector: reports on-chain SOL + SPL token holdings of a session
 * wallet, so we can see what (if anything) is stranded after a failed sweep.
 *
 * Usage: node scripts/inspect-session-wallet.mjs <session-wallet-pubkey>
 */
import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';

const WALLET = process.argv[2];
if (!WALLET) { console.error('Usage: node scripts/inspect-session-wallet.mjs <session-wallet>'); process.exit(1); }

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const conn = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
const owner = new PublicKey(WALLET);

const sol = await conn.getBalance(owner);
console.log('SOL lamports:', sol, `(${(sol / 1e9).toFixed(6)} SOL)`);

let totalTokenAccounts = 0;
let nonEmpty = 0;
for (const [label, programId] of [['Token', TOKEN_PROGRAM_ID], ['Token-2022', TOKEN_2022_PROGRAM_ID]]) {
  const res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
  for (const { pubkey, account } of res.value) {
    totalTokenAccounts += 1;
    const info = account.data.parsed.info;
    const amount = info.tokenAmount.amount;
    const uiAmount = info.tokenAmount.uiAmountString;
    const mint = info.mint;
    if (amount !== '0') {
      nonEmpty += 1;
      console.log(`${label} ACCT ${pubkey.toBase58()} mint=${mint} amount=${amount} (${uiAmount})`);
    } else {
      console.log(`${label} ACCT ${pubkey.toBase58()} mint=${mint} EMPTY (rent-only)`);
    }
  }
}

console.log(`\nSUMMARY: ${totalTokenAccounts} token accounts, ${nonEmpty} with non-zero balance, SOL=${(sol / 1e9).toFixed(6)}`);
await conn.getSlot(); // flush
process.exit(0);
