import 'dotenv/config';
import bs58 from 'bs58';
import { Connection, Keypair, Transaction } from '@solana/web3.js';

const sessionId = process.argv[2] ?? 'c8615dfb-e87b-4274-ac86-d88253958296';
const api = process.env.API_URL ?? 'http://localhost:4000';
const secret = process.env.RZ_INTERNAL_SECRET;

if (!process.env.FUNNY_PAINT_PIC) {
  throw new Error('FUNNY_PAINT_PIC missing');
}
if (!secret) {
  throw new Error('RZ_INTERNAL_SECRET missing');
}
if (!process.env.HELIUS_RPC_URL) {
  throw new Error('HELIUS_RPC_URL missing');
}

const kp = Keypair.fromSecretKey(bs58.decode(process.env.FUNNY_PAINT_PIC));

const quoteRes = await fetch(`${api}/sessions/${sessionId}/funding-quote`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-rz-internal-secret': secret,
  },
  body: JSON.stringify({ requestedUsd: 5 }),
});

const quote = await quoteRes.json();
if (!quoteRes.ok) {
  console.error('QUOTE_ERR', quote);
  process.exit(1);
}

const tx = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));
tx.partialSign(kp);

const conn = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
const signature = await conn.sendRawTransaction(tx.serialize(), {
  skipPreflight: false,
  preflightCommitment: 'confirmed',
});

await conn.confirmTransaction(
  {
    signature,
    blockhash: quote.blockhash,
    lastValidBlockHeight: quote.lastValidBlockHeight,
  },
  'confirmed',
);

console.log(JSON.stringify({
  sessionId,
  ownerWallet: kp.publicKey.toBase58(),
  sessionWallet: quote.sessionWallet,
  requestedLamports: quote.requestedLamports,
  signature,
}, null, 2));
