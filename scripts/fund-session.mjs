/**
 * One-off: send SOL from a funding wallet to a session_wallet to restore gas.
 *
 * The funder secret key is read ONLY from the FUNDER_SECRET_KEY env var so it
 * never appears in shell history or source. Set it directly in your terminal.
 *
 * Usage (PowerShell):
 *   $env:FUNDER_SECRET_KEY = "<bs58-secret-key>"
 *   node scripts/fund-session.mjs <recipient-session-wallet> <amount>
 *
 * <amount> may be either an absolute SOL value (e.g. 0.02) or a percentage of
 * the funder wallet's spendable balance (e.g. 95%). When a percentage is given,
 * the script reserves the network fee so the transfer always lands.
 *
 * Examples:
 *   node scripts/fund-session.mjs 64zsneT71Rp9CchtvwBBz1p7k13KszSMuBqtkF3U76H2 0.02
 *   node scripts/fund-session.mjs 64zsneT71Rp9CchtvwBBz1p7k13KszSMuBqtkF3U76H2 95%
 */
import 'dotenv/config';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const RECIPIENT = process.argv[2];
const AMOUNT_ARG = (process.argv[3] ?? '').trim();
const IS_PCT = AMOUNT_ARG.endsWith('%');
const PCT = IS_PCT ? Number(AMOUNT_ARG.slice(0, -1)) : NaN;
const AMOUNT_SOL = IS_PCT ? NaN : Number(AMOUNT_ARG);

if (!RECIPIENT) {
  console.error('Usage: node scripts/fund-session.mjs <recipient-session-wallet> <amount|pct%>');
  process.exit(1);
}
if (IS_PCT) {
  if (!Number.isFinite(PCT) || PCT <= 0 || PCT > 100) {
    console.error('Percentage must be a number in (0, 100], e.g. 95%');
    process.exit(1);
  }
} else if (!Number.isFinite(AMOUNT_SOL) || AMOUNT_SOL <= 0) {
  console.error('Amount must be a positive SOL value (e.g. 0.02) or a percentage (e.g. 95%)');
  process.exit(1);
}

const secret = (process.env.FUNDER_SECRET_KEY ?? process.env.FUNNY_PAINT_PIC)?.trim();
if (!secret) {
  console.error('FUNDER_SECRET_KEY (or FUNNY_PAINT_PIC) env var is required.');
  process.exit(1);
}

const rpcUrl = process.env.HELIUS_RPC_URL?.trim();
if (!rpcUrl) {
  console.error('HELIUS_RPC_URL is required (from .env).');
  process.exit(1);
}

const conn = new Connection(rpcUrl, 'confirmed');

async function main() {
  const FEE_RESERVE_LAMPORTS = 5000;
  const funder = Keypair.fromSecretKey(bs58.decode(secret));
  const recipient = new PublicKey(RECIPIENT);

  console.log('Funder:   ', funder.publicKey.toBase58());
  console.log('Recipient:', recipient.toBase58());

  const funderBalance = await conn.getBalance(funder.publicKey, 'confirmed');
  console.log('Funder balance:', funderBalance / LAMPORTS_PER_SOL, 'SOL');

  const lamports = IS_PCT
    ? Math.floor((funderBalance - FEE_RESERVE_LAMPORTS) * (PCT / 100))
    : Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);

  if (lamports <= 0) {
    console.error('Computed transfer amount is not positive (funder balance too low).');
    process.exit(1);
  }
  console.log(
    'Amount:   ',
    lamports / LAMPORTS_PER_SOL,
    'SOL',
    `(${lamports} lamports)`,
    IS_PCT ? `= ${PCT}% of spendable balance` : '',
  );

  if (funderBalance < lamports + FEE_RESERVE_LAMPORTS) {
    console.error('Funder has insufficient SOL for transfer + fee.');
    process.exit(1);
  }

  const before = await conn.getBalance(recipient, 'confirmed');
  console.log('Recipient balance before:', before / LAMPORTS_PER_SOL, 'SOL');

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: funder.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: recipient,
        lamports,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([funder]);

  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  console.log('Submitted:', sig);

  const confirmation = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (confirmation.value.err) {
    console.error('Transfer failed:', confirmation.value.err);
    process.exit(1);
  }

  const after = await conn.getBalance(recipient, 'confirmed');
  console.log('Recipient balance after: ', after / LAMPORTS_PER_SOL, 'SOL');
  console.log('Done. Signature:', sig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
