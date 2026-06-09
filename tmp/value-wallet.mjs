// Read-only: value a wallet's holdings at real Jupiter liquidation price (sell -> USDC)
// and compute true PnL vs a funded USDC amount. No keys printed.
import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';

const WALLET = process.argv[2];
const FUNDED_USDC = Number(process.argv[3] ?? '0');
if (!WALLET) { console.error('usage: node tmp/value-wallet.mjs <wallet> <fundedUsdc>'); process.exit(1); }

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const conn = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
const owner = new PublicKey(WALLET);

const lamports = await conn.getBalance(owner);

const holdings = []; // {mint, amountAtomic}
for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
  const res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
  for (const { account } of res.value) {
    const info = account.data.parsed.info;
    if (info.tokenAmount.amount !== '0') {
      holdings.push({ mint: info.mint, amountAtomic: info.tokenAmount.amount, decimals: info.tokenAmount.decimals });
    }
  }
}

// quote helper: sell amountAtomic of `mint` into USDC via Jupiter Lite quote
const quoteToUsdc = async (mint, amountAtomic) => {
  if (mint === USDC) return Number(amountAtomic) / 1e6;
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${USDC}&amount=${amountAtomic}&slippageBps=100`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  return j?.outAmount ? Number(j.outAmount) / 1e6 : null;
};

let total = 0;
console.log(`\nFunded in: ${FUNDED_USDC.toFixed(2)} USDC\n--- current holdings (liquidation value) ---`);

// SOL value (keep dust as gas, but value it for completeness)
const solUsdc = await quoteToUsdc(SOL, lamports);
if (solUsdc != null) { console.log(`SOL    ${(lamports/1e9).toFixed(6)}  -> $${solUsdc.toFixed(2)}`); total += solUsdc; }

for (const h of holdings) {
  const v = await quoteToUsdc(h.mint, h.amountAtomic);
  const ui = Number(h.amountAtomic) / 10 ** h.decimals;
  console.log(`${h.mint.slice(0,6)}.. ${ui.toFixed(4)}  -> ${v == null ? 'NO ROUTE' : '$' + v.toFixed(2)}`);
  if (v != null) total += v;
}

console.log(`\nTOTAL current value: $${total.toFixed(2)}`);
console.log(`TRUE PnL (current - funded): $${(total - FUNDED_USDC).toFixed(2)}`);
process.exit(0);
