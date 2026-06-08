/**
 * One-time sweep script: transfers all SOL + USDC from a stopped session wallet
 * back to the session's owner_wallet.
 *
 * Usage: node scripts/sweep-session.mjs <session-id>
 */
import 'dotenv/config';
import pg from 'pg';
import bs58 from 'bs58';
import { createDecipheriv } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';

const SESSION_ID = process.argv[2];
if (!SESSION_ID) { console.error('Usage: node scripts/sweep-session.mjs <session-id>'); process.exit(1); }

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT  = 'So11111111111111111111111111111111111111112';

// Mirror the worker's AES-256-GCM keypair encryption (enc:iv:tag:ciphertext).
const decryptKeypair = (stored) => {
  if (!stored.startsWith('enc:')) return stored;
  const envKey = process.env.SESSION_KEY_ENCRYPTION_KEY ?? '';
  if (!envKey || envKey.length < 32) throw new Error('SESSION_KEY_ENCRYPTION_KEY required to decrypt session keypairs');
  const keyBytes = envKey.length === 64
    ? Buffer.from(envKey, 'hex')
    : Buffer.from(envKey.slice(0, 32), 'utf8');
  const key = keyBytes.subarray(0, 32);
  const parts = stored.split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted keypair format');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const ciphertext = Buffer.from(parts[3], 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

// DB
const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const dbUrl = new URL(databaseUrl);
dbUrl.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: false } });

// RPC
const conn = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');

async function main() {
  // Fetch session
  const sessionRes = await pool.query('SELECT * FROM sessions WHERE id = $1', [SESSION_ID]);
  if (!sessionRes.rowCount) { console.error('Session not found:', SESSION_ID); process.exit(1); }
  const session = sessionRes.rows[0];
  console.log('Session status:', session.status);
  console.log('Session wallet:', session.session_wallet);
  console.log('Owner wallet:  ', session.owner_wallet);

  if (session.owner_wallet === SOL_MINT) {
    console.error('owner_wallet is still the SOL mint placeholder. Update it first.');
    process.exit(1);
  }

  // Fetch keypair
  const keyRes = await pool.query('SELECT keypair_base58 FROM session_keys WHERE session_id = $1', [SESSION_ID]);
  if (!keyRes.rowCount) { console.error('No keypair found for session'); process.exit(1); }
  const keypair = Keypair.fromSecretKey(bs58.decode(decryptKeypair(keyRes.rows[0].keypair_base58)));

  if (keypair.publicKey.toBase58() !== session.session_wallet) {
    console.error('Keypair mismatch! Stored pubkey:', keypair.publicKey.toBase58());
    process.exit(1);
  }

  const ownerPubkey = new PublicKey(session.owner_wallet);
  const sessionPubkey = keypair.publicKey;
  const usdcMintPubkey = new PublicKey(USDC_MINT);

  const ixs = [];
  let ownerAtaCreationCost = 0;

  // ── USDC sweep ──────────────────────────────────────────────────────────────
  const sessionUsdcAta = await getAssociatedTokenAddress(usdcMintPubkey, sessionPubkey);
  let usdcBalance = 0n;
  try {
    const ataInfo = await getAccount(conn, sessionUsdcAta);
    usdcBalance = ataInfo.amount;
    console.log(`USDC ATA ${sessionUsdcAta.toBase58()} balance: ${usdcBalance} raw units`);
  } catch {
    console.log('No USDC ATA found (or empty).');
  }

  if (usdcBalance > 0n) {
    const ownerUsdcAta = await getAssociatedTokenAddress(usdcMintPubkey, ownerPubkey);
    let ownerAtaExists = false;
    try { await getAccount(conn, ownerUsdcAta); ownerAtaExists = true; } catch { /* missing */ }
    console.log(`Owner USDC ATA ${ownerUsdcAta.toBase58()} exists: ${ownerAtaExists}`);

    if (!ownerAtaExists) {
      ownerAtaCreationCost = 2_039_280;
      ixs.push(createAssociatedTokenAccountInstruction(sessionPubkey, ownerUsdcAta, ownerPubkey, usdcMintPubkey));
    }
    ixs.push(createTransferInstruction(sessionUsdcAta, ownerUsdcAta, sessionPubkey, usdcBalance));
    // Close session ATA — sends 2,039,280 lamports rent to owner
    ixs.push(createCloseAccountInstruction(sessionUsdcAta, ownerPubkey, sessionPubkey));
  }

  const ATA_RENT = 2_039_280;
  const solBalance = await conn.getBalance(sessionPubkey);
  console.log(`Session wallet SOL balance: ${solBalance} lamports (${solBalance / 1e9} SOL)`);
  // Base fee for one-signature versioned tx = exactly 5,000 lamports.
  // Session wallet must land at exactly 0 (not between 0 and rent-exempt), so use exact fee.
  const TX_FEE = 5_000;
  // solToSend drains the wallet to 0 after fee + ATA creation cost
  const solToSend = solBalance - ownerAtaCreationCost - TX_FEE;

  if (solToSend > 0) {
    ixs.push(SystemProgram.transfer({ fromPubkey: sessionPubkey, toPubkey: ownerPubkey, lamports: solToSend }));
    console.log(`Queuing SOL transfer: ${solToSend} lamports → ${session.owner_wallet}`);
  }

  if (ixs.length === 0) {
    console.log('Nothing to sweep — session wallet is empty.');
    process.exit(0);
  }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: sessionPubkey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);

  console.log('Sending sweep transaction...');
  const sig = await conn.sendTransaction(tx);
  console.log('Signature:', sig);
  console.log('Confirming...');
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
  console.log('✓ Sweep confirmed!');
  console.log(`  USDC swept: ${Number(usdcBalance) / 1e6} USDC`);
  console.log(`  SOL swept:  ${solToSend / 1e9} SOL`);
  console.log(`  + ATA rent returned: ${usdcBalance > 0n ? '2,039,280 lamports' : '0'}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => pool.end());
