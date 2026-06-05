import dotenv from 'dotenv';
import pg from 'pg';
import bs58 from 'bs58';
import { Keypair, VersionedTransaction } from '@solana/web3.js';

const [,, sessionId, inputMint, outputMint, amount, slippageBps = '50'] = process.argv;

if (!sessionId || !inputMint || !outputMint || !amount) {
  throw new Error('Usage: node scripts/live-proof-swap.mjs <sessionId> <inputMint> <outputMint> <amount> [slippageBps]');
}

dotenv.config({ path: '.env' });

const API = process.env.API_URL ?? 'http://localhost:4000';
const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loadSessionKeypair = async (id) => {
  const client = new pg.Client({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const result = await client.query(
      'select keypair_base58 from session_keys where session_id = $1',
      [id],
    );
    const keypairBase58 = result.rows[0]?.keypair_base58;
    if (!keypairBase58) {
      throw new Error(`No session key found for ${id}`);
    }

    return Keypair.fromSecretKey(bs58.decode(keypairBase58));
  } finally {
    await client.end();
  }
};

const apiPost = async (path, body) => {
  const internalSecret = process.env.RZ_INTERNAL_SECRET?.trim();
  const headers = {
    'Content-Type': 'application/json',
    ...(internalSecret ? { 'x-rz-internal-secret': internalSecret } : {}),
  };

  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }

  return data;
};

const main = async () => {
  const keypair = await loadSessionKeypair(sessionId);
  const prepare = await apiPost('/jupiter/swap/prepare', {
    inputMint,
    outputMint,
    amount,
    taker: keypair.publicKey.toBase58(),
    feeTokenSymbol: 'USDC',
    slippageBps,
  });

  const tx = VersionedTransaction.deserialize(
    Buffer.from(prepare.preparedTransactionBase64, 'base64'),
  );
  tx.sign([keypair]);

  const submit = await apiPost('/jupiter/swap/submit', {
    executionId: prepare.executionId,
    signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    blockhash: prepare.blockhash,
    lastValidBlockHeight: prepare.lastValidBlockHeight,
  });

  let reconcile = null;
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    await sleep(1500);
    reconcile = await apiPost(`/jupiter/swap/executions/${prepare.executionId}/reconcile`, {});
    if (reconcile.execution?.status && reconcile.execution.status !== 'submitted') {
      break;
    }
  }

  console.log(JSON.stringify({
    sessionId,
    inputMint,
    outputMint,
    amount,
    executionId: prepare.executionId,
    submit,
    reconcile,
  }, null, 2));
};

await main();
