// Recover an orphaned SPL token from a bricked (0-SOL) session wallet back to the
// owner wallet, WITHOUT funding the session wallet.
//
// HOW IT WORKS (the only physically possible path):
//   - The session wallet holds the token but has 0 SOL, so it cannot pay any fee.
//   - The OWNER wallet pays the transaction fee AND receives the token.
//   - The SESSION wallet only co-signs the SPL token transfer (it is the token's
//     authority). Its private key is decrypted from the DB session_keys table.
//   - One atomic transaction: create owner ATA (payer=owner) -> transfer token
//     (authority=session) -> close session ATA (rent -> owner).
//
// SECURITY: your owner private key is read from the OWNER_RECOVERY_KEY env var that
// YOU set locally in your own terminal. It is never sent anywhere. This script runs
// on your machine only. It is a one-off recovery tool, not backend code.
//
// USAGE (PowerShell):
//   $env:OWNER_RECOVERY_KEY = "<your owner wallet base58 secret key>"
//   node tmp/recover-orphaned-token.mjs c43727e8-d2ca-4345-933b-1a4dceced8a3 jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL
//   Remove-Item Env:OWNER_RECOVERY_KEY   # clear it after
//
// Existing RogueZero local env fallback: FUNNY_PAINT_PIC is also accepted as the
// owner fee-payer key and is validated against session.owner_wallet before use.
//
// Add --execute to actually send. Without it, the script only simulates and prints.

import 'dotenv/config';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  getMint,
  getAccount,
} from '@solana/spl-token';
import bs58 from 'bs58';
import pg from 'pg';
import { createDecipheriv } from 'node:crypto';

const [sessionId, tokenMintArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const EXECUTE = process.argv.includes('--execute');

if (!sessionId || !tokenMintArg) {
  console.error('Usage: node tmp/recover-orphaned-token.mjs <sessionId> <tokenMint> [--execute]');
  process.exit(1);
}

// ── Resolve RPC URL from env (Helius) ────────────────────────────────────────
const rpcUrl = Object.entries(process.env).find(
  ([k, v]) => /HELIUS|RPC|SOLANA_RPC/i.test(k) && /^https?:/i.test(v || ''),
)?.[1];
if (!rpcUrl) {
  console.error('No RPC URL found in env (looked for HELIUS/RPC/SOLANA_RPC).');
  process.exit(1);
}

// ── Decrypt session keypair (mirrors services/api/src/sessionStore.ts) ────────
const getEncryptionKey = () => {
  const k = process.env.SESSION_KEY_ENCRYPTION_KEY ?? '';
  if (!k || k.length < 32) return null;
  const keyBytes = k.length === 64 ? Buffer.from(k, 'hex') : Buffer.from(k.slice(0, 32), 'utf8');
  return keyBytes.length >= 32 ? keyBytes.subarray(0, 32) : null;
};

const decryptKeypair = (stored) => {
  if (!stored.startsWith('enc:')) return stored;
  const key = getEncryptionKey();
  if (!key) throw new Error('SESSION_KEY_ENCRYPTION_KEY required to decrypt session keypairs');
  const parts = stored.split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted keypair format');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const ciphertext = Buffer.from(parts[3], 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

const parseSecretKey = (raw) => {
  const trimmed = raw.trim();
  // JSON array form [1,2,3,...]
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  // base58 form
  return Keypair.fromSecretKey(bs58.decode(trimmed));
};

const main = async () => {
  const conn = new Connection(rpcUrl, 'confirmed');

  // 1) Load + decrypt the session keypair from the DB.
  const dbUrlRaw = (process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || '').trim();
  if (!dbUrlRaw) throw new Error('DATABASE_PRIVATE_URL / DATABASE_URL not set');
  const dbUrl = dbUrlRaw.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require');
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const sessRes = await client.query(
    'SELECT owner_wallet, session_wallet FROM sessions WHERE id = $1',
    [sessionId],
  );
  if (sessRes.rowCount === 0) throw new Error(`session ${sessionId} not found`);
  const ownerWallet = sessRes.rows[0].owner_wallet;
  const sessionWallet = sessRes.rows[0].session_wallet;

  const keyRes = await client.query(
    'SELECT keypair_base58 FROM session_keys WHERE session_id = $1',
    [sessionId],
  );
  if (keyRes.rowCount === 0) throw new Error('session_keys row not found');
  await client.end();

  const sessionKeypair = parseSecretKey(decryptKeypair(keyRes.rows[0].keypair_base58));
  if (sessionKeypair.publicKey.toBase58() !== sessionWallet) {
    throw new Error(
      `decrypted session key ${sessionKeypair.publicKey.toBase58()} != session_wallet ${sessionWallet}`,
    );
  }

  // 2) Load the owner keypair from env (typed locally by the user).
  const ownerSecret = process.env.OWNER_RECOVERY_KEY || process.env.FUNNY_PAINT_PIC;
  if (!ownerSecret) {
    throw new Error(
      'OWNER_RECOVERY_KEY / FUNNY_PAINT_PIC not set. Set it locally to your owner wallet secret key, then re-run.',
    );
  }
  const ownerKeypair = parseSecretKey(ownerSecret);
  if (ownerKeypair.publicKey.toBase58() !== ownerWallet) {
    throw new Error(
      `OWNER_RECOVERY_KEY pubkey ${ownerKeypair.publicKey.toBase58()} != session owner_wallet ${ownerWallet}. Refusing.`,
    );
  }

  const ownerPubkey = ownerKeypair.publicKey;
  const sessionPubkey = sessionKeypair.publicKey;
  const tokenMint = new PublicKey(tokenMintArg);

  // 3) Determine the token program (Token vs Token-2022) and read source balance.
  let programId = TOKEN_PROGRAM_ID;
  let mintInfo;
  try {
    mintInfo = await getMint(conn, tokenMint, 'confirmed', TOKEN_PROGRAM_ID);
  } catch {
    mintInfo = await getMint(conn, tokenMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    programId = TOKEN_2022_PROGRAM_ID;
  }

  const sourceAta = getAssociatedTokenAddressSync(tokenMint, sessionPubkey, false, programId);
  const destAta = getAssociatedTokenAddressSync(tokenMint, ownerPubkey, false, programId);

  const sourceAcct = await getAccount(conn, sourceAta, 'confirmed', programId);
  const amount = sourceAcct.amount; // bigint, raw atomic
  if (amount === 0n) {
    console.log('Source token balance is 0 — nothing to recover.');
    return;
  }

  console.log('Recovery plan:');
  console.log('  session wallet (source):', sessionPubkey.toBase58());
  console.log('  owner wallet (fee payer + dest):', ownerPubkey.toBase58());
  console.log('  token mint:', tokenMint.toBase58(), `(program ${programId.toBase58()})`);
  console.log('  amount:', amount.toString(), `(${Number(amount) / 10 ** mintInfo.decimals})`);
  console.log('  source ATA:', sourceAta.toBase58());
  console.log('  dest ATA:', destAta.toBase58());

  // 4) Build instructions.
  const ixs = [];

  // Create owner's ATA if missing (payer = owner).
  const destInfo = await conn.getAccountInfo(destAta, 'confirmed');
  if (!destInfo) {
    ixs.push(
      createAssociatedTokenAccountInstruction(ownerPubkey, destAta, ownerPubkey, tokenMint, programId),
    );
    console.log('  + will create owner ATA');
  }

  // Transfer the token (authority = session).
  ixs.push(
    createTransferCheckedInstruction(
      sourceAta,
      tokenMint,
      destAta,
      sessionPubkey,
      amount,
      mintInfo.decimals,
      [],
      programId,
    ),
  );

  // Close the now-empty source ATA, returning its rent lamports to the owner.
  ixs.push(
    createCloseAccountInstruction(sourceAta, ownerPubkey, sessionPubkey, [], programId),
  );

  const buildTx = async () => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: ownerPubkey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
        ...ixs,
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([ownerKeypair, sessionKeypair]);
    return { tx, blockhash, lastValidBlockHeight };
  };

  // 5) Build a v0 transaction with owner as fee payer.
  let { tx, blockhash, lastValidBlockHeight } = await buildTx();

  // 6) Simulate.
  const sim = await conn.simulateTransaction(tx, { commitment: 'confirmed' });
  if (sim.value.err) {
    console.error('SIMULATION FAILED:', JSON.stringify(sim.value.err));
    console.error('logs:', sim.value.logs);
    process.exit(1);
  }
  console.log('Simulation OK. unitsConsumed:', sim.value.unitsConsumed);

  if (!EXECUTE) {
    console.log('\nDry run only. Re-run with --execute to send the recovery transaction.');
    return;
  }

  let lastSig = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      ({ tx, blockhash, lastValidBlockHeight } = await buildTx());
    }
    lastSig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 10 });
    console.log(`Submitted recovery tx attempt ${attempt}:`, lastSig);
    try {
      const conf = await conn.confirmTransaction(
        { signature: lastSig, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (conf.value.err) {
        console.error('Confirmation error:', JSON.stringify(conf.value.err));
        process.exit(1);
      }
      console.log('CONFIRMED. Token recovered to owner wallet:', ownerPubkey.toBase58());
      return;
    } catch (err) {
      const status = await conn.getSignatureStatus(lastSig, { searchTransactionHistory: true });
      if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
        console.log('CONFIRMED by signature status. Token recovered to owner wallet:', ownerPubkey.toBase58());
        return;
      }
      console.error(`Attempt ${attempt} not confirmed:`, err.message || String(err));
    }
  }
  throw new Error(`Recovery transaction did not confirm after retries. Last signature: ${lastSig}`);
};

main().catch((err) => {
  console.error('ERROR:', err.message || String(err));
  process.exit(1);
});
