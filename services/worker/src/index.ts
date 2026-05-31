import { createDecipheriv } from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  SystemProgram,
  TransactionMessage,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
  getMint,
  getAccountLenForMint,
  unpackAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  type Account as SplTokenAccount,
  type Mint as SplTokenMint,
} from '@solana/spl-token';
import { createSharedTokenBucket, getExponentialBackoffDelayMs } from '@roguezero/provider-governor';
import {
  computeSolEntryCapLamports,
  computeTradeAmountLamports,
  getDatabaseConnectionUrl,
  getHeliusRpcUrl,
  getJupiterPriceConfig,
  getPythPriceConfig,
  getRuntimeSpeedProfile,
  getRuntimeConfigReport,
  getWorkerFundingThresholds,
  getWorkerPositionExitPolicy,
  getWorkerPricePollPolicy,
  getWorkerSignalPolicy,
  getWorkerSizingPolicy,
  normalizeRuntimeSpeedProfileName,
  type RuntimeSpeedProfileName,
  type JupiterPriceConfig,
  type PythPriceConfig,
  type TradeSizingDecision,
  type WorkerPositionExitPolicy,
  type WorkerPricePollPolicy,
  type WorkerSignalPolicy,
} from '@roguezero/runtime-config';
import {
  mergeSessionServiceControl,
  type Session,
  type SessionServiceControlPatch,
} from '@roguezero/session-schema';
import {
  computeFullExitAmountAtomic,
  resolveTradeGateAssessment,
  shouldForceExitExecution,
  type TradeGateAssessment,
} from './tradeExecutionPolicy.js';
import {
  DEFAULT_BOLLINGER_CONFIG,
  DEFAULT_SUPERTREND_CONFIG,
  computeBollingerSignal,
  computeSupertrendSignal,
  recommendStrategy,
  type BollingerConfig,
  type SignalDecision,
  type PriceSample,
  type SupertrendConfig,
} from './strategies.js';

dotenv.config({ path: '../../.env' });

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const configReport = getRuntimeConfigReport(process.env);
if (!process.env.API_URL) {
  throw new Error('API_URL must be set on the worker service');
}
const API_BASE = process.env.API_URL;
const WORKER_INTERNAL_SECRET = process.env.RZ_INTERNAL_SECRET?.trim() ?? '';
const POLL_MS  = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const MIN_LOOP_MS = Number(process.env.WORKER_MIN_LOOP_INTERVAL_MS ?? 250);
const LOOP_JITTER_RATIO = Number(process.env.WORKER_LOOP_JITTER_RATIO ?? 0.1);
const FUNDING_POLL_FALLBACK_MS = Number(process.env.WORKER_FUNDING_POLL_FALLBACK_MS ?? 60000);
const POST_SUBMIT_RECONCILE_GRACE_MS = Number(process.env.WORKER_POST_SUBMIT_RECONCILE_GRACE_MS ?? 10000);
const STALE_SESSION_MINUTES = Number(process.env.WORKER_STALE_SESSION_MINUTES ?? 30);
const JUPITER_GENERAL_RPS = Number(process.env.JUPITER_GENERAL_RPS ?? 8);
const JUPITER_GENERAL_BURST = Number(process.env.JUPITER_GENERAL_BURST ?? JUPITER_GENERAL_RPS);
const HELIUS_RPC_RPS = Number(process.env.HELIUS_RPC_RPS ?? 40);
const HELIUS_RPC_BURST = Number(process.env.HELIUS_RPC_BURST ?? Math.min(10, HELIUS_RPC_RPS));
const DATABASE_QUERY_TIMEOUT_MS = Number(process.env.DATABASE_QUERY_TIMEOUT_MS ?? 15000);
const DATABASE_STATEMENT_TIMEOUT_MS = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 12000);
const DATABASE_LOCK_TIMEOUT_MS = Number(process.env.DATABASE_LOCK_TIMEOUT_MS ?? 5000);
const DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = Number(process.env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? 10000);
const fundingThresholds = getWorkerFundingThresholds(process.env);
const sizingPolicy = getWorkerSizingPolicy(process.env);
const pricePollPolicy: WorkerPricePollPolicy = getWorkerPricePollPolicy(process.env);
const signalPolicy: WorkerSignalPolicy = getWorkerSignalPolicy(process.env);
const positionExitPolicy: WorkerPositionExitPolicy = getWorkerPositionExitPolicy(process.env);
let jupiterPriceConfig: JupiterPriceConfig | null = null;
let pythPriceConfig: PythPriceConfig | null = null;
try {
  jupiterPriceConfig = getJupiterPriceConfig(process.env);
  pythPriceConfig = getPythPriceConfig(process.env);
} catch (err) {
  console.warn('[worker] price feed config unavailable:', String(err));
}

// SOL mint address
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
// USDC on mainnet
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Reserves retained on the session wallet so simulation, Sender tip, priority
// fees, and route-setup rent are always covered. The actual per-trade swap
// size is now computed adaptively via computeTradeAmountLamports() (Stage 3).
const MAX_ROUTE_SETUP_LAMPORTS = fundingThresholds.maxRouteSetupLamports;
const OPERATING_BUFFER_LAMPORTS = fundingThresholds.operatingBufferLamports;
const TX_FEE_LAMPORTS = fundingThresholds.txFeeLamports;
const MIN_TRADEABLE_LAMPORTS = fundingThresholds.minimumTradeableLamports;
const MIN_SOL_OPERATING_RESERVE_LAMPORTS = TX_FEE_LAMPORTS + OPERATING_BUFFER_LAMPORTS;
const MIN_USDC_ENTRY_ATOMIC = Number(process.env.WORKER_MIN_USDC_ENTRY_ATOMIC ?? 1_000_000);
const MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES = Number(process.env.WORKER_MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES ?? 2);
const MAX_QUOTE_PRICE_IMPACT_BPS = Number(process.env.WORKER_MAX_QUOTE_PRICE_IMPACT_BPS ?? 120);
const WORKER_UNIVERSE_SCOUT_ENABLED = process.env.WORKER_UNIVERSE_SCOUT_ENABLED !== 'false';
const WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES = Number(process.env.WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES ?? 6);
const WORKER_UNIVERSE_SCOUT_MAX_SOL_PRICE_IMPACT_BPS = Number(process.env.WORKER_UNIVERSE_SCOUT_MAX_SOL_PRICE_IMPACT_BPS ?? 150);
const WORKER_UNIVERSE_SCOUT_MIN_SOL_RANK = Number(process.env.WORKER_UNIVERSE_SCOUT_MIN_SOL_RANK ?? 2);
const TOKEN_UNIVERSE_AUTO_SORT_ENABLED = process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_ENABLED !== 'false';
const TOKEN_UNIVERSE_AUTO_SORT_INTERVAL_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_INTERVAL_MS ?? 180000);
const TOKEN_UNIVERSE_AUTO_SORT_MAX_MINTS = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_MAX_MINTS ?? 16);
const TOKEN_UNIVERSE_AUTO_SORT_TOP_ENABLED = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_TOP_ENABLED ?? 8);
const TOKEN_UNIVERSE_AUTO_SORT_NOTIONAL_USDC_ATOMIC = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_NOTIONAL_USDC_ATOMIC ?? 10_000_000);
const TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS ?? 200);
const TOKEN_UNIVERSE_ENGINE_MAX_STALE_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_ENGINE_MAX_STALE_MS ?? 900000);
const TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD = Number(process.env.WORKER_TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD ?? 6);
const TOKEN_UNIVERSE_HEALTH_MAX_TRACKED_MINTS = Number(process.env.WORKER_TOKEN_UNIVERSE_HEALTH_MAX_TRACKED_MINTS ?? 512);
const TOKEN_UNIVERSE_DEAD_PRUNE_ENABLED = process.env.WORKER_TOKEN_UNIVERSE_DEAD_PRUNE_ENABLED !== 'false';
const TOKEN_UNIVERSE_ADMISSION_STREAK = Number(process.env.WORKER_TOKEN_UNIVERSE_ADMISSION_STREAK ?? 2);
const TOKEN_UNIVERSE_EVICTION_STREAK = Number(process.env.WORKER_TOKEN_UNIVERSE_EVICTION_STREAK ?? 3);
const TOKEN_UNIVERSE_MIN_STAY_RUNS = Number(process.env.WORKER_TOKEN_UNIVERSE_MIN_STAY_RUNS ?? 4);
const TOKEN_UNIVERSE_EVICTION_RANK_BUFFER = Number(process.env.WORKER_TOKEN_UNIVERSE_EVICTION_RANK_BUFFER ?? 2);
const TOKEN_UNIVERSE_PROBE_FREEZE_FAILURE_STREAK = Number(process.env.WORKER_TOKEN_UNIVERSE_PROBE_FREEZE_FAILURE_STREAK ?? 3);
const TOKEN_UNIVERSE_PROBE_UNFREEZE_HEALTHY_STREAK = Number(process.env.WORKER_TOKEN_UNIVERSE_PROBE_UNFREEZE_HEALTHY_STREAK ?? 2);
const TOKEN_UNIVERSE_AUTOSORT_STATE_WRITE_MIN_INTERVAL_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTOSORT_STATE_WRITE_MIN_INTERVAL_MS ?? 120000);
const TOKEN_UNIVERSE_METADATA_WRITE_MIN_INTERVAL_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_METADATA_WRITE_MIN_INTERVAL_MS ?? 300000);
const RUNTIME_CONTROL_KEY = 'global_live_runtime';
const RUNTIME_CONTROL_REFRESH_MS = Number(process.env.RUNTIME_CONTROL_REFRESH_MS ?? 5000);
let liveSpeedProfileName: RuntimeSpeedProfileName = normalizeRuntimeSpeedProfileName(process.env.WORKER_SPEED_PROFILE);
let liveSpeedProfile = getRuntimeSpeedProfile(liveSpeedProfileName, process.env);
let lastRuntimeControlRefreshAt = 0;

// â”€â”€ DB pool â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const { Pool } = pg;
let pool: pg.Pool | null = null;
let tokenUniversePool: pg.Pool | null = null;

const getPool = () => {
  if (pool) return pool;
  const url = getDatabaseConnectionUrl(process.env);
  const parsed = new URL(url);
  parsed.searchParams.delete('sslmode');
  pool = new Pool({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: false },
    max: 3,
    query_timeout: DATABASE_QUERY_TIMEOUT_MS,
    statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
    lock_timeout: DATABASE_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });
  return pool;
};

const getTokenUniversePool = () => {
  if (tokenUniversePool) return tokenUniversePool;

  const overrideUrl = process.env.ROGUEAI_TOKEN_UNIVERSE_DATABASE_URL?.trim();
  if (!overrideUrl) {
    tokenUniversePool = getPool();
    return tokenUniversePool;
  }

  const parsed = new URL(overrideUrl);
  parsed.searchParams.delete('sslmode');
  tokenUniversePool = new Pool({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: false },
    max: 2,
    query_timeout: DATABASE_QUERY_TIMEOUT_MS,
    statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
    lock_timeout: DATABASE_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });

  return tokenUniversePool;
};

// â”€â”€ Solana connection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let connection: Connection | null = null;
const getConnection = () => {
  if (connection) return connection;
  const rpc = getHeliusRpcUrl(process.env);
  connection = new Connection(rpc, 'confirmed');
  return connection;
};

// â”€â”€ DB helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type RawSession = {
  id: string;
  user_id: string;
  owner_wallet: string;
  session_wallet: string;
  status: string;
  requested_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  stop_reason: string | null;
  user_control: Session['userControl'];
  service_control: Session['serviceControl'];
  risk_limits: Session['riskLimits'];
  funding: Session['funding'];
};

type RuntimeControlRow = {
  state: {
    speedProfile?: unknown;
  } | null;
};

const querySessions = async (statuses: string[]): Promise<RawSession[]> => {
  const dbPool = getPool();
  const placeholders = statuses.map((_, i) => `$${i + 1}`).join(', ');
  const result = await dbPool.query<RawSession>(
    `SELECT *
       FROM sessions
      WHERE status IN (${placeholders})
      ORDER BY requested_at ASC, id ASC`,
    statuses,
  );
  return result.rows;
};

const getSessionById = async (id: string): Promise<RawSession | null> => {
  const dbPool = getPool();
  const result = await dbPool.query<RawSession>(
    `SELECT *
       FROM sessions
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
};

const ensureRuntimeControlStore = async () => {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS runtime_control_settings (
      control_key TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const refreshLiveRuntimeControl = async (force = false) => {
  const now = Date.now();
  if (!force && (now - lastRuntimeControlRefreshAt) < RUNTIME_CONTROL_REFRESH_MS) {
    return liveSpeedProfile;
  }

  await ensureRuntimeControlStore();
  const result = await getPool().query<RuntimeControlRow>(
    `SELECT state
       FROM runtime_control_settings
      WHERE control_key = $1
      LIMIT 1`,
    [RUNTIME_CONTROL_KEY],
  );

  const selectedProfile = normalizeRuntimeSpeedProfileName(
    typeof result.rows[0]?.state?.speedProfile === 'string'
      ? result.rows[0].state.speedProfile
      : process.env.WORKER_SPEED_PROFILE,
  );

  if (result.rowCount === 0) {
    await getPool().query(
      `INSERT INTO runtime_control_settings (control_key, state, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (control_key)
       DO UPDATE SET state = runtime_control_settings.state`,
      [RUNTIME_CONTROL_KEY, JSON.stringify({ speedProfile: selectedProfile })],
    );
  }

  liveSpeedProfileName = selectedProfile;
  liveSpeedProfile = getRuntimeSpeedProfile(selectedProfile, process.env);
  lastRuntimeControlRefreshAt = now;
  return liveSpeedProfile;
};

const getLiveSpeedProfile = () => liveSpeedProfile;

const setSessionStatus = async (
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
  opts: { expectedStatuses?: string[] } = {},
) => {
  const dbPool = getPool();
  const fields = ['status = $2'];
  const vals: unknown[] = [id, status];

  if ('started_at' in extra) { vals.push(extra.started_at); fields.push(`started_at = $${vals.length}`); }
  if ('ended_at'   in extra) { vals.push(extra.ended_at);   fields.push(`ended_at = $${vals.length}`); }
  if ('stop_reason' in extra) { vals.push(extra.stop_reason); fields.push(`stop_reason = $${vals.length}`); }
  if ('funding' in extra) {
    vals.push(JSON.stringify(extra.funding));
    fields.push(`funding = $${vals.length}::jsonb`);
  }
  if ('service_control' in extra) {
    vals.push(JSON.stringify(extra.service_control));
    fields.push(`service_control = $${vals.length}::jsonb`);
  }

  let whereClause = 'WHERE id = $1';
  if (opts.expectedStatuses && opts.expectedStatuses.length > 0) {
    vals.push(opts.expectedStatuses);
    whereClause += ` AND status = ANY($${vals.length}::text[])`;
  }

  await dbPool.query(
    `UPDATE sessions SET ${fields.join(', ')} ${whereClause}`,
    vals,
  );
};

const mergeServiceControlPatch = async (
  session: RawSession,
  patch: SessionServiceControlPatch,
) => {
  const latestSession = await getSessionById(session.id);
  const baseServiceControl = latestSession?.service_control ?? session.service_control;
  const mergedServiceControl = mergeSessionServiceControl(baseServiceControl, patch);

  session.status = latestSession?.status ?? session.status;
  session.service_control = mergedServiceControl;

  await setSessionStatus(
    session.id,
    session.status,
    { service_control: mergedServiceControl },
    { expectedStatuses: [session.status] },
  );

  return mergedServiceControl;
};

const persistServiceControl = async (
  session: RawSession,
  serviceControlPatch: SessionServiceControlPatch,
) => {
  await mergeServiceControlPatch(session, serviceControlPatch);
};

const mergeFundingPatch = async (
  session: RawSession,
  fundingPatch: Partial<Session['funding']>,
) => {
  const latestSession = await getSessionById(session.id);
  const baseFunding = latestSession?.funding ?? session.funding;
  const latestStatus = latestSession?.status ?? session.status;
  const mergedFunding: Session['funding'] = {
    ...baseFunding,
    ...fundingPatch,
  };

  session.status = latestStatus;
  session.funding = mergedFunding;

  await setSessionStatus(session.id, latestStatus, {
    funding: mergedFunding,
  }, { expectedStatuses: [latestStatus] });
};

const decryptKeypair = (stored: string): string => {
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

const getKeypair = async (sessionId: string): Promise<Keypair | null> => {
  const dbPool = getPool();
  const result = await dbPool.query<{ keypair_base58: string }>(
    'SELECT keypair_base58 FROM session_keys WHERE session_id = $1',
    [sessionId],
  );
  if (!result.rowCount) return null;
  const secretKey = bs58.decode(decryptKeypair(result.rows[0].keypair_base58));
  return Keypair.fromSecretKey(secretKey);
};

// â”€â”€ Rate limiter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const sharedRatePool = getPool();
const jupiterLimiter = createSharedTokenBucket({
  pool: sharedRatePool,
  key: 'jupiter-general',
  maxTokens: JUPITER_GENERAL_BURST,
  refillRatePerSec: JUPITER_GENERAL_RPS,
});
const heliusLimiter = createSharedTokenBucket({
  pool: sharedRatePool,
  key: 'helius-rpc',
  maxTokens: HELIUS_RPC_BURST,
  refillRatePerSec: HELIUS_RPC_RPS,
});

// â”€â”€ Stage 4 price feeds (chunk 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Two independent pollers, two independent rate buckets:
//   â€¢ Pyth Hermes â€” primary, ~3s cadence, no auth, separate vendor
//   â€¢ Jupiter /price/v3 â€” slow drift check, ~60s cadence, on jupiter bucket
// Outputs are LOG-ONLY in chunk 2. No DB writes, no signal, no trade impact.

type PythSample = {
  source: 'pyth-hermes';
  feedId: string;
  usdPrice: number;
  confidenceUsd: number;
  confidenceBps: number;
  publishTime: number;
  slot: number;
  sampledAt: string;
};

type JupiterPriceSample = {
  source: 'jupiter-price-v3';
  mint: string;
  usdPrice: number;
  blockId: number;
  decimals: number;
  sampledAt: string;
};

let lastPythSolSample: PythSample | null = null;
let lastJupiterSolSample: JupiterPriceSample | null = null;
let lastSignalSnapshot: NonNullable<Session['serviceControl']['lastSignal']> | null = null;
let pythConsecutiveFailures = 0;
let jupiterPriceConsecutiveFailures = 0;
let tokenUniverseMints: string[] = [];
let tokenUniverseSourceTable: string | null = null;
let tokenUniverseTableMeta: TokenUniverseTableMeta | null = null;
let lastTokenUniverseRefreshAt = 0;
let tokenUniverseBootstrapAttempted = false;
let lastTokenUniverseAutoSortAt = 0;
let lastTokenUniverseEngineAppliedAt = 0;
let lastTokenUniverseEngineEnabledCount = 0;
let tokenUniverseProbeFrozen = false;
let lastTokenUniverseAutoSortStateWriteMs = 0;
let lastTokenUniverseAutoSortStateSignature: string | null = null;
let lastTokenUniverseMetadataWriteMs = 0;
let lastTokenUniverseMetadataSignature: string | null = null;
const universeSortProbeTaker = Keypair.generate().publicKey.toBase58();
const latestJupiterUsdByMint = new Map<string, number>();
const previousJupiterUsdByMint = new Map<string, number>();

const TOKEN_UNIVERSE_REFRESH_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_REFRESH_MS ?? 60000);
const TOKEN_UNIVERSE_TABLE_CANDIDATES = (process.env.ROGUEAI_TOKEN_UNIVERSE_TABLES
  ?? 'rogueai_token_universe,token_universe,rz_token_universe')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const TOKEN_UNIVERSE_MAX_MINTS = Number(process.env.WORKER_TOKEN_UNIVERSE_MAX_MINTS ?? 64);
const solanaPublicKeyPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_UNIVERSE_BOOTSTRAP_ENABLED = process.env.WORKER_TOKEN_UNIVERSE_BOOTSTRAP_ENABLED !== 'false';
const DEFAULT_TOKEN_UNIVERSE_SEED = [
  { mint: SOL_MINT, symbol: 'SOL', priority: 100 },
  { mint: USDC_MINT, symbol: 'USDC', priority: 90 },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', priority: 80 },
];

type TokenUniverseTableMeta = {
  tableName: string;
  mintColumn: string;
  enabledColumn: string | null;
  priorityColumn: string | null;
  updatedAtColumn: string | null;
};

type TokenUniverseRankSample = {
  mint: string;
  usdPrice: number | null;
  priorUsdPrice: number | null;
  momentumBps: number;
  routeFound: boolean;
  priceImpactBps: number | null;
  score: number;
};

type MarketTapePoint = {
  sampledAt: string;
  usdPrice: number;
  source: 'pyth-hermes' | 'jupiter-price-v3';
};

type DriftTapePoint = {
  sampledAt: string;
  pythUsd: number;
  jupiterUsd: number;
  driftBps: number;
};

const sharedMarketTape = {
  solUsdPyth: [] as MarketTapePoint[],
  solUsdJupiter: [] as MarketTapePoint[],
  solUsdDrift: [] as DriftTapePoint[],
};

type PersistedMarketTapeRow = {
  state: {
    solUsdPyth?: unknown;
    solUsdJupiter?: unknown;
    solUsdDrift?: unknown;
    lastPythSolSample?: unknown;
    lastJupiterSolSample?: unknown;
    lastSignalSnapshot?: unknown;
  } | null;
};

const WORKER_RUNTIME_STATE_KEY = 'shared_market_tape_v1';
const TOKEN_UNIVERSE_AUTOSORT_STATE_KEY = 'token_universe_autosort_v1';
const TOKEN_UNIVERSE_HEALTH_STATE_KEY = 'token_universe_health_v1';
const MARKET_TAPE_PERSIST_MIN_INTERVAL_MS = Number(process.env.WORKER_MARKET_TAPE_PERSIST_MIN_INTERVAL_MS ?? 3000);
let workerRuntimeStateReadyPromise: Promise<void> | null = null;
let lastMarketTapePersistMs = 0;

type TokenUniverseHealthEntry = {
  deadRuns: number;
  admitRuns: number;
  evictRuns: number;
  enabled: boolean;
  enabledSinceRun: number | null;
  lastReason: string | null;
  lastSeenAt: string;
};

type TokenUniverseHealthState = {
  run: number;
  mints: Record<string, TokenUniverseHealthEntry>;
  probeFailureStreak: number;
  probeHealthyStreak: number;
  probeFrozen: boolean;
  probeFrozenAt: string | null;
  lastSuccessfulProbeAt: string | null;
};

const trimTokenUniverseHealthState = (state: TokenUniverseHealthState): TokenUniverseHealthState => {
  const trackedEntries = Object.entries(state.mints)
    .sort((a, b) => {
      const aSeen = Date.parse(a[1].lastSeenAt);
      const bSeen = Date.parse(b[1].lastSeenAt);
      return (Number.isFinite(bSeen) ? bSeen : 0) - (Number.isFinite(aSeen) ? aSeen : 0);
    })
    .slice(0, Math.max(32, TOKEN_UNIVERSE_HEALTH_MAX_TRACKED_MINTS));

  return {
    ...state,
    mints: Object.fromEntries(trackedEntries),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const toFiniteNumber = (value: unknown) => {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const toMarketTapePoint = (value: unknown): MarketTapePoint | null => {
  if (!isRecord(value)) return null;
  const sampledAt = typeof value.sampledAt === 'string' ? value.sampledAt : null;
  const usdPrice = toFiniteNumber(value.usdPrice);
  const source = value.source === 'pyth-hermes' || value.source === 'jupiter-price-v3'
    ? value.source
    : null;

  if (!sampledAt || usdPrice === null || !source) return null;
  return { sampledAt, usdPrice, source };
};

const toDriftTapePoint = (value: unknown): DriftTapePoint | null => {
  if (!isRecord(value)) return null;
  const sampledAt = typeof value.sampledAt === 'string' ? value.sampledAt : null;
  const pythUsd = toFiniteNumber(value.pythUsd);
  const jupiterUsd = toFiniteNumber(value.jupiterUsd);
  const driftBps = toFiniteNumber(value.driftBps);

  if (!sampledAt || pythUsd === null || jupiterUsd === null || driftBps === null) return null;
  return { sampledAt, pythUsd, jupiterUsd, driftBps };
};

const toPythSample = (value: unknown): PythSample | null => {
  if (!isRecord(value)) return null;
  const feedId = typeof value.feedId === 'string' ? value.feedId : null;
  const usdPrice = toFiniteNumber(value.usdPrice);
  const confidenceUsd = toFiniteNumber(value.confidenceUsd);
  const confidenceBps = toFiniteNumber(value.confidenceBps);
  const publishTime = toFiniteNumber(value.publishTime);
  const slot = toFiniteNumber(value.slot);
  const sampledAt = typeof value.sampledAt === 'string' ? value.sampledAt : null;

  if (!feedId || usdPrice === null || confidenceUsd === null || confidenceBps === null || publishTime === null || slot === null || !sampledAt) {
    return null;
  }

  return {
    source: 'pyth-hermes',
    feedId,
    usdPrice,
    confidenceUsd,
    confidenceBps,
    publishTime,
    slot,
    sampledAt,
  };
};

const toJupiterPriceSample = (value: unknown): JupiterPriceSample | null => {
  if (!isRecord(value)) return null;
  const mint = typeof value.mint === 'string' ? value.mint : null;
  const usdPrice = toFiniteNumber(value.usdPrice);
  const blockId = toFiniteNumber(value.blockId);
  const decimals = toFiniteNumber(value.decimals);
  const sampledAt = typeof value.sampledAt === 'string' ? value.sampledAt : null;

  if (!mint || usdPrice === null || blockId === null || decimals === null || !sampledAt) {
    return null;
  }

  return {
    source: 'jupiter-price-v3',
    mint,
    usdPrice,
    blockId,
    decimals,
    sampledAt,
  };
};

const toLastSignalSnapshot = (value: unknown): NonNullable<Session['serviceControl']['lastSignal']> | null => {
  if (!isRecord(value)) return null;

  const at = typeof value.at === 'string' ? value.at : null;
  const source = value.source === 'pyth-hermes' ? value.source : null;
  const signal = value.signal === 'momentum' ? value.signal : null;
  const status = value.status === 'warming_up' || value.status === 'ready' || value.status === 'guarded_off'
    ? value.status
    : null;
  const regime = value.regime === 'bullish' || value.regime === 'bearish' || value.regime === 'flat' || value.regime === null
    ? value.regime
    : null;
  const lookbackSamples = toFiniteNumber(value.lookbackSamples);
  const thresholdBps = toFiniteNumber(value.thresholdBps);
  const momentumBps = value.momentumBps === null ? null : toFiniteNumber(value.momentumBps);
  const guardReason = typeof value.guardReason === 'string' || value.guardReason === null
    ? value.guardReason
    : null;

  if (!at || !source || !signal || !status || lookbackSamples === null || thresholdBps === null) {
    return null;
  }

  return {
    at,
    source,
    signal,
    status,
    regime,
    lookbackSamples,
    thresholdBps,
    momentumBps,
    guardReason,
  };
};

const ensureWorkerRuntimeStateStore = async () => {
  if (!workerRuntimeStateReadyPromise) {
    workerRuntimeStateReadyPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS worker_runtime_state_cache (
        state_key TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).then(() => undefined);
  }

  return workerRuntimeStateReadyPromise;
};

const loadPersistedMarketTapeState = async () => {
  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  const result = await dbPool.query<PersistedMarketTapeRow>(
    `SELECT state FROM worker_runtime_state_cache WHERE state_key = $1 LIMIT 1`,
    [WORKER_RUNTIME_STATE_KEY],
  );

  const state = result.rows[0]?.state;
  if (!state) {
    return;
  }

  sharedMarketTape.solUsdPyth.splice(0, sharedMarketTape.solUsdPyth.length, ...(
    Array.isArray(state.solUsdPyth)
      ? state.solUsdPyth.map(toMarketTapePoint).filter((value): value is MarketTapePoint => value !== null)
      : []
  ));
  sharedMarketTape.solUsdJupiter.splice(0, sharedMarketTape.solUsdJupiter.length, ...(
    Array.isArray(state.solUsdJupiter)
      ? state.solUsdJupiter.map(toMarketTapePoint).filter((value): value is MarketTapePoint => value !== null)
      : []
  ));
  sharedMarketTape.solUsdDrift.splice(0, sharedMarketTape.solUsdDrift.length, ...(
    Array.isArray(state.solUsdDrift)
      ? state.solUsdDrift.map(toDriftTapePoint).filter((value): value is DriftTapePoint => value !== null)
      : []
  ));

  lastPythSolSample = toPythSample(state.lastPythSolSample);
  lastJupiterSolSample = toJupiterPriceSample(state.lastJupiterSolSample);
  lastSignalSnapshot = toLastSignalSnapshot(state.lastSignalSnapshot);

  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'price',
    ts: new Date().toISOString(),
    restoredMarketTape: true,
    pythDepth: sharedMarketTape.solUsdPyth.length,
    jupiterDepth: sharedMarketTape.solUsdJupiter.length,
    driftDepth: sharedMarketTape.solUsdDrift.length,
  }));
};

const persistMarketTapeState = async () => {
  const nowMs = Date.now();
  if ((nowMs - lastMarketTapePersistMs) < MARKET_TAPE_PERSIST_MIN_INTERVAL_MS) {
    return;
  }

  lastMarketTapePersistMs = nowMs;

  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  await dbPool.query(
    `INSERT INTO worker_runtime_state_cache (state_key, state, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (state_key)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [
      WORKER_RUNTIME_STATE_KEY,
      JSON.stringify({
        solUsdPyth: sharedMarketTape.solUsdPyth,
        solUsdJupiter: sharedMarketTape.solUsdJupiter,
        solUsdDrift: sharedMarketTape.solUsdDrift,
        lastPythSolSample,
        lastJupiterSolSample,
        lastSignalSnapshot,
      }),
    ],
  );
};

const stableJsonStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableJsonStringify(nestedValue)}`);

  return `{${entries.join(',')}}`;
};

type TokenUniverseMetadataWrite = {
  sourceTable: string | null;
  status: string;
  reason: string | null;
  candidateCount: number;
  enabledCount: number;
  avgMomentumBps?: number | null;
  avgPriceImpactBps?: number | null;
  topTokens: unknown[];
};

const persistTokenUniverseMetadata = async (
  write: TokenUniverseMetadataWrite,
  dbPool: pg.Pool = getTokenUniversePool(),
) => {
  const nowMs = Date.now();
  const signature = stableJsonStringify(write);

  if (
    signature === lastTokenUniverseMetadataSignature
    && (nowMs - lastTokenUniverseMetadataWriteMs) < TOKEN_UNIVERSE_METADATA_WRITE_MIN_INTERVAL_MS
  ) {
    return;
  }

  try {
    await dbPool.query(
      `INSERT INTO public.rogueai_token_universe_metadata (
         source_table, status, reason, candidate_count, enabled_count,
         avg_momentum_bps, avg_price_impact_bps, top_tokens, built_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
      [
        write.sourceTable,
        write.status,
        write.reason,
        write.candidateCount,
        write.enabledCount,
        write.avgMomentumBps ?? null,
        write.avgPriceImpactBps ?? null,
        JSON.stringify(write.topTokens),
      ],
    );
    lastTokenUniverseMetadataWriteMs = nowMs;
    lastTokenUniverseMetadataSignature = signature;
  } catch {
    // metadata writes are best-effort only
  }
};

const persistTokenUniverseAutoSortState = async (state: Record<string, unknown>) => {
  const nowMs = Date.now();
  const signature = stableJsonStringify(state);

  if (
    signature === lastTokenUniverseAutoSortStateSignature
    && (nowMs - lastTokenUniverseAutoSortStateWriteMs) < TOKEN_UNIVERSE_AUTOSORT_STATE_WRITE_MIN_INTERVAL_MS
  ) {
    return;
  }

  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  await dbPool.query(
    `INSERT INTO worker_runtime_state_cache (state_key, state, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (state_key)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [TOKEN_UNIVERSE_AUTOSORT_STATE_KEY, JSON.stringify(state)],
  );

  lastTokenUniverseAutoSortStateWriteMs = nowMs;
  lastTokenUniverseAutoSortStateSignature = signature;
};

const loadTokenUniverseHealthState = async (): Promise<TokenUniverseHealthState> => {
  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  const result = await dbPool.query<{ state: unknown | null }>(
    `SELECT state FROM worker_runtime_state_cache WHERE state_key = $1 LIMIT 1`,
    [TOKEN_UNIVERSE_HEALTH_STATE_KEY],
  );

  const state = result.rows[0]?.state;
  if (!isRecord(state) || !isRecord(state.mints)) {
    return {
      run: 0,
      mints: {},
      probeFailureStreak: 0,
      probeHealthyStreak: 0,
      probeFrozen: false,
      probeFrozenAt: null,
      lastSuccessfulProbeAt: null,
    };
  }

  const runValue = toFiniteNumber(state.run);
  const probeFailureStreakValue = toFiniteNumber(state.probeFailureStreak);
  const probeHealthyStreakValue = toFiniteNumber(state.probeHealthyStreak);
  const probeFrozen = state.probeFrozen === true;
  const probeFrozenAt = typeof state.probeFrozenAt === 'string' ? state.probeFrozenAt : null;
  const lastSuccessfulProbeAt = typeof state.lastSuccessfulProbeAt === 'string' ? state.lastSuccessfulProbeAt : null;
  const mints: Record<string, TokenUniverseHealthEntry> = {};
  for (const [mint, rawEntry] of Object.entries(state.mints)) {
    if (!isRecord(rawEntry)) continue;
    const deadRuns = toFiniteNumber(rawEntry.deadRuns);
    const admitRuns = toFiniteNumber(rawEntry.admitRuns);
    const evictRuns = toFiniteNumber(rawEntry.evictRuns);
    const enabledSinceRun = rawEntry.enabledSinceRun === null ? null : toFiniteNumber(rawEntry.enabledSinceRun);
    const enabled = rawEntry.enabled === true;
    const lastReason = typeof rawEntry.lastReason === 'string' ? rawEntry.lastReason : null;
    const lastSeenAt = typeof rawEntry.lastSeenAt === 'string' ? rawEntry.lastSeenAt : new Date().toISOString();
    if (!Number.isFinite(deadRuns ?? null)) continue;
    mints[mint] = {
      deadRuns: Math.max(0, Math.floor(deadRuns ?? 0)),
      admitRuns: Math.max(0, Math.floor(admitRuns ?? 0)),
      evictRuns: Math.max(0, Math.floor(evictRuns ?? 0)),
      enabled,
      enabledSinceRun: enabledSinceRun === null || !Number.isFinite(enabledSinceRun) ? null : Math.max(0, Math.floor(enabledSinceRun)),
      lastReason,
      lastSeenAt,
    };
  }

  return {
    run: runValue === null ? 0 : Math.max(0, Math.floor(runValue)),
    mints,
    probeFailureStreak: probeFailureStreakValue === null ? 0 : Math.max(0, Math.floor(probeFailureStreakValue)),
    probeHealthyStreak: probeHealthyStreakValue === null ? 0 : Math.max(0, Math.floor(probeHealthyStreakValue)),
    probeFrozen,
    probeFrozenAt,
    lastSuccessfulProbeAt,
  };
};

const persistTokenUniverseHealthState = async (state: TokenUniverseHealthState) => {
  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  await dbPool.query(
    `INSERT INTO worker_runtime_state_cache (state_key, state, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (state_key)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [TOKEN_UNIVERSE_HEALTH_STATE_KEY, JSON.stringify(state)],
  );
};

const pushBounded = <T>(tape: T[], point: T, maxSize: number) => {
  tape.push(point);
  if (tape.length > maxSize) {
    tape.splice(0, tape.length - maxSize);
  }
};

const getSharedMarketTapeSummary = () => ({
  pythDepth: sharedMarketTape.solUsdPyth.length,
  jupiterDepth: sharedMarketTape.solUsdJupiter.length,
  driftDepth: sharedMarketTape.solUsdDrift.length,
  latestPythUsd: sharedMarketTape.solUsdPyth.at(-1)?.usdPrice ?? null,
  latestJupiterUsd: sharedMarketTape.solUsdJupiter.at(-1)?.usdPrice ?? null,
  latestDriftBps: sharedMarketTape.solUsdDrift.at(-1)?.driftBps ?? null,
});

const computeMomentumBps = (samples: readonly MarketTapePoint[], lookbackSamples: number): number | null => {
  if (samples.length <= lookbackSamples) {
    return null;
  }

  const latest = samples.at(-1);
  const baseline = samples.at(-(lookbackSamples + 1));

  if (!latest || !baseline || baseline.usdPrice <= 0) {
    return null;
  }

  return Math.round(((latest.usdPrice - baseline.usdPrice) / baseline.usdPrice) * 10_000);
};

const classifyMomentum = (momentumBps: number, thresholdBps: number) => {
  if (momentumBps >= thresholdBps) {
    return 'bullish';
  }
  if (momentumBps <= -thresholdBps) {
    return 'bearish';
  }
  return 'flat';
};

const computeMomentumBpsAtOffset = (
  samples: readonly MarketTapePoint[],
  lookbackSamples: number,
  offsetFromEnd: number,
): number | null => {
  const latestIdx = samples.length - 1 - offsetFromEnd;
  const baselineIdx = latestIdx - lookbackSamples;
  if (latestIdx < 0 || baselineIdx < 0) {
    return null;
  }

  const latest = samples[latestIdx];
  const baseline = samples[baselineIdx];
  if (!latest || !baseline || baseline.usdPrice <= 0) {
    return null;
  }

  return Math.round(((latest.usdPrice - baseline.usdPrice) / baseline.usdPrice) * 10_000);
};

const hasMomentumRegimePersistence = (params: {
  samples: readonly MarketTapePoint[];
  lookbackSamples: number;
  thresholdBps: number;
  regime: 'bullish' | 'bearish';
  requiredSamples: number;
}) => {
  const requiredSamples = Math.max(1, params.requiredSamples);
  if (requiredSamples <= 1) {
    return true;
  }

  for (let offset = 0; offset < requiredSamples; offset += 1) {
    const momentumBps = computeMomentumBpsAtOffset(
      params.samples,
      params.lookbackSamples,
      offset,
    );
    if (momentumBps === null) {
      return false;
    }

    const regime = classifyMomentum(momentumBps, params.thresholdBps);
    if (regime !== params.regime) {
      return false;
    }
  }

  return true;
};

const parseQuotePriceImpactBps = (priceImpactPct: string | null | undefined): number | null => {
  if (!priceImpactPct) {
    return null;
  }

  const parsed = Number(priceImpactPct);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  // Jupiter payloads have historically appeared as either fraction (0.01 = 1%)
  // or percentage-like values. Support both defensively.
  return parsed <= 1
    ? Math.round(parsed * 10_000)
    : Math.round(parsed * 100);
};

const logSignalEvent = (event: object) => {
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'signal',
    ts: new Date().toISOString(),
    ...event,
  }));
};

const logPriceEvent = (event: object) => {
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'price',
    ts: new Date().toISOString(),
    ...event,
  }));
};

const getPythSampleAgeSeconds = (sample: PythSample) =>
  Math.max(0, Math.floor(Date.now() / 1000) - sample.publishTime);

const getPythGuardReason = (sample: PythSample): string | null => {
  const sampleAgeSeconds = getPythSampleAgeSeconds(sample);

  if (sampleAgeSeconds > signalPolicy.maxPythAgeSeconds) {
    return `stale_price_${sampleAgeSeconds}s`;
  }

  if (sample.confidenceBps > signalPolicy.maxPythConfidenceBps) {
    return `confidence_too_wide_${sample.confidenceBps}bps`;
  }

  return null;
};

const isSafeSqlIdentifier = (value: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);

const dedupeMints = (mints: readonly string[]) => {
  const next: string[] = [];
  const seen = new Set<string>();

  for (const mint of mints) {
    if (!solanaPublicKeyPattern.test(mint)) continue;
    if (seen.has(mint)) continue;
    seen.add(mint);
    next.push(mint);
  }

  return next;
};

const computePriceMomentumBps = (latestUsd: number | null, priorUsd: number | null) => {
  if (!latestUsd || !priorUsd || priorUsd <= 0) {
    return 0;
  }
  return Math.round(((latestUsd - priorUsd) / priorUsd) * 10_000);
};

const buildUniverseSortScore = (params: {
  momentumBps: number;
  routeFound: boolean;
  priceImpactBps: number | null;
}) => {
  const boundedMomentum = Math.max(-1_000, Math.min(1_000, params.momentumBps));
  const impactPenalty = params.priceImpactBps ?? 1_000;
  const routeBonus = params.routeFound ? 200 : -2_000;
  return boundedMomentum - impactPenalty + routeBonus;
};

const applyTokenUniverseAutoSort = async () => {
  if (!TOKEN_UNIVERSE_AUTO_SORT_ENABLED) {
    return;
  }

  const now = Date.now();
  if ((now - lastTokenUniverseAutoSortAt) < TOKEN_UNIVERSE_AUTO_SORT_INTERVAL_MS) {
    return;
  }
  lastTokenUniverseAutoSortAt = now;

  if (!tokenUniverseTableMeta?.enabledColumn || !tokenUniverseTableMeta?.priorityColumn) {
    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason: 'missing_enabled_or_priority_column',
      candidateCount: 0,
      enabledCount: 0,
      topTokens: [],
    });
    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason: 'missing_enabled_or_priority_column',
      sourceTable: tokenUniverseSourceTable,
      lastRunAt: new Date().toISOString(),
    });
    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason: 'missing_enabled_or_priority_column',
      sourceTable: tokenUniverseSourceTable,
    });
    return;
  }

  const candidateMints = dedupeMints(tokenUniverseMints)
    .filter((mint) => mint !== USDC_MINT)
    .slice(0, Math.max(1, TOKEN_UNIVERSE_AUTO_SORT_MAX_MINTS));

  if (candidateMints.length === 0) {
    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason: 'no_candidates',
      candidateCount: 0,
      enabledCount: 0,
      topTokens: [],
    });
    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason: 'no_candidates',
      sourceTable: tokenUniverseSourceTable,
      lastRunAt: new Date().toISOString(),
    });
    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason: 'no_candidates',
      sourceTable: tokenUniverseSourceTable,
    });
    return;
  }

  const rankedSamples: TokenUniverseRankSample[] = [];
  const healthState = await loadTokenUniverseHealthState();
  tokenUniverseProbeFrozen = healthState.probeFrozen;
  const currentRun = healthState.run + 1;
  const nextHealthState: TokenUniverseHealthState = {
    run: currentRun,
    mints: { ...healthState.mints },
    probeFailureStreak: healthState.probeFailureStreak,
    probeHealthyStreak: healthState.probeHealthyStreak,
    probeFrozen: healthState.probeFrozen,
    probeFrozenAt: healthState.probeFrozenAt,
    lastSuccessfulProbeAt: healthState.lastSuccessfulProbeAt,
  };
  const pruneDecisions = new Map<string, { reason: string; deadRuns: number; crossedThreshold: boolean }>();
  const recoveredMints: string[] = [];
  let routeProbeUnavailableCount = 0;
  const protectedMints = new Set<string>([
    SOL_MINT,
    USDC_MINT,
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  ]);
  for (const mint of candidateMints) {
    const previous = nextHealthState.mints[mint] ?? null;
    const routeCheck = await apiPost<BuildRouteScoutResponse>('/jupiter/swap/build', {
      inputMint: USDC_MINT,
      outputMint: mint,
      amount: String(TOKEN_UNIVERSE_AUTO_SORT_NOTIONAL_USDC_ATOMIC),
      taker: universeSortProbeTaker,
      feeTokenSymbol: 'USDC',
      slippageBps: '50',
    }, { limiter: jupiterLimiter });

    if (!routeCheck.ok && routeCheck.status >= 500) {
      routeProbeUnavailableCount += 1;
      if (previous) {
        nextHealthState.mints[mint] = {
          ...previous,
          lastReason: 'route_probe_unavailable',
          lastSeenAt: new Date().toISOString(),
        };
      }
      continue;
    }

    const outAmountAtomic = parseUnsignedNumeric(routeCheck.data?.build?.outAmount);
    const routeFound = routeCheck.ok && Boolean(outAmountAtomic && outAmountAtomic > 0);
    const priceImpactBps = parseQuotePriceImpactBps(routeCheck.data?.build?.priceImpactPct ?? null);
    const usdPrice = latestJupiterUsdByMint.get(mint) ?? null;
    const priorUsdPrice = previousJupiterUsdByMint.get(mint) ?? null;
    const momentumBps = computePriceMomentumBps(usdPrice, priorUsdPrice);

    rankedSamples.push({
      mint,
      usdPrice,
      priorUsdPrice,
      momentumBps,
      routeFound,
      priceImpactBps,
      score: buildUniverseSortScore({ momentumBps, routeFound, priceImpactBps }),
    });

    let deadReason: string | null = null;
    if (!routeFound) {
      deadReason = 'route_not_found';
    } else if (priceImpactBps !== null && priceImpactBps > (TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS * 2)) {
      deadReason = 'extreme_price_impact';
    }

    if (deadReason) {
      const deadRuns = (previous?.deadRuns ?? 0) + 1;
      nextHealthState.mints[mint] = {
        deadRuns,
        admitRuns: previous?.admitRuns ?? 0,
        evictRuns: previous?.evictRuns ?? 0,
        enabled: previous?.enabled ?? false,
        enabledSinceRun: previous?.enabledSinceRun ?? null,
        lastReason: deadReason,
        lastSeenAt: new Date().toISOString(),
      };
      const crossedThreshold = (previous?.deadRuns ?? 0) < TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD
        && deadRuns >= TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD;
      pruneDecisions.set(mint, {
        reason: deadReason,
        deadRuns,
        crossedThreshold,
      });
    } else {
      if ((previous?.deadRuns ?? 0) >= TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD) {
        recoveredMints.push(mint);
      }
      nextHealthState.mints[mint] = {
        deadRuns: 0,
        admitRuns: previous?.admitRuns ?? 0,
        evictRuns: previous?.evictRuns ?? 0,
        enabled: previous?.enabled ?? false,
        enabledSinceRun: previous?.enabledSinceRun ?? null,
        lastReason: null,
        lastSeenAt: new Date().toISOString(),
      };
    }
  }

  const nowIso = new Date().toISOString();
  const hasProbeUnavailable = routeProbeUnavailableCount > 0;

  if (hasProbeUnavailable) {
    nextHealthState.probeFailureStreak = Math.max(1, nextHealthState.probeFailureStreak + 1);
    nextHealthState.probeHealthyStreak = 0;
  } else {
    nextHealthState.probeFailureStreak = 0;
    nextHealthState.probeHealthyStreak = Math.min(10_000, nextHealthState.probeHealthyStreak + 1);
    if (rankedSamples.length > 0) {
      nextHealthState.lastSuccessfulProbeAt = nowIso;
    }
  }

  if (!nextHealthState.probeFrozen
    && nextHealthState.probeFailureStreak >= Math.max(1, TOKEN_UNIVERSE_PROBE_FREEZE_FAILURE_STREAK)) {
    nextHealthState.probeFrozen = true;
    nextHealthState.probeFrozenAt = nowIso;
  }

  if (nextHealthState.probeFrozen
    && !hasProbeUnavailable
    && nextHealthState.probeHealthyStreak >= Math.max(1, TOKEN_UNIVERSE_PROBE_UNFREEZE_HEALTHY_STREAK)) {
    nextHealthState.probeFrozen = false;
    nextHealthState.probeFrozenAt = null;
    nextHealthState.probeFailureStreak = 0;
  }

  if (hasProbeUnavailable) {
    const reason = nextHealthState.probeFrozen
      ? 'probe_health_frozen'
      : 'route_probe_unavailable';
    const trimmed = trimTokenUniverseHealthState(nextHealthState);
    await persistTokenUniverseHealthState(trimmed);
    tokenUniverseProbeFrozen = trimmed.probeFrozen;

    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason,
      candidateCount: rankedSamples.length,
      enabledCount: 0,
      topTokens: [],
    });

    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason,
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
      lastRunAt: nowIso,
    });
    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason,
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    });
    return;
  }

  if (nextHealthState.probeFrozen) {
    const trimmed = trimTokenUniverseHealthState(nextHealthState);
    await persistTokenUniverseHealthState(trimmed);
    tokenUniverseProbeFrozen = trimmed.probeFrozen;

    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason: 'probe_health_frozen',
      candidateCount: rankedSamples.length,
      enabledCount: 0,
      topTokens: [],
    });

    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason: 'probe_health_frozen',
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
      lastRunAt: nowIso,
    });

    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason: 'probe_health_frozen',
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    });
    return;
  }

  if (rankedSamples.length === 0) {
    const reason = 'no_candidates_after_probe';

    const trimmed = trimTokenUniverseHealthState(nextHealthState);
    await persistTokenUniverseHealthState(trimmed);
    tokenUniverseProbeFrozen = trimmed.probeFrozen;

    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason,
      candidateCount: 0,
      enabledCount: 0,
      topTokens: [],
    });

    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason,
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
      lastRunAt: nowIso,
    });
    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason,
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    });
    return;
  }

  rankedSamples.sort((a, b) => b.score - a.score);
  const enabledTop = Math.max(1, TOKEN_UNIVERSE_AUTO_SORT_TOP_ENABLED);

  const dbPool = getTokenUniversePool();
  const table = tokenUniverseTableMeta.tableName;
  const mintColumn = tokenUniverseTableMeta.mintColumn;
  const enabledColumn = tokenUniverseTableMeta.enabledColumn;
  const priorityColumn = tokenUniverseTableMeta.priorityColumn;
  const updatedAtColumn = tokenUniverseTableMeta.updatedAtColumn;
  const deadletterRows: Array<{
    mint: string;
    reason: string;
    deadRuns: number;
    score: number;
    momentumBps: number;
    priceImpactBps: number | null;
  }> = [];
  const admittedRows: string[] = [];
  const evictedRows: string[] = [];

  for (let index = 0; index < rankedSamples.length; index += 1) {
    const sample = rankedSamples[index];
    const entry = nextHealthState.mints[sample.mint] ?? {
      deadRuns: 0,
      admitRuns: 0,
      evictRuns: 0,
      enabled: false,
      enabledSinceRun: null,
      lastReason: null,
      lastSeenAt: new Date().toISOString(),
    };

    const enableByRank = index < enabledTop;
    const evictionRank = enabledTop + Math.max(1, TOKEN_UNIVERSE_EVICTION_RANK_BUFFER);
    const rankAllowsStay = index < evictionRank;
    const enableByImpact = sample.priceImpactBps === null || sample.priceImpactBps <= TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS;
    const qualityPass = sample.routeFound && enableByImpact;
    const strongCandidate = qualityPass && enableByRank;
    const weakCandidate = !qualityPass || !rankAllowsStay;
    const pruneDecision = pruneDecisions.get(sample.mint);
    const shouldPrune = TOKEN_UNIVERSE_DEAD_PRUNE_ENABLED
      && Boolean(pruneDecision)
      && !protectedMints.has(sample.mint)
      && (pruneDecision?.deadRuns ?? 0) >= TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD;

    let shouldEnable = entry.enabled;
    let enabledSinceRun = entry.enabledSinceRun;
    let admitRuns = entry.admitRuns;
    let evictRuns = entry.evictRuns;

    if (shouldPrune) {
      shouldEnable = false;
      enabledSinceRun = null;
      admitRuns = 0;
      evictRuns = 0;
    } else if (!shouldEnable) {
      admitRuns = strongCandidate ? (admitRuns + 1) : 0;
      evictRuns = 0;
      if (admitRuns >= Math.max(1, TOKEN_UNIVERSE_ADMISSION_STREAK)) {
        shouldEnable = true;
        enabledSinceRun = currentRun;
        evictRuns = 0;
        admittedRows.push(sample.mint);
      }
    } else {
      admitRuns = strongCandidate ? Math.min(admitRuns + 1, 10_000) : admitRuns;
      const stayAge = enabledSinceRun === null ? 0 : (currentRun - enabledSinceRun);
      if (stayAge < Math.max(1, TOKEN_UNIVERSE_MIN_STAY_RUNS)) {
        evictRuns = 0;
      } else if (weakCandidate) {
        evictRuns += 1;
      } else {
        evictRuns = 0;
      }

      if (evictRuns >= Math.max(1, TOKEN_UNIVERSE_EVICTION_STREAK)) {
        shouldEnable = false;
        enabledSinceRun = null;
        admitRuns = 0;
        evictRuns = 0;
        evictedRows.push(sample.mint);
      }
    }

    nextHealthState.mints[sample.mint] = {
      ...entry,
      admitRuns,
      evictRuns,
      enabled: shouldEnable,
      enabledSinceRun,
      lastReason: shouldPrune
        ? (pruneDecision?.reason ?? entry.lastReason)
        : weakCandidate
          ? 'weak_candidate'
          : strongCandidate
            ? 'strong_candidate'
            : entry.lastReason,
      lastSeenAt: new Date().toISOString(),
    };

    const priority = shouldPrune ? 0 : Math.max(0, 1_000 - index);

    const updateSql = updatedAtColumn
      ? `UPDATE public.${table}
           SET ${enabledColumn} = $1,
               ${priorityColumn} = $2,
               ${updatedAtColumn} = NOW()
         WHERE ${mintColumn}::text = $3`
      : `UPDATE public.${table}
           SET ${enabledColumn} = $1,
               ${priorityColumn} = $2
         WHERE ${mintColumn}::text = $3`;

    await dbPool.query(updateSql, [shouldEnable, priority, sample.mint]);

    if (shouldPrune && pruneDecision?.crossedThreshold) {
      deadletterRows.push({
        mint: sample.mint,
        reason: pruneDecision.reason,
        deadRuns: pruneDecision.deadRuns,
        score: sample.score,
        momentumBps: sample.momentumBps,
        priceImpactBps: sample.priceImpactBps,
      });
    }
  }

  if (deadletterRows.length > 0) {
    for (const row of deadletterRows) {
      try {
        await dbPool.query(
          `INSERT INTO public.rogueai_token_universe_deadletter (
             source_table, mint, symbol, reason, dead_runs, score,
             momentum_bps, price_impact_bps, details, dumped_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())`,
          [
            table,
            row.mint,
            null,
            row.reason,
            row.deadRuns,
            row.score,
            row.momentumBps,
            row.priceImpactBps,
            JSON.stringify({
              reason: row.reason,
              deadRuns: row.deadRuns,
              score: row.score,
              momentumBps: row.momentumBps,
              priceImpactBps: row.priceImpactBps,
            }),
          ],
        );
      } catch {
        // deadletter writes are best-effort only
      }
    }
  }

  if (recoveredMints.length > 0) {
    for (const mint of recoveredMints) {
      try {
        await dbPool.query(
          `UPDATE public.rogueai_token_universe_deadletter
              SET recovered_at = now(),
                  recovered_reason = 'route_and_impact_recovered'
            WHERE id = (
              SELECT id
                FROM public.rogueai_token_universe_deadletter
               WHERE mint = $1
                 AND recovered_at IS NULL
               ORDER BY dumped_at DESC
               LIMIT 1
            )`,
          [mint],
        );
      } catch {
        // best-effort only
      }
    }
  }

  const trimmed = trimTokenUniverseHealthState(nextHealthState);
  await persistTokenUniverseHealthState(trimmed);
  tokenUniverseProbeFrozen = trimmed.probeFrozen;

  logPriceEvent({
    provider: 'token-universe',
    autoSort: 'applied',
    sourceTable: table,
    candidateCount: rankedSamples.length,
    enabledCount: rankedSamples.filter((sample, idx) => idx < enabledTop && sample.routeFound && (sample.priceImpactBps === null || sample.priceImpactBps <= TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS)).length,
    deadDumpCount: deadletterRows.length,
    recoveredCount: recoveredMints.length,
    admittedCount: admittedRows.length,
    evictedCount: evictedRows.length,
    routeProbeUnavailableCount,
    probeFailureStreak: trimmed.probeFailureStreak,
    probeHealthyStreak: trimmed.probeHealthyStreak,
    probeFrozenAt: trimmed.probeFrozenAt,
    lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    top: rankedSamples.slice(0, 5).map((sample, idx) => ({
      rank: idx + 1,
      mint: sample.mint,
      score: sample.score,
      momentumBps: sample.momentumBps,
      priceImpactBps: sample.priceImpactBps,
      routeFound: sample.routeFound,
    })),
  });

  const enabledCount = rankedSamples.filter((sample, idx) => idx < enabledTop && sample.routeFound && (sample.priceImpactBps === null || sample.priceImpactBps <= TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS)).length;
  lastTokenUniverseEngineAppliedAt = Date.now();
  lastTokenUniverseEngineEnabledCount = enabledCount;

  const avgMomentumBps = rankedSamples.length > 0
    ? rankedSamples.reduce((sum, sample) => sum + sample.momentumBps, 0) / rankedSamples.length
    : 0;
  const impactSamples = rankedSamples
    .map((sample) => sample.priceImpactBps)
    .filter((value): value is number => value !== null);
  const avgPriceImpactBps = impactSamples.length > 0
    ? impactSamples.reduce((sum, value) => sum + value, 0) / impactSamples.length
    : null;

  await persistTokenUniverseMetadata({
    sourceTable: table,
    status: 'applied',
    reason: null,
    candidateCount: rankedSamples.length,
    enabledCount,
    avgMomentumBps,
    avgPriceImpactBps,
    topTokens: rankedSamples.slice(0, 10).map((sample, idx) => ({
      rank: idx + 1,
      mint: sample.mint,
      score: sample.score,
      momentumBps: sample.momentumBps,
      priceImpactBps: sample.priceImpactBps,
      routeFound: sample.routeFound,
    })),
  }, dbPool);

  await persistTokenUniverseAutoSortState({
    status: 'applied',
    reason: null,
    sourceTable: table,
    candidateCount: rankedSamples.length,
    enabledCount,
    deadDumpCount: deadletterRows.length,
    recoveredCount: recoveredMints.length,
    admittedCount: admittedRows.length,
    evictedCount: evictedRows.length,
    routeProbeUnavailableCount,
    probeFailureStreak: trimmed.probeFailureStreak,
    probeHealthyStreak: trimmed.probeHealthyStreak,
    probeFrozenAt: trimmed.probeFrozenAt,
    lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    top: rankedSamples.slice(0, 5).map((sample, idx) => ({
      rank: idx + 1,
      mint: sample.mint,
      score: sample.score,
      momentumBps: sample.momentumBps,
      priceImpactBps: sample.priceImpactBps,
      routeFound: sample.routeFound,
    })),
    lastRunAt: new Date().toISOString(),
  });
};

const ensureTokenUniverseTable = async () => {
  if (tokenUniverseBootstrapAttempted || !TOKEN_UNIVERSE_BOOTSTRAP_ENABLED) {
    return;
  }
  tokenUniverseBootstrapAttempted = true;

  try {
    const dbPool = getTokenUniversePool();
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS public.rogueai_token_universe (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        priority INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS public.rogueai_token_universe_metadata (
        id BIGSERIAL PRIMARY KEY,
        source_table TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        candidate_count INTEGER,
        enabled_count INTEGER,
        avg_momentum_bps DOUBLE PRECISION,
        avg_price_impact_bps DOUBLE PRECISION,
        top_tokens JSONB,
        built_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS public.rogueai_token_universe_deadletter (
        id BIGSERIAL PRIMARY KEY,
        source_table TEXT,
        mint TEXT NOT NULL,
        symbol TEXT,
        reason TEXT NOT NULL,
        dead_runs INTEGER NOT NULL,
        score DOUBLE PRECISION,
        momentum_bps DOUBLE PRECISION,
        price_impact_bps DOUBLE PRECISION,
        dumped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        details JSONB
      )
    `);

    await dbPool.query(`
      ALTER TABLE public.rogueai_token_universe_deadletter
      ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS recovered_reason TEXT
    `);

    for (const token of DEFAULT_TOKEN_UNIVERSE_SEED) {
      await dbPool.query(
        `INSERT INTO public.rogueai_token_universe (mint, symbol, enabled, priority)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (mint) DO NOTHING`,
        [token.mint, token.symbol, token.priority],
      );
    }

    logPriceEvent({
      provider: 'token-universe',
      bootstrap: 'completed',
      table: 'rogueai_token_universe',
      seeded: DEFAULT_TOKEN_UNIVERSE_SEED.length,
    });
  } catch (err) {
    logPriceEvent({
      provider: 'token-universe',
      bootstrap: 'failed',
      error: String(err),
    });
  }
};

const refreshTokenUniverseMints = async (force = false) => {
  const now = Date.now();
  if (!force && (now - lastTokenUniverseRefreshAt) < TOKEN_UNIVERSE_REFRESH_MS) {
    return tokenUniverseMints;
  }
  lastTokenUniverseRefreshAt = now;

  if (TOKEN_UNIVERSE_TABLE_CANDIDATES.length === 0) {
    tokenUniverseMints = [];
    tokenUniverseSourceTable = null;
    tokenUniverseTableMeta = null;
    return tokenUniverseMints;
  }

  try {
    await ensureTokenUniverseTable();
    const dbPool = getTokenUniversePool();
    const tableResult = await dbPool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [TOKEN_UNIVERSE_TABLE_CANDIDATES],
    );

    const existingTables = new Set(tableResult.rows.map((row) => row.table_name));
    const selectedTable = TOKEN_UNIVERSE_TABLE_CANDIDATES.find((candidate) => existingTables.has(candidate)) ?? null;

    if (!selectedTable || !isSafeSqlIdentifier(selectedTable)) {
      tokenUniverseMints = [];
      tokenUniverseSourceTable = null;
      tokenUniverseTableMeta = null;
      return tokenUniverseMints;
    }

    const columnsResult = await dbPool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1`,
      [selectedTable],
    );
    const columns = new Set(columnsResult.rows.map((row) => row.column_name));

    const mintColumn = ['mint', 'mint_address', 'token_mint', 'address'].find((column) => columns.has(column)) ?? null;
    if (!mintColumn || !isSafeSqlIdentifier(mintColumn)) {
      tokenUniverseMints = [];
      tokenUniverseSourceTable = selectedTable;
      tokenUniverseTableMeta = null;
      return tokenUniverseMints;
    }

    const enabledColumn = ['enabled', 'is_enabled', 'active'].find((column) => columns.has(column)) ?? null;
    const priorityColumn = ['priority', 'rank', 'score', 'weight'].find((column) => columns.has(column)) ?? null;
    const updatedAtColumn = ['updated_at', 'updatedAt', 'modified_at'].find((column) => columns.has(column)) ?? null;

    const whereClause = (!TOKEN_UNIVERSE_AUTO_SORT_ENABLED && enabledColumn && isSafeSqlIdentifier(enabledColumn))
      ? `WHERE COALESCE(${enabledColumn}, true) = true`
      : '';
    const orderClause = priorityColumn && isSafeSqlIdentifier(priorityColumn)
      ? `ORDER BY ${priorityColumn} DESC NULLS LAST`
      : '';

    const query = `SELECT ${mintColumn}::text AS mint
                     FROM public.${selectedTable}
                     ${whereClause}
                     ${orderClause}
                     LIMIT ${Math.max(1, TOKEN_UNIVERSE_MAX_MINTS)}`;

    const mintResult = await dbPool.query<{ mint: string | null }>(query);
    tokenUniverseMints = dedupeMints(mintResult.rows.map((row) => row.mint ?? ''));
    tokenUniverseSourceTable = selectedTable;
    tokenUniverseTableMeta = {
      tableName: selectedTable,
      mintColumn,
      enabledColumn: enabledColumn && isSafeSqlIdentifier(enabledColumn) ? enabledColumn : null,
      priorityColumn: priorityColumn && isSafeSqlIdentifier(priorityColumn) ? priorityColumn : null,
      updatedAtColumn: updatedAtColumn && isSafeSqlIdentifier(updatedAtColumn) ? updatedAtColumn : null,
    };

    logPriceEvent({
      provider: 'token-universe',
      sourceTable: tokenUniverseSourceTable,
      mintCount: tokenUniverseMints.length,
    });
  } catch (err) {
    logPriceEvent({
      provider: 'token-universe',
      error: String(err),
    });
  }

  return tokenUniverseMints;
};

const fetchPythSolUsd = async (): Promise<PythSample> => {
  if (!pythPriceConfig) {
    throw new Error('pyth price config not initialised');
  }
  const url =
    `${pythPriceConfig.hermesBaseUrl}/v2/updates/price/latest` +
    `?ids%5B%5D=${pythPriceConfig.solUsdFeedId}`;
  const res = await fetch(url, {
    headers: pythPriceConfig.apiKey
      ? { Authorization: `Bearer ${pythPriceConfig.apiKey}` }
      : undefined,
  });
  if (!res.ok) {
    throw new Error(`pyth hermes ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    parsed?: Array<{
      id: string;
      price: { price: string; conf: string; expo: number; publish_time: number };
      metadata?: { slot?: number };
    }>;
  };
  const parsed = body.parsed?.find((p) => p.id === pythPriceConfig!.solUsdFeedId);
  if (!parsed) {
    throw new Error(`pyth hermes response missing feed ${pythPriceConfig.solUsdFeedId}`);
  }
  const expo = parsed.price.expo;
  const scale = Math.pow(10, expo);
  const usdPrice = Number(parsed.price.price) * scale;
  const confidenceUsd = Number(parsed.price.conf) * scale;
  const confidenceBps = usdPrice > 0
    ? Math.round((confidenceUsd / usdPrice) * 10_000)
    : 0;
  return {
    source: 'pyth-hermes',
    feedId: parsed.id,
    usdPrice,
    confidenceUsd,
    confidenceBps,
    publishTime: parsed.price.publish_time,
    slot: parsed.metadata?.slot ?? 0,
    sampledAt: new Date().toISOString(),
  };
};

const fetchJupiterPricesUsd = async (
  mints: readonly string[],
): Promise<Record<string, JupiterPriceSample>> => {
  if (!jupiterPriceConfig) {
    throw new Error('jupiter price config not initialised');
  }
  await jupiterLimiter.acquire();
  const url = `${jupiterPriceConfig.apiBaseUrl}?ids=${mints.join(',')}`;
  const res = await fetch(url, {
    headers: { 'x-api-key': jupiterPriceConfig.apiKey },
  });
  if (!res.ok) {
    throw new Error(`jupiter price v3 ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Record<
    string,
    { usdPrice: number; blockId: number; decimals: number } | null
  >;
  const out: Record<string, JupiterPriceSample> = {};
  const sampledAt = new Date().toISOString();
  for (const mint of mints) {
    const entry = body[mint];
    if (entry && typeof entry.usdPrice === 'number') {
      out[mint] = {
        source: 'jupiter-price-v3',
        mint,
        usdPrice: entry.usdPrice,
        blockId: entry.blockId,
        decimals: entry.decimals,
        sampledAt,
      };
    }
  }
  return out;
};

const computeDriftBps = (a: number, b: number): number => {
  if (!a || !b) return 0;
  return Math.round(((a - b) / b) * 10_000);
};

const runPythPollTick = async (): Promise<void> => {
  if (!pythPriceConfig) return;
  try {
    const sample = await fetchPythSolUsd();
    pythConsecutiveFailures = 0;
    const guardReason = getPythGuardReason(sample);

    if (guardReason) {
      lastSignalSnapshot = {
        at: new Date().toISOString(),
        source: 'pyth-hermes',
        signal: 'momentum',
        status: 'guarded_off',
        regime: null,
        lookbackSamples: signalPolicy.momentumLookbackSamples,
        thresholdBps: signalPolicy.momentumThresholdBps,
        momentumBps: null,
        guardReason,
      };
      logPriceEvent({
        provider: 'pyth-hermes',
        feed: 'SOL/USD',
        accepted: false,
        guardReason,
        usdPrice: sample.usdPrice,
        confidenceUsd: sample.confidenceUsd,
        confidenceBps: sample.confidenceBps,
        publishTime: sample.publishTime,
        ageSeconds: getPythSampleAgeSeconds(sample),
        slot: sample.slot,
      });
      logSignalEvent({
        source: 'pyth-hermes',
        signal: 'momentum',
        status: 'guarded_off',
        lookbackSamples: signalPolicy.momentumLookbackSamples,
        thresholdBps: signalPolicy.momentumThresholdBps,
        momentumBps: null,
        regime: null,
        guardReason,
        tapeDepth: sharedMarketTape.solUsdPyth.length,
      });
      return;
    }

    lastPythSolSample = sample;
    pushBounded(sharedMarketTape.solUsdPyth, {
      sampledAt: sample.sampledAt,
      usdPrice: sample.usdPrice,
      source: 'pyth-hermes',
    }, pricePollPolicy.sharedTapeSize);
    const momentumBps = computeMomentumBps(
      sharedMarketTape.solUsdPyth,
      signalPolicy.momentumLookbackSamples,
    );
    logPriceEvent({
      provider: 'pyth-hermes',
      feed: 'SOL/USD',
      accepted: true,
      usdPrice: sample.usdPrice,
      confidenceUsd: sample.confidenceUsd,
      confidenceBps: sample.confidenceBps,
      publishTime: sample.publishTime,
      ageSeconds: getPythSampleAgeSeconds(sample),
      slot: sample.slot,
      tapeDepth: sharedMarketTape.solUsdPyth.length,
    });
    lastSignalSnapshot = {
      at: new Date().toISOString(),
      source: 'pyth-hermes',
      signal: 'momentum',
      status: momentumBps === null ? 'warming_up' : 'ready',
      regime: momentumBps === null
        ? null
        : classifyMomentum(momentumBps, signalPolicy.momentumThresholdBps),
      lookbackSamples: signalPolicy.momentumLookbackSamples,
      thresholdBps: signalPolicy.momentumThresholdBps,
      momentumBps,
      guardReason: null,
    };
    logSignalEvent({
      source: 'pyth-hermes',
      signal: 'momentum',
      status: momentumBps === null ? 'warming_up' : 'ready',
      lookbackSamples: signalPolicy.momentumLookbackSamples,
      thresholdBps: signalPolicy.momentumThresholdBps,
      momentumBps,
      regime: momentumBps === null
        ? null
        : classifyMomentum(momentumBps, signalPolicy.momentumThresholdBps),
      guardReason: null,
      tapeDepth: sharedMarketTape.solUsdPyth.length,
    });

    await persistMarketTapeState();
  } catch (err) {
    pythConsecutiveFailures += 1;
    logPriceEvent({
      provider: 'pyth-hermes',
      feed: 'SOL/USD',
      error: String(err),
      consecutiveFailures: pythConsecutiveFailures,
    });
  }
};

const runJupiterPricePollTick = async (): Promise<void> => {
  if (!jupiterPriceConfig) return;
  try {
    await refreshTokenUniverseMints();
    const mints = dedupeMints([
      ...jupiterPriceConfig.defaultMints,
      ...tokenUniverseMints,
    ]);
    const samples = await fetchJupiterPricesUsd(mints);
    for (const mint of Object.keys(samples)) {
      const nextUsd = samples[mint]?.usdPrice;
      if (typeof nextUsd !== 'number' || !Number.isFinite(nextUsd) || nextUsd <= 0) {
        continue;
      }
      const currentUsd = latestJupiterUsdByMint.get(mint);
      if (typeof currentUsd === 'number' && Number.isFinite(currentUsd) && currentUsd > 0) {
        previousJupiterUsdByMint.set(mint, currentUsd);
      }
      latestJupiterUsdByMint.set(mint, nextUsd);
    }
    const sol = samples[SOL_MINT];
    const usdc = samples[USDC_MINT];
    if (sol) {
      lastJupiterSolSample = sol;
      pushBounded(sharedMarketTape.solUsdJupiter, {
        sampledAt: sol.sampledAt,
        usdPrice: sol.usdPrice,
        source: 'jupiter-price-v3',
      }, pricePollPolicy.sharedTapeSize);
    }
    jupiterPriceConsecutiveFailures = 0;
    const driftBpsVsPyth =
      sol && lastPythSolSample
        ? computeDriftBps(sol.usdPrice, lastPythSolSample.usdPrice)
        : null;
    if (sol && lastPythSolSample && driftBpsVsPyth !== null) {
      pushBounded(sharedMarketTape.solUsdDrift, {
        sampledAt: new Date().toISOString(),
        pythUsd: lastPythSolSample.usdPrice,
        jupiterUsd: sol.usdPrice,
        driftBps: driftBpsVsPyth,
      }, pricePollPolicy.sharedTapeSize);
    }
    logPriceEvent({
      provider: 'jupiter-price-v3',
      trackedMintCount: mints.length,
      tokenUniverseMintCount: tokenUniverseMints.length,
      tokenUniverseSourceTable,
      solUsd: sol?.usdPrice ?? null,
      solBlockId: sol?.blockId ?? null,
      usdcUsd: usdc?.usdPrice ?? null,
      pythSolUsd: lastPythSolSample?.usdPrice ?? null,
      driftBpsJupiterMinusPyth: driftBpsVsPyth,
      tape: getSharedMarketTapeSummary(),
    });

    await applyTokenUniverseAutoSort();

    await persistMarketTapeState();
  } catch (err) {
    jupiterPriceConsecutiveFailures += 1;
    logPriceEvent({
      provider: 'jupiter-price-v3',
      error: String(err),
      consecutiveFailures: jupiterPriceConsecutiveFailures,
    });
  }
};

let pythTimer: NodeJS.Timeout | null = null;
let jupiterPriceTimer: NodeJS.Timeout | null = null;

const startPriceLoops = (): void => {
  if (!pythPriceConfig && !jupiterPriceConfig) {
    console.warn('[worker] price loops not started â€” no price provider configured');
    return;
  }
  const schedulePyth = () => {
    pythTimer = setTimeout(async () => {
      if (pythConsecutiveFailures >= pricePollPolicy.maxConsecutiveFailures) {
        logPriceEvent({
          provider: 'pyth-hermes',
          paused: true,
          reason: 'max_consecutive_failures',
        });
        return;
      }
      await runPythPollTick();
      schedulePyth();
    }, pricePollPolicy.pythPollMs);
  };
  const scheduleJupiter = () => {
    jupiterPriceTimer = setTimeout(async () => {
      if (jupiterPriceConsecutiveFailures >= pricePollPolicy.maxConsecutiveFailures) {
        logPriceEvent({
          provider: 'jupiter-price-v3',
          paused: true,
          reason: 'max_consecutive_failures',
        });
        return;
      }
      await runJupiterPricePollTick();
      scheduleJupiter();
    }, pricePollPolicy.jupiterPricePollMs);
  };
  // Fire first samples immediately so we have data within the first second.
  void runPythPollTick().then(schedulePyth);
  void runJupiterPricePollTick().then(scheduleJupiter);
};

// â”€â”€ Rate-limited Helius RPC helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const rlGetBalance = async (pubkey: PublicKey, commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Promise<number> => {
  await heliusLimiter.acquire();
  return getConnection().getBalance(pubkey, commitment);
};

const rlGetLatestBlockhash = async () => {
  await heliusLimiter.acquire();
  return getConnection().getLatestBlockhash();
};

const rlGetMinimumBalanceForRentExemption = async (dataLength: number): Promise<number> => {
  await heliusLimiter.acquire();
  return getConnection().getMinimumBalanceForRentExemption(dataLength);
};

const rlGetMint = async (address: PublicKey, programId: PublicKey): Promise<SplTokenMint> => {
  await heliusLimiter.acquire();
  return getMint(getConnection(), address, 'confirmed', programId);
};

const rlGetTokenAccountsByOwner = async (
  owner: PublicKey,
  programId: PublicKey,
  commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
) => {
  await heliusLimiter.acquire();
  return getConnection().getTokenAccountsByOwner(owner, { programId }, commitment);
};

const rlConfirmTransaction = async (args: { signature: string; blockhash: string; lastValidBlockHeight: number }) => {
  await heliusLimiter.acquire();
  return getConnection().confirmTransaction(args);
};

const rlSendRawTransaction = async (serializedTransaction: Buffer | Uint8Array) => {
  await heliusLimiter.acquire();
  return getConnection().sendRawTransaction(serializedTransaction, {
    skipPreflight: true,
    maxRetries: 0,
  });
};

// â”€â”€ API helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const apiPost = async <T>(
  path: string,
  body: unknown,
  opts: { limiter?: { acquire: () => Promise<void> } } = {},
): Promise<{ ok: boolean; status: number; data: T }> => {
  const MAX_ATTEMPTS = 5;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (opts.limiter) await opts.limiter.acquire();

      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(WORKER_INTERNAL_SECRET ? { 'x-rz-internal-secret': WORKER_INTERNAL_SECRET } : {}),
        },
        body: JSON.stringify(body),
      });

      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < MAX_ATTEMPTS) {
        const delayMs = getExponentialBackoffDelayMs(attempt);
        console.log(JSON.stringify({
          level: 'warn',
          service: 'roguezero-worker',
          msg: `${res.status} on ${path} â€” backing off ${delayMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`,
          ts: new Date().toISOString(),
        }));
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      const data = await res.json() as T;
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        throw error;
      }

      const delayMs = getExponentialBackoffDelayMs(attempt);
      console.log(JSON.stringify({
        level: 'warn',
        service: 'roguezero-worker',
        msg: `network error on ${path} â€” backing off ${delayMs}ms (attempt ${attempt}/${MAX_ATTEMPTS}): ${String(error)}`,
        ts: new Date().toISOString(),
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // All retries exhausted â€” return synthetic 429
  return { ok: false, status: 429, data: { error: 'rate_limit_exhausted' } as T };
};

// â”€â”€ Funding check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const fundingSubscriptionIds = new Map<string, number>();
const lastFundingCheckAt = new Map<string, number>();
const fundingChecksInFlight = new Set<string>();

const failFundingSession = async (
  session: RawSession,
  balance: number,
  reason: string,
) => {
  await mergeFundingPatch(session, {
    startingBalanceAtomic: String(balance),
    currentBalanceAtomic: String(balance),
  });
  await setSessionStatus(
    session.id,
    'error',
    { stop_reason: 'runtime_error' },
    { expectedStatuses: ['awaiting_funding'] },
  );
  unsubscribeFundingSession(session.id);
  log('error', session.id, `${reason} -> error`);
};

const checkFunding = async (session: RawSession, observedBalance?: number): Promise<void> => {
  let balance = observedBalance;
  if (balance === undefined) {
    try {
      balance = await rlGetBalance(new PublicKey(session.session_wallet));
    } catch (err) {
      log('warn', session.id, `balance check failed: ${String(err)}`);
      return;
    }
  }

  lastFundingCheckAt.set(session.id, Date.now());

  const balanceAtomic = String(balance);
  if (session.funding.currentBalanceAtomic !== balanceAtomic) {
    try {
      await mergeFundingPatch(session, {
        currentBalanceAtomic: balanceAtomic,
      });
    } catch (err) {
      log('warn', session.id, `failed to persist awaiting-funding balance: ${String(err)}`);
    }
  }

  if (balance >= MIN_TRADEABLE_LAMPORTS) {
    const kp = await getKeypair(session.id);
    if (!kp) {
      await failFundingSession(
        session,
        balance,
        `funded session is missing its persisted keypair for wallet ${session.session_wallet}`,
      );
      return;
    }
    if (kp.publicKey.toBase58() !== session.session_wallet) {
      await failFundingSession(
        session,
        balance,
        `persisted keypair mismatch during funding check: stored=${kp.publicKey.toBase58()} session=${session.session_wallet}`,
      );
      return;
    }
    const markedAt = new Date().toISOString();
    const markedPriceUsd = lastPythSolSample?.usdPrice ?? null;
    await mergeFundingPatch(session, {
      startingBalanceAtomic: balanceAtomic,
      currentBalanceAtomic: balanceAtomic,
    });
    await persistServiceControl(session, {
      positionState: {
        status: 'flat',
        entryPriceUsd: null,
        entryAt: null,
        quantityAtomic: null,
        highWaterPriceUsd: null,
        lastMarkedPriceUsd: markedPriceUsd,
        lastMarkedAt: markedAt,
        pendingExitReason: null,
        exitReason: null,
      },
    });
    await setSessionStatus(session.id, 'ready', {}, { expectedStatuses: ['awaiting_funding'] });
    const listenerId = fundingSubscriptionIds.get(session.id);
    if (listenerId !== undefined) {
      getConnection().removeAccountChangeListener(listenerId).catch((err) => {
        log('warn', session.id, `failed to remove funding subscription: ${String(err)}`);
      });
      fundingSubscriptionIds.delete(session.id);
    }
    log('info', session.id, `funded (${balance} lamports) â†’ ready`);
  } else {
    log('info', session.id, `awaiting funding â€” balance: ${balance}/${MIN_TRADEABLE_LAMPORTS} lamports`);
  }
};

const runFundingCheck = async (sessionId: string, observedBalance?: number): Promise<void> => {
  if (fundingChecksInFlight.has(sessionId)) {
    return;
  }

  fundingChecksInFlight.add(sessionId);
  try {
    const session = await getSessionById(sessionId);
    if (!session || session.status !== 'awaiting_funding') {
      return;
    }

    await checkFunding(session, observedBalance);
  } finally {
    fundingChecksInFlight.delete(sessionId);
  }
};

const subscribeFundingSession = (session: RawSession) => {
  if (fundingSubscriptionIds.has(session.id)) {
    return;
  }

  const sessionWallet = new PublicKey(session.session_wallet);
  const listenerId = getConnection().onAccountChange(
    sessionWallet,
    (accountInfo) => {
      if (accountInfo.lamports < MIN_TRADEABLE_LAMPORTS) {
        return;
      }

      log('info', session.id, `funding subscription noticed ${accountInfo.lamports} lamports`);
      void runFundingCheck(session.id, accountInfo.lamports);
    },
    'confirmed',
  );

  fundingSubscriptionIds.set(session.id, listenerId);
  void runFundingCheck(session.id);
};

const unsubscribeFundingSession = (sessionId: string) => {
  const listenerId = fundingSubscriptionIds.get(sessionId);
  if (listenerId === undefined) {
    return;
  }

  getConnection().removeAccountChangeListener(listenerId).catch((err) => {
    log('warn', sessionId, `failed to remove funding subscription: ${String(err)}`);
  });
  fundingSubscriptionIds.delete(sessionId);
  lastFundingCheckAt.delete(sessionId);
};

const syncFundingSubscriptions = (sessions: RawSession[]) => {
  const awaitingFundingSessionIds = new Set(
    sessions
      .filter((session) => session.status === 'awaiting_funding')
      .map((session) => session.id),
  );

  for (const session of sessions) {
    if (session.status === 'awaiting_funding') {
      subscribeFundingSession(session);
    }
  }

  for (const sessionId of fundingSubscriptionIds.keys()) {
    if (!awaitingFundingSessionIds.has(sessionId)) {
      unsubscribeFundingSession(sessionId);
    }
  }
};

const shouldRunFundingFallbackCheck = (sessionId: string) => {
  const lastCheckAt = lastFundingCheckAt.get(sessionId) ?? 0;
  return (Date.now() - lastCheckAt) >= FUNDING_POLL_FALLBACK_MS;
};

// â”€â”€ Auto-start ready session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const activateSession = async (session: RawSession): Promise<void> => {
  const now = new Date().toISOString();
  await setSessionStatus(session.id, 'active', { started_at: now }, { expectedStatuses: ['ready', 'starting'] });
  log('info', session.id, 'ready â†’ active, trading loop begins');
};

// â”€â”€ Trade execution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type PrepareResponse = {
  executionId?: string;
  preparedTransactionBase64?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  quote?: {
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    priceImpactPct: string | null;
  };
  costs?: {
    baseTxFeeLamports: number;
    priorityFeeMicroLamports: number | null;
    estimatedPriorityFeeLamports: number;
    senderTipLamports: number;
    estimatedNetworkCostLamports: number;
  };
  simulation?: { err: unknown; unitsConsumed: number | null };
  shortfall?: {
    availableLamports: number;
    requiredLamports: number;
    gapLamports: number;
  };
  error?: string;
};

type BuildRouteScoutResponse = {
  build?: {
    outAmount?: string;
    priceImpactPct?: string | null;
  };
  error?: string;
};

type UniverseScoutSample = {
  mint: string;
  routeFound: boolean;
  outAmountAtomic: number | null;
  priceImpactBps: number | null;
};

type SubmitResponse = {
  submitted?: boolean;
  signature?: string;
  status?: string;
  shortfall?: {
    availableLamports: number;
    requiredLamports: number;
    gapLamports: number;
  };
  error?: string;
};

type PreparedTradeEconomics = {
  remainingRiskBudgetUsd: number;
  tradeNotionalUsd: number;
  quotedOutAmountAtomic: number;
  minimumOutputAtomic: number;
  priceImpactPct: string | null;
  estimatedNetworkCostLamports: number;
  estimatedNetworkCostUsd: number;
  estimatedNetworkCostOutputAtomic: number;
  worstCaseSlippageUsd: number;
  worstCaseSlippageOutputAtomic: number;
  totalWorstCaseCostUsd: number;
  totalWorstCaseCostOutputAtomic: number;
  economicallyViable: boolean;
  withinRiskBudget: boolean;
  riskAdjustedAmountLamports: number | null;
};

const USDC_ATOMIC_PER_USD = 1_000_000;

type TradeInventoryContext = {
  inputMint: typeof SOL_MINT | typeof USDC_MINT;
  inputSymbol: 'SOL' | 'USDC';
  outputMint: typeof SOL_MINT | typeof USDC_MINT;
  outputSymbol: 'SOL' | 'USDC';
  balanceAtomic: number;
  reserveAtomic: number;
  tradableAtomic: number;
  targetAtomic: number;
  minTradeAtomic: number;
  maxTradeAtomic: number;
  amountAtomic: number | null;
  riskAdjustedAmountAtomic: number | null;
};

type TradeExecutionPlan = {
  direction: 'exit_long_sol' | 'enter_long_sol';
  inventory: TradeInventoryContext;
  exitReason: NonNullable<Session['serviceControl']['positionState']>['exitReason'];
};

type ExitTriggerDecision = {
  shouldExit: boolean;
  reason: NonNullable<Session['serviceControl']['positionState']>['exitReason'];
  markPriceUsd: number | null;
  pnlBps: number | null;
  trailingDrawdownBps: number | null;
};

type UsdcTradeSizingDecision = {
  skip: boolean;
  reason: string | null;
  balanceAtomic: number;
  reserveAtomic: number;
  tradableAtomic: number;
  targetAtomic: number;
  minTradeAtomic: number;
  maxTradeAtomic: number;
  amountAtomic: number;
};

const parseUnsignedNumeric = (value: string | null | undefined) => {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getUniverseScoutCandidateMints = () => dedupeMints([
  SOL_MINT,
  ...tokenUniverseMints,
])
  .filter((mint) => mint !== USDC_MINT)
  .slice(0, Math.max(1, WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES));

const scoutEntryUniverse = async (params: {
  amountAtomic: number;
  takerWallet: string;
  slippageBps: number;
}) => {
  const candidates = getUniverseScoutCandidateMints();
  const samples: UniverseScoutSample[] = [];

  for (const candidateMint of candidates) {
    const build = await apiPost<BuildRouteScoutResponse>('/jupiter/swap/build', {
      inputMint: USDC_MINT,
      outputMint: candidateMint,
      amount: String(params.amountAtomic),
      taker: params.takerWallet,
      feeTokenSymbol: 'USDC',
      slippageBps: String(params.slippageBps),
    }, { limiter: jupiterLimiter });

    if (!build.ok || !build.data.build) {
      samples.push({
        mint: candidateMint,
        routeFound: false,
        outAmountAtomic: null,
        priceImpactBps: null,
      });
      continue;
    }

    const outAmountAtomic = parseUnsignedNumeric(build.data.build.outAmount);
    const priceImpactBps = parseQuotePriceImpactBps(build.data.build.priceImpactPct ?? null);

    samples.push({
      mint: candidateMint,
      routeFound: Boolean(outAmountAtomic && outAmountAtomic > 0),
      outAmountAtomic,
      priceImpactBps,
    });
  }

  const ranked = samples
    .filter((sample) => sample.routeFound)
    .map((sample) => ({
      ...sample,
      effectiveImpactBps: sample.priceImpactBps ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.effectiveImpactBps - b.effectiveImpactBps);

  const solRankIndex = ranked.findIndex((sample) => sample.mint === SOL_MINT);
  const solRank = solRankIndex >= 0 ? solRankIndex + 1 : null;
  const solSample = ranked.find((sample) => sample.mint === SOL_MINT) ?? null;

  return {
    candidates,
    ranked,
    solRank,
    solPriceImpactBps: solSample?.priceImpactBps ?? null,
    bestMint: ranked[0]?.mint ?? null,
  };
};

const getUsdValueFromAtomicAmount = (mint: string, amountAtomic: number): number => {
  if (amountAtomic <= 0) {
    return 0;
  }

  if (mint === USDC_MINT) {
    return amountAtomic / USDC_ATOMIC_PER_USD;
  }

  if (mint === SOL_MINT) {
    const solUsd = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;
    if (solUsd <= 0) {
      return 0;
    }
    return (amountAtomic / 1_000_000_000) * solUsd;
  }

  return 0;
};

const computeUsdcTradeAmountAtomic = (params: {
  balanceAtomic: number;
  maxPositionUsd: number;
}): UsdcTradeSizingDecision => {
  const balanceAtomic = Math.max(0, Math.floor(params.balanceAtomic));
  const targetAtomic = balanceAtomic;
  const maxTradeAtomic = Math.max(0, Math.floor(params.maxPositionUsd * USDC_ATOMIC_PER_USD));
  const amountAtomic = Math.min(balanceAtomic, maxTradeAtomic);

  if (balanceAtomic < MIN_USDC_ENTRY_ATOMIC) {
    return {
      skip: true,
      reason: 'insufficient_usdc_inventory',
      balanceAtomic,
      reserveAtomic: 0,
      tradableAtomic: balanceAtomic,
      targetAtomic,
      minTradeAtomic: MIN_USDC_ENTRY_ATOMIC,
      maxTradeAtomic,
      amountAtomic: 0,
    };
  }

  if (amountAtomic < MIN_USDC_ENTRY_ATOMIC) {
    return {
      skip: true,
      reason: 'below_min_usdc_trade',
      balanceAtomic,
      reserveAtomic: 0,
      tradableAtomic: balanceAtomic,
      targetAtomic,
      minTradeAtomic: MIN_USDC_ENTRY_ATOMIC,
      maxTradeAtomic,
      amountAtomic,
    };
  }

  return {
    skip: false,
    reason: null,
    balanceAtomic,
    reserveAtomic: 0,
    tradableAtomic: balanceAtomic,
    targetAtomic,
    minTradeAtomic: MIN_USDC_ENTRY_ATOMIC,
    maxTradeAtomic,
    amountAtomic,
  };
};

const rlGetTokenAccount = async (
  address: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID,
) => {
  await heliusLimiter.acquire();
  return getAccount(getConnection(), address, 'confirmed', programId);
};

let usdcTokenAccountRentLamportsPromise: Promise<number> | null = null;

const getUsdcTokenAccountRentLamports = async (): Promise<number> => {
  if (!usdcTokenAccountRentLamportsPromise) {
    usdcTokenAccountRentLamportsPromise = (async () => {
      const mint = await rlGetMint(new PublicKey(USDC_MINT), TOKEN_PROGRAM_ID);
      return rlGetMinimumBalanceForRentExemption(getAccountLenForMint(mint));
    })();
  }

  return usdcTokenAccountRentLamportsPromise;
};

const hasTokenAccount = async (
  owner: PublicKey,
  mint: string,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<boolean> => {
  const ata = await getAssociatedTokenAddress(
    new PublicKey(mint),
    owner,
    false,
    programId,
  );

  try {
    await rlGetTokenAccount(ata, programId);
    return true;
  } catch {
    return false;
  }
};

const getTokenBalanceAtomic = async (
  owner: PublicKey,
  mint: string,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<number> => {
  const ata = await getAssociatedTokenAddress(
    new PublicKey(mint),
    owner,
    false,
    programId,
  );

  try {
    const account = await rlGetTokenAccount(ata, programId);
    return Number(account.amount);
  } catch {
    return 0;
  }
};

const buildTradeEconomics = (params: {
  tradeAmountAtomic: number;
  inputMint: string;
  outputMint: string;
  remainingRiskBudgetUsd: number;
  quote?: PrepareResponse['quote'];
  costs?: PrepareResponse['costs'];
}): PreparedTradeEconomics | null => {
  const quotedOutAmountAtomic = parseUnsignedNumeric(params.quote?.outAmount);
  const minimumOutputAtomic = parseUnsignedNumeric(params.quote?.otherAmountThreshold);

  if (
    quotedOutAmountAtomic === null
    || minimumOutputAtomic === null
    || params.tradeAmountAtomic <= 0
  ) {
    return null;
  }

  const estimatedNetworkCostLamports = params.costs?.estimatedNetworkCostLamports ?? 0;
  const estimatedNetworkCostOutputAtomic = params.outputMint === SOL_MINT
    ? estimatedNetworkCostLamports
    : Math.ceil((estimatedNetworkCostLamports * quotedOutAmountAtomic) / params.tradeAmountAtomic);
  const worstCaseSlippageOutputAtomic = Math.max(0, quotedOutAmountAtomic - minimumOutputAtomic);
  const tradeNotionalUsd = getUsdValueFromAtomicAmount(params.inputMint, params.tradeAmountAtomic);
  const estimatedNetworkCostUsd = getUsdValueFromAtomicAmount(SOL_MINT, estimatedNetworkCostLamports);
  const worstCaseSlippageUsd = getUsdValueFromAtomicAmount(params.outputMint, worstCaseSlippageOutputAtomic);
  const totalWorstCaseCostUsd = estimatedNetworkCostUsd + worstCaseSlippageUsd;
  const totalWorstCaseCostOutputAtomic =
    estimatedNetworkCostOutputAtomic + worstCaseSlippageOutputAtomic;
  const minimumOutputUsd = getUsdValueFromAtomicAmount(params.outputMint, minimumOutputAtomic);
  const economicallyViable = minimumOutputUsd > estimatedNetworkCostUsd;
  const withinRiskBudget = totalWorstCaseCostUsd <= params.remainingRiskBudgetUsd;

  let riskAdjustedAmountLamports: number | null = null;
  if (!withinRiskBudget && worstCaseSlippageUsd > 0 && params.inputMint === SOL_MINT) {
    const slippageBudgetUsd = params.remainingRiskBudgetUsd - estimatedNetworkCostUsd;
    if (slippageBudgetUsd > 0) {
      const scale = Math.max(0, Math.min(1, (slippageBudgetUsd / worstCaseSlippageUsd) * 0.95));
      const candidate = Math.floor(params.tradeAmountAtomic * scale);
      riskAdjustedAmountLamports = candidate > 0 ? candidate : null;
    }
  }

  return {
    remainingRiskBudgetUsd: params.remainingRiskBudgetUsd,
    tradeNotionalUsd,
    quotedOutAmountAtomic,
    minimumOutputAtomic,
    priceImpactPct: params.quote?.priceImpactPct ?? null,
    estimatedNetworkCostLamports,
    estimatedNetworkCostUsd,
    estimatedNetworkCostOutputAtomic,
    worstCaseSlippageUsd,
    worstCaseSlippageOutputAtomic,
    totalWorstCaseCostUsd,
    totalWorstCaseCostOutputAtomic,
    economicallyViable,
    withinRiskBudget,
    riskAdjustedAmountLamports,
  };
};

const computeCostBpsFromUsd = (costUsd: number, notionalUsd: number): number => {
  if (notionalUsd <= 0 || costUsd <= 0) {
    return 0;
  }

  return Math.round((costUsd / notionalUsd) * 10_000);
};

const getLatestObservedDriftBps = () => Math.abs(sharedMarketTape.solUsdDrift.at(-1)?.driftBps ?? 0);

const assessTradeGate = (params: {
  signalSnapshot: NonNullable<Session['serviceControl']['lastSignal']>;
  economics: PreparedTradeEconomics;
  confidenceBps: number;
  driftBps: number;
  safetyBufferBps: number;
}): TradeGateAssessment => {
  const signalMagnitudeBps = Math.abs(params.signalSnapshot.momentumBps ?? 0);
  const expectedEdgeBps = Math.max(0, signalMagnitudeBps - params.signalSnapshot.thresholdBps);
  const networkCostBps = computeCostBpsFromUsd(
    params.economics.estimatedNetworkCostUsd,
    params.economics.tradeNotionalUsd,
  );
  const slippageCostBps = computeCostBpsFromUsd(
    params.economics.worstCaseSlippageUsd,
    params.economics.tradeNotionalUsd,
  );
  const estimatedCostBps =
    networkCostBps +
    slippageCostBps +
    Math.abs(params.driftBps) +
    Math.abs(params.confidenceBps);

  return {
    allowed: expectedEdgeBps > (estimatedCostBps + params.safetyBufferBps),
    reason: expectedEdgeBps > (estimatedCostBps + params.safetyBufferBps)
      ? 'edge_exceeds_cost_model'
      : 'edge_below_cost_model',
    expectedEdgeBps,
    estimatedCostBps,
    safetyBufferBps: params.safetyBufferBps,
  };
};

const buildSizingTradeContext = (inventory: TradeInventoryContext): NonNullable<NonNullable<Session['serviceControl']['lastSizing']>['tradeContext']> => ({
  inputMint: inventory.inputMint,
  inputSymbol: inventory.inputSymbol,
  outputMint: inventory.outputMint,
  outputSymbol: inventory.outputSymbol,
  balanceAtomic: String(inventory.balanceAtomic),
  reserveAtomic: String(inventory.reserveAtomic),
  tradableAtomic: String(inventory.tradableAtomic),
  targetAtomic: String(inventory.targetAtomic),
  minTradeAtomic: String(inventory.minTradeAtomic),
  maxTradeAtomic: String(inventory.maxTradeAtomic),
  amountAtomic: inventory.amountAtomic !== null ? String(inventory.amountAtomic) : null,
  riskAdjustedAmountAtomic: inventory.riskAdjustedAmountAtomic !== null ? String(inventory.riskAdjustedAmountAtomic) : null,
});

const computeReturnBps = (referencePriceUsd: number | null, currentPriceUsd: number | null): number | null => {
  if (!referencePriceUsd || !currentPriceUsd || referencePriceUsd <= 0) {
    return null;
  }

  return Math.round(((currentPriceUsd - referencePriceUsd) / referencePriceUsd) * 10_000);
};

const refreshPositionMark = async (
  session: RawSession,
  positionState: NonNullable<Session['serviceControl']['positionState']>,
) => {
  const markedPriceUsd = lastPythSolSample?.usdPrice ?? null;
  if (!markedPriceUsd) {
    return positionState;
  }

  const markedAt = new Date().toISOString();
  const nextPositionState: NonNullable<Session['serviceControl']['positionState']> = {
    ...positionState,
    highWaterPriceUsd: positionState.status === 'long_sol'
      ? (positionState.highWaterPriceUsd === null
        ? markedPriceUsd
        : Math.max(positionState.highWaterPriceUsd, markedPriceUsd))
      : null,
    lastMarkedPriceUsd: markedPriceUsd,
    lastMarkedAt: markedAt,
  };

  if (
    nextPositionState.highWaterPriceUsd === positionState.highWaterPriceUsd
    && nextPositionState.lastMarkedPriceUsd === positionState.lastMarkedPriceUsd
  ) {
    return positionState;
  }

  await persistServiceControl(session, {
    positionState: nextPositionState,
  });

  // Compute and persist unrealized P&L
  if (
    positionState.status === 'long_sol'
    && positionState.entryPriceUsd !== null
    && positionState.quantityAtomic !== null
    && markedPriceUsd > 0
  ) {
    const qty = Number(positionState.quantityAtomic) / 1_000_000_000;
    const unrealizedPnlUsd = Number(((markedPriceUsd - positionState.entryPriceUsd) * qty).toFixed(6));
    if (unrealizedPnlUsd !== session.funding.unrealizedPnlUsd) {
      await mergeFundingPatch(session, { unrealizedPnlUsd });
    }
  }

  return nextPositionState;
};

const evaluateExitTrigger = (
  positionState: NonNullable<Session['serviceControl']['positionState']>,
  signalSnapshot: NonNullable<Session['serviceControl']['lastSignal']>,
): ExitTriggerDecision => {
  const markPriceUsd = positionState.lastMarkedPriceUsd ?? null;
  const pnlBps = computeReturnBps(positionState.entryPriceUsd, markPriceUsd);
  const trailingDrawdownBps = computeReturnBps(positionState.highWaterPriceUsd, markPriceUsd);

  if (pnlBps !== null && pnlBps >= positionExitPolicy.takeProfitBps) {
    return {
      shouldExit: true,
      reason: 'take_profit',
      markPriceUsd,
      pnlBps,
      trailingDrawdownBps,
    };
  }

  if (pnlBps !== null && pnlBps <= -positionExitPolicy.stopLossBps) {
    return {
      shouldExit: true,
      reason: 'stop_loss',
      markPriceUsd,
      pnlBps,
      trailingDrawdownBps,
    };
  }

  if (
    pnlBps !== null
    && pnlBps > 0
    && trailingDrawdownBps !== null
    && trailingDrawdownBps <= -positionExitPolicy.trailingStopBps
  ) {
    return {
      shouldExit: true,
      reason: 'trailing_stop',
      markPriceUsd,
      pnlBps,
      trailingDrawdownBps,
    };
  }

  if (signalSnapshot.regime === 'bearish') {
    return {
      shouldExit: true,
      reason: 'signal_reversal',
      markPriceUsd,
      pnlBps,
      trailingDrawdownBps,
    };
  }

  return {
    shouldExit: false,
    reason: 'signal_reversal',
    markPriceUsd,
    pnlBps,
    trailingDrawdownBps,
  };
};

const getSessionStrategyConfig = (session: RawSession) => {
  const configured = session.service_control.strategyConfig;

  const momentum = {
    lookbackSamples: configured?.momentum?.lookbackSamples ?? signalPolicy.momentumLookbackSamples,
    thresholdBps: configured?.momentum?.thresholdBps ?? signalPolicy.momentumThresholdBps,
    edgeSafetyBufferBps: configured?.momentum?.edgeSafetyBufferBps ?? signalPolicy.edgeSafetyBufferBps,
  };

  const meanReversion: BollingerConfig = {
    length: configured?.meanReversion?.length ?? DEFAULT_BOLLINGER_CONFIG.length,
    stdMultiplier: configured?.meanReversion?.stdMultiplier ?? DEFAULT_BOLLINGER_CONFIG.stdMultiplier,
    minBandWidthFraction: configured?.meanReversion?.minBandWidthFraction ?? DEFAULT_BOLLINGER_CONFIG.minBandWidthFraction,
    entryThreshold: configured?.meanReversion?.entryThreshold ?? DEFAULT_BOLLINGER_CONFIG.entryThreshold,
    exitThreshold: configured?.meanReversion?.exitThreshold ?? DEFAULT_BOLLINGER_CONFIG.exitThreshold,
  };

  const supertrend: SupertrendConfig = {
    candleSamples: configured?.supertrend?.candleSamples ?? DEFAULT_SUPERTREND_CONFIG.candleSamples,
    atrPeriod: configured?.supertrend?.atrPeriod ?? DEFAULT_SUPERTREND_CONFIG.atrPeriod,
    multiplier: configured?.supertrend?.multiplier ?? DEFAULT_SUPERTREND_CONFIG.multiplier,
  };

  return {
    autoRotationEnabled: configured?.autoRotationEnabled ?? true,
    momentum,
    meanReversion,
    supertrend,
  };
};

const executeTrade = async (session: RawSession): Promise<void> => {
  // Dedup guard: skip if there's an in-flight execution for this wallet.
  // Prevents double-submit if worker restarts between prepare and confirm.
  const dbPool = getPool();
  const inflightCheck = await dbPool.query<{ cnt: string }>(
    `SELECT count(*) AS cnt FROM swap_executions
     WHERE taker = $1 AND status IN ('prepared', 'submitted')`,
    [session.session_wallet],
  );
  const inflightCount = Number(inflightCheck.rows[0]?.cnt ?? 0);
  if (inflightCount > 0) {
    await persistTradeDecision(session, 'blocked', 'in_flight_execution');
    log('info', session.id, `skipping trade â€” ${inflightCount} in-flight execution(s) pending reconciliation`);
    return;
  }

  const keypair = await getKeypair(session.id);
  if (!keypair) {
    await persistTradeDecision(session, 'blocked', 'missing_session_keypair');
    log('warn', session.id, 'no keypair found â€” skipping trade');
    return;
  }

  let positionState = await refreshPositionMark(session, getPositionState(session));

  // Recovery guard: older funding flow could incorrectly mark a session as
  // long_sol before any submitted trade exists. Reset to flat so entry logic
  // can run normally.
  if (
    positionState.status === 'long_sol'
    && !session.service_control.schedulingState?.lastTradeSubmittedAt
  ) {
    const markedAt = new Date().toISOString();
    const markedPriceUsd = positionState.lastMarkedPriceUsd ?? lastPythSolSample?.usdPrice ?? null;

    const recoveredPositionState: NonNullable<Session['serviceControl']['positionState']> = {
      status: 'flat',
      entryPriceUsd: null,
      entryAt: null,
      quantityAtomic: null,
      highWaterPriceUsd: null,
      lastMarkedPriceUsd: markedPriceUsd,
      lastMarkedAt: markedAt,
      pendingExitReason: null,
      exitReason: null,
    };

    await persistServiceControl(session, {
      positionState: recoveredPositionState,
    });

    positionState = recoveredPositionState;
    log('warn', session.id, 'recovered inconsistent bootstrap position state (long_sol without submitted trade)');
  }

  if (positionState.status === 'long_sol' && positionState.exitReason !== null) {
    await persistServiceControl(session, {
      positionState: {
        exitReason: null,
      },
    });

    positionState = {
      ...positionState,
      exitReason: null,
    };
  }

  const strategyConfig = getSessionStrategyConfig(session);

  // Resolve which strategy this session should use (respect enabled flags)
  const strategyUniverse = session.service_control.strategyUniverse ?? [];
  const enabledStrategies = strategyUniverse
    .filter((strategy) => strategy.enabled)
    .map((strategy) => strategy.key);

  const configuredActiveStrategy = session.service_control.rotationState?.activeStrategy ?? 'momentum';
  const fallbackStrategy = enabledStrategies[0] ?? 'momentum';
  const activeStrategy = enabledStrategies.includes(configuredActiveStrategy)
    ? configuredActiveStrategy
    : fallbackStrategy;

  if (activeStrategy !== configuredActiveStrategy) {
    await persistServiceControl(session, {
      rotationState: {
        activeStrategy,
        queuedStrategy: activeStrategy,
      },
    } as any);
    log('info', session.id, `strategy override: ${configuredActiveStrategy} disabled → ${activeStrategy}`);
  }

  const pythTape: PriceSample[] = sharedMarketTape.solUsdPyth.map(p => ({
    usdPrice: p.usdPrice,
    sampledAt: p.sampledAt,
  }));

  // Compute signal based on active strategy
  let effectiveSignal: NonNullable<Session['serviceControl']['lastSignal']> | null = null;

  if (activeStrategy === 'mean_reversion') {
    const bbSignal = computeBollingerSignal(pythTape, strategyConfig.meanReversion);
    effectiveSignal = {
      at: new Date().toISOString(),
      source: 'pyth-hermes',
      signal: 'momentum', // schema field name, reused for all strategies
      status: bbSignal.status,
      regime: bbSignal.regime,
      lookbackSamples: strategyConfig.momentum.lookbackSamples,
      thresholdBps: strategyConfig.momentum.thresholdBps,
      momentumBps: bbSignal.momentumBps,
      guardReason: bbSignal.guardReason,
    };
    logSignalEvent({ ...bbSignal.meta, strategy: 'mean_reversion', regime: bbSignal.regime, status: bbSignal.status });
  } else if (activeStrategy === 'supertrend') {
    const stSignal = computeSupertrendSignal(pythTape, strategyConfig.supertrend);
    effectiveSignal = {
      at: new Date().toISOString(),
      source: 'pyth-hermes',
      signal: 'momentum',
      status: stSignal.status,
      regime: stSignal.regime,
      lookbackSamples: strategyConfig.momentum.lookbackSamples,
      thresholdBps: strategyConfig.momentum.thresholdBps,
      momentumBps: stSignal.momentumBps,
      guardReason: stSignal.guardReason,
    };
    logSignalEvent({ ...stSignal.meta, strategy: 'supertrend', regime: stSignal.regime, status: stSignal.status });
  } else {
    // Session-configured momentum signal
    if (!lastPythSolSample) {
      effectiveSignal = {
        at: new Date().toISOString(),
        source: 'pyth-hermes',
        signal: 'momentum',
        status: 'warming_up',
        regime: null,
        lookbackSamples: strategyConfig.momentum.lookbackSamples,
        thresholdBps: strategyConfig.momentum.thresholdBps,
        momentumBps: null,
        guardReason: null,
      };
    } else {
      const guardReason = getPythGuardReason(lastPythSolSample);
      const momentumBps = computeMomentumBps(
        sharedMarketTape.solUsdPyth,
        strategyConfig.momentum.lookbackSamples,
      );

      effectiveSignal = {
        at: new Date().toISOString(),
        source: 'pyth-hermes',
        signal: 'momentum',
        status: guardReason
          ? 'guarded_off'
          : momentumBps === null
            ? 'warming_up'
            : 'ready',
        regime: guardReason || momentumBps === null
          ? null
          : classifyMomentum(momentumBps, strategyConfig.momentum.thresholdBps),
        lookbackSamples: strategyConfig.momentum.lookbackSamples,
        thresholdBps: strategyConfig.momentum.thresholdBps,
        momentumBps,
        guardReason,
      };
    }
  }

  // Auto-rotate strategy based on market regime (if rotation is enabled)
  const recommendation = recommendStrategy(pythTape, strategyConfig.meanReversion);
  const recommendedStrategy = enabledStrategies.includes(recommendation.recommended)
    ? recommendation.recommended
    : activeStrategy;
  const shouldRotate = recommendedStrategy !== activeStrategy
    && pythTape.length >= (strategyConfig.meanReversion.length + 1); // only rotate once we have enough data
  if (strategyConfig.autoRotationEnabled && shouldRotate) {
    const rotationState = session.service_control.rotationState;
    const lockedUntil = rotationState?.lockedUntil ? new Date(rotationState.lockedUntil).getTime() : 0;
    if (Date.now() > lockedUntil) {
      const rotationIntervalMs = (rotationState?.rotationIntervalMinutes ?? 60) * 60_000;
      const lastRotatedAt = rotationState?.lastRotatedAt ? new Date(rotationState.lastRotatedAt).getTime() : 0;
      if (Date.now() - lastRotatedAt > rotationIntervalMs || lastRotatedAt === 0) {
        await persistServiceControl(session, {
          rotationState: {
            activeStrategy: recommendedStrategy,
            queuedStrategy: recommendedStrategy,
            rotationIntervalMinutes: rotationState?.rotationIntervalMinutes ?? 60,
            lastRotatedAt: new Date().toISOString(),
            lockedUntil: new Date(Date.now() + 60_000).toISOString(), // lock for 1 min to prevent thrashing
          },
        } as any);
        log('info', session.id, `strategy rotation: ${activeStrategy} â†’ ${recommendedStrategy} (${recommendation.reason})`);
      }
    }
  }

  if (!effectiveSignal) {
    await persistTradeDecision(session, 'blocked', 'signal_not_ready');
    await persistLastTradeGate(session, {
      at: new Date().toISOString(),
      decision: 'blocked',
      reason: 'signal_not_ready',
      expectedEdgeBps: null,
      estimatedCostBps: null,
      safetyBufferBps: null,
    });
    log('info', session.id, `strategy skip: ${activeStrategy} produced no signal`);
    return;
  }

  await persistLastSignal(session, effectiveSignal);

  if (effectiveSignal.status !== 'ready') {
    await persistTradeDecision(session, 'blocked', `signal_${effectiveSignal.status}`);
    await persistLastTradeGate(session, {
      at: new Date().toISOString(),
      decision: 'blocked',
      reason: 'signal_not_ready',
      expectedEdgeBps: effectiveSignal.momentumBps ?? null,
      estimatedCostBps: null,
      safetyBufferBps: null,
    });
    log('info', session.id, `strategy skip: ${activeStrategy} signal not ready (${effectiveSignal.status})`);
    return;
  }

  const lastTradeSubmittedMs = getLastTradeSubmittedMs(session);
  const msSinceLastSubmit = lastTradeSubmittedMs > 0 ? (Date.now() - lastTradeSubmittedMs) : Number.POSITIVE_INFINITY;
  if (msSinceLastSubmit < POST_SUBMIT_RECONCILE_GRACE_MS) {
    await persistTradeDecision(session, 'blocked', 'post_submit_reconcile_grace');
    log(
      'info',
      session.id,
      `waiting for execution reconcile: ${msSinceLastSubmit}ms/${POST_SUBMIT_RECONCILE_GRACE_MS}ms since submit`,
    );
    return;
  }

  // Verify keypair matches session wallet
  if (keypair.publicKey.toBase58() !== session.session_wallet) {
    await persistTradeDecision(session, 'error', 'session_keypair_mismatch');
    log('warn', session.id, `keypair mismatch: stored=${keypair.publicKey.toBase58()} session=${session.session_wallet}`);
    return;
  }

  // Check session wallet balance
  let balance: number;
  try {
    balance = await rlGetBalance(keypair.publicKey);
  } catch {
    await persistTradeDecision(session, 'error', 'balance_check_failed');
    log('warn', session.id, 'balance check failed before trade');
    return;
  }

  try {
    await mergeFundingPatch(session, {
      currentBalanceAtomic: String(balance),
    });
  } catch (err) {
    log('warn', session.id, `failed to persist live balance snapshot: ${String(err)}`);
  }

  const minimumRequiredLamports = positionState.status === 'flat'
    ? MIN_SOL_OPERATING_RESERVE_LAMPORTS
    : MIN_TRADEABLE_LAMPORTS;

  if (balance < minimumRequiredLamports) {
    await persistTradeDecision(session, 'stopped', 'insufficient_balance');
    log('warn', session.id, `insufficient balance for trade: ${balance}/${minimumRequiredLamports} lamports`);
    await setSessionStatus(session.id, 'stopping', { stop_reason: 'depleted' }, { expectedStatuses: ['active'] });
    log('info', session.id, 'balance depleted â†’ stopping (sweep will run)');
    return;
  }

  // Risk check: session loss limit
  const { realizedPnlUsd, capturedFeesUsd } = session.funding;
  const sessionLoss = Math.abs(Math.min(0, realizedPnlUsd));
  if (sessionLoss >= session.risk_limits.maxSessionLossUsd) {
    await persistTradeDecision(session, 'stopped', 'risk_limit_hit');
    await setSessionStatus(session.id, 'stopping', { stop_reason: 'risk_limit_hit' }, { expectedStatuses: ['active'] });
    log('info', session.id, `risk limit hit (loss $${sessionLoss.toFixed(2)}) â†’ stopping (sweep will run)`);
    return;
  }

  let tradePlan: TradeExecutionPlan | null = null;
  let useBasicPairEntryFallback = false;
  let basicPairEntryFallbackReason: string | null = null;

  if (positionState.status === 'long_sol') {
    const exitTrigger = evaluateExitTrigger(positionState, effectiveSignal);

    if (!exitTrigger.shouldExit) {
      await persistTradeDecision(session, 'blocked', 'no_exit_trigger');
      if (positionState.pendingExitReason !== null) {
        await persistServiceControl(session, {
          positionState: {
            pendingExitReason: null,
          },
        });
      }

      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'no_exit_trigger',
        expectedEdgeBps: exitTrigger.pnlBps,
        estimatedCostBps: null,
        safetyBufferBps: null,
      });
      log('info', session.id, `strategy skip: no exit trigger (mark=${exitTrigger.markPriceUsd} pnlBps=${exitTrigger.pnlBps} trail=${exitTrigger.trailingDrawdownBps} regime=${effectiveSignal.regime})`);
      return;
    }

    const nextPositionState: NonNullable<Session['serviceControl']['positionState']> = {
      ...positionState,
      pendingExitReason: exitTrigger.reason,
    };

    if (nextPositionState.pendingExitReason !== positionState.pendingExitReason) {
      await persistServiceControl(session, {
        positionState: nextPositionState,
      });
    }

    const sizing = computeTradeAmountLamports({
      balanceLamports: balance,
      thresholds: fundingThresholds,
      policy: sizingPolicy,
    });
    const outputUsdcAtaExists = await hasTokenAccount(keypair.publicKey, USDC_MINT);
    const outputUsdcAtaRentLamports = outputUsdcAtaExists ? 0 : await getUsdcTokenAccountRentLamports();
    const exitReserveLamports = sizing.reserveLamports + outputUsdcAtaRentLamports;
    const exitTradableLamports = Math.max(0, sizing.balanceLamports - exitReserveLamports);
    const exitAmountLamports = computeFullExitAmountAtomic({
      walletBalanceAtomic: sizing.balanceLamports,
      reserveAtomic: exitReserveLamports,
      positionQuantityAtomic: positionState.quantityAtomic,
    });

    const sellInventory: TradeInventoryContext = {
      inputMint: SOL_MINT,
      inputSymbol: 'SOL',
      outputMint: USDC_MINT,
      outputSymbol: 'USDC',
      balanceAtomic: sizing.balanceLamports,
      reserveAtomic: exitReserveLamports,
      tradableAtomic: exitTradableLamports,
      targetAtomic: exitAmountLamports,
      minTradeAtomic: exitAmountLamports,
      maxTradeAtomic: exitAmountLamports,
      amountAtomic: exitAmountLamports > 0 ? exitAmountLamports : null,
      riskAdjustedAmountAtomic: null,
    };

    if (sizing.skip || exitAmountLamports <= 0) {
      try {
        await persistLastSizing(session, {
          at: new Date().toISOString(),
          decision: 'skipped',
          reason: sizing.skip ? sizing.reason : 'no_exit_inventory',
          balanceLamports: String(sizing.balanceLamports),
          reserveLamports: String(sizing.reserveLamports),
          tradableLamports: String(sizing.tradableLamports),
          fractionBps: 10000,
          targetLamports: String(exitAmountLamports),
          minTradeLamports: String(exitAmountLamports),
          maxTradeLamports: String(exitAmountLamports),
          amountLamports: null,
          remainingRiskBudgetUsd: null,
          quotedOutAmountAtomic: null,
          minimumOutputAtomic: null,
          priceImpactPct: null,
          estimatedNetworkCostLamports: null,
          estimatedNetworkCostOutputAtomic: null,
          worstCaseSlippageOutputAtomic: null,
          totalWorstCaseCostOutputAtomic: null,
          riskAdjustedAmountLamports: null,
          tradeContext: buildSizingTradeContext(sellInventory),
        });
      } catch (err) {
        log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
      }

      log(
        'info',
        session.id,
        `sizing skip (${sizing.skip ? sizing.reason : 'no_exit_inventory'}): balance=${sizing.balanceLamports} reserve=${sizing.reserveLamports} tradable=${sizing.tradableLamports} exitAmount=${exitAmountLamports}`,
      );
      return;
    }

    tradePlan = {
      direction: 'exit_long_sol',
      inventory: sellInventory,
      exitReason: exitTrigger.reason,
    };
  } else {
    const universeEngineAgeMs = lastTokenUniverseEngineAppliedAt > 0
      ? (Date.now() - lastTokenUniverseEngineAppliedAt)
      : Number.POSITIVE_INFINITY;
    const universeEngineFresh = universeEngineAgeMs <= TOKEN_UNIVERSE_ENGINE_MAX_STALE_MS;
    const universeEngineEmpty = lastTokenUniverseEngineEnabledCount <= 0;
    basicPairEntryFallbackReason = !universeEngineFresh
      ? 'universe_engine_stale'
      : tokenUniverseProbeFrozen
        ? 'probe_health_frozen'
        : universeEngineEmpty
          ? 'universe_engine_empty'
          : null;
    useBasicPairEntryFallback = basicPairEntryFallbackReason !== null;

    if (useBasicPairEntryFallback) {
      log(
        'info',
        session.id,
        `entry fallback active: basic_pairs_only (${basicPairEntryFallbackReason}) ageMs=${Number.isFinite(universeEngineAgeMs) ? universeEngineAgeMs : -1} enabledCount=${lastTokenUniverseEngineEnabledCount} probeFrozen=${tokenUniverseProbeFrozen}`,
      );
    }

    if (effectiveSignal.regime !== 'bullish') {
      await persistTradeDecision(session, 'blocked', 'no_bullish_entry_signal');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'no_bullish_entry_signal',
        expectedEdgeBps: effectiveSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: null,
      });
      log('info', session.id, `strategy skip: regime=${effectiveSignal.regime} momentum=${effectiveSignal.momentumBps}`);
      return;
    }

    const persistentBullishRegime = hasMomentumRegimePersistence({
      samples: sharedMarketTape.solUsdPyth,
      lookbackSamples: strategyConfig.momentum.lookbackSamples,
      thresholdBps: strategyConfig.momentum.thresholdBps,
      regime: 'bullish',
      requiredSamples: MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES,
    });
    if (!persistentBullishRegime) {
      await persistTradeDecision(session, 'blocked', 'regime_not_persistent');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'regime_not_persistent',
        expectedEdgeBps: effectiveSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log(
        'info',
        session.id,
        `entry blocked: bullish regime not persistent (${MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES} samples required)`,
      );
      return;
    }

    if (balance < MIN_SOL_OPERATING_RESERVE_LAMPORTS) {
      await persistTradeDecision(session, 'blocked', 'insufficient_sol_fee_reserve');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'insufficient_sol_fee_reserve',
        expectedEdgeBps: effectiveSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: null,
      });
      log('info', session.id, `inventory skip: flat session has only ${balance} lamports, below fee reserve ${MIN_SOL_OPERATING_RESERVE_LAMPORTS}`);
      return;
    }

    const usdcBalanceAtomic = await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT);
    const usdcSizing = computeUsdcTradeAmountAtomic({
      balanceAtomic: usdcBalanceAtomic,
        maxPositionUsd: getLiveSpeedProfile().maxSolEntryUsd,
    });

    const entryInventory: TradeInventoryContext = {
      inputMint: USDC_MINT,
      inputSymbol: 'USDC',
      outputMint: SOL_MINT,
      outputSymbol: 'SOL',
      balanceAtomic: usdcSizing.balanceAtomic,
      reserveAtomic: usdcSizing.reserveAtomic,
      tradableAtomic: usdcSizing.tradableAtomic,
      targetAtomic: usdcSizing.targetAtomic,
      minTradeAtomic: usdcSizing.minTradeAtomic,
      maxTradeAtomic: usdcSizing.maxTradeAtomic,
      amountAtomic: usdcSizing.skip ? null : usdcSizing.amountAtomic,
      riskAdjustedAmountAtomic: null,
    };

    if (usdcSizing.skip) {
      await persistTradeDecision(session, 'blocked', usdcSizing.reason ?? 'entry_inventory_blocked');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: usdcSizing.reason ?? 'entry_inventory_blocked',
        expectedEdgeBps: effectiveSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: null,
      });
      try {
        await persistLastSizing(session, {
          at: new Date().toISOString(),
          decision: 'skipped',
          reason: usdcSizing.reason,
          balanceLamports: String(balance),
          reserveLamports: String(MIN_SOL_OPERATING_RESERVE_LAMPORTS),
          tradableLamports: String(Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS)),
          fractionBps: 10000,
          targetLamports: '0',
          minTradeLamports: '0',
          maxTradeLamports: '0',
          amountLamports: null,
          remainingRiskBudgetUsd: null,
          quotedOutAmountAtomic: null,
          minimumOutputAtomic: null,
          priceImpactPct: null,
          estimatedNetworkCostLamports: null,
          estimatedNetworkCostOutputAtomic: null,
          worstCaseSlippageOutputAtomic: null,
          totalWorstCaseCostOutputAtomic: null,
          riskAdjustedAmountLamports: null,
          tradeContext: buildSizingTradeContext(entryInventory),
        });
      } catch (err) {
        log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
      }
      log('info', session.id, `entry sizing skip (${usdcSizing.reason}): usdcBalance=${usdcSizing.balanceAtomic} target=${usdcSizing.targetAtomic} min=${usdcSizing.minTradeAtomic}`);
      return;
    }

    if (WORKER_UNIVERSE_SCOUT_ENABLED && !useBasicPairEntryFallback) {
      const scout = await scoutEntryUniverse({
        amountAtomic: usdcSizing.amountAtomic,
        takerWallet: session.session_wallet,
        slippageBps: session.risk_limits.maxSlippageBps,
      });

      if (scout.solRank === null) {
        await persistTradeDecision(session, 'blocked', 'universe_scout_no_sol_route');
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: 'universe_scout_no_sol_route',
          expectedEdgeBps: effectiveSignal.momentumBps,
          estimatedCostBps: null,
          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
        });
        log(
          'info',
          session.id,
          `universe scout blocked entry: no SOL route (candidates=${scout.candidates.length} best=${scout.bestMint})`,
        );
        return;
      }

      if (
        scout.solPriceImpactBps !== null
        && scout.solPriceImpactBps > WORKER_UNIVERSE_SCOUT_MAX_SOL_PRICE_IMPACT_BPS
      ) {
        await persistTradeDecision(session, 'blocked', 'universe_scout_sol_impact_too_high');
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: 'universe_scout_sol_impact_too_high',
          expectedEdgeBps: effectiveSignal.momentumBps,
          estimatedCostBps: scout.solPriceImpactBps,
          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
        });
        log(
          'info',
          session.id,
          `universe scout blocked entry: SOL impact=${scout.solPriceImpactBps}bps max=${WORKER_UNIVERSE_SCOUT_MAX_SOL_PRICE_IMPACT_BPS}bps rank=${scout.solRank} best=${scout.bestMint}`,
        );
        return;
      }

      if (scout.solRank > Math.max(1, WORKER_UNIVERSE_SCOUT_MIN_SOL_RANK)) {
        await persistTradeDecision(session, 'blocked', 'universe_scout_sol_rank_too_low');
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: 'universe_scout_sol_rank_too_low',
          expectedEdgeBps: effectiveSignal.momentumBps,
          estimatedCostBps: scout.solPriceImpactBps,
          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
        });
        log(
          'info',
          session.id,
          `universe scout blocked entry: SOL rank=${scout.solRank} minRequiredTop=${WORKER_UNIVERSE_SCOUT_MIN_SOL_RANK} best=${scout.bestMint} impact=${scout.solPriceImpactBps}`,
        );
        return;
      }
    }

    tradePlan = {
      direction: 'enter_long_sol',
      inventory: entryInventory,
      exitReason: null,
    };
  }

  if (!tradePlan) {
    return;
  }

  const remainingRiskBudgetUsd = Math.max(0, session.risk_limits.maxSessionLossUsd - sessionLoss);
  const baseTradeAmount = tradePlan.inventory.amountAtomic ?? 0;
  let tradeAmount = baseTradeAmount;
  let prepare: { ok: boolean; status: number; data: PrepareResponse } | null = null;
  let economics: PreparedTradeEconomics | null = null;
  let tradeGate: TradeGateAssessment | null = null;
  let sizingReason: string | null = null;
  let observedPriceImpactBps: number | null = null;
  const forceExitExecution = shouldForceExitExecution(tradePlan.direction, tradePlan.exitReason);

  for (let attempt = 1; attempt <= 2; attempt++) {
    log(
      'info',
      session.id,
      `preparing swap: ${tradeAmount} ${tradePlan.inventory.inputSymbol} atomic ${tradePlan.inventory.inputSymbol} â†’ ${tradePlan.inventory.outputSymbol} (tradable=${tradePlan.inventory.tradableAtomic} fraction=${tradePlan.direction === 'enter_long_sol' ? 10000 : sizingPolicy.tradeFractionBps}bps attempt=${attempt})`,
    );

    prepare = await apiPost<PrepareResponse>('/jupiter/swap/prepare', {
      inputMint:      tradePlan.inventory.inputMint,
      outputMint:     tradePlan.inventory.outputMint,
      amount:         String(tradeAmount),
      taker:          session.session_wallet,
      feeTokenSymbol: 'USDC',
      slippageBps:    String(session.risk_limits.maxSlippageBps),
    }, { limiter: jupiterLimiter });

    if (!prepare.ok || !prepare.data.preparedTransactionBase64 || !prepare.data.executionId) {
      break;
    }

    if (prepare.data.simulation?.err) {
      break;
    }

    if (tradePlan.direction === 'exit_long_sol') {
      const setupReserveLamports = Math.max(
        0,
        tradePlan.inventory.reserveAtomic - MIN_SOL_OPERATING_RESERVE_LAMPORTS,
      );
      const estimatedNetworkCostLamports = prepare.data.costs?.estimatedNetworkCostLamports ?? 0;
      const expectedPostExitLamports =
        balance - tradeAmount - setupReserveLamports - estimatedNetworkCostLamports;
      const reserveShortfallLamports = Math.max(
        0,
        MIN_SOL_OPERATING_RESERVE_LAMPORTS - expectedPostExitLamports,
      );

      if (reserveShortfallLamports > 0) {
        const adjustedAmount = tradeAmount - reserveShortfallLamports;

        if (adjustedAmount < sizingPolicy.minTradeLamports || adjustedAmount <= 0) {
          sizingReason = 'post_exit_reserve_shortfall';
          break;
        }

        tradeAmount = adjustedAmount;
        tradePlan.inventory.amountAtomic = adjustedAmount;
        tradePlan.inventory.riskAdjustedAmountAtomic = adjustedAmount;
        sizingReason = 'post_exit_reserve_shortfall';
        continue;
      }
    }

    economics = buildTradeEconomics({
      tradeAmountAtomic: tradeAmount,
      inputMint: tradePlan.inventory.inputMint,
      outputMint: tradePlan.inventory.outputMint,
      remainingRiskBudgetUsd,
      quote: prepare.data.quote,
      costs: prepare.data.costs,
    });

    if (!economics) {
      break;
    }

    observedPriceImpactBps = parseQuotePriceImpactBps(economics.priceImpactPct);
    if (
      !forceExitExecution
      && observedPriceImpactBps !== null
      && observedPriceImpactBps > MAX_QUOTE_PRICE_IMPACT_BPS
    ) {
      sizingReason = 'price_impact_too_high';
      break;
    }

    tradeGate = resolveTradeGateAssessment({
      direction: tradePlan.direction,
      exitReason: tradePlan.exitReason,
      assessment: assessTradeGate({
      signalSnapshot: effectiveSignal,
      economics,
      confidenceBps: lastPythSolSample?.confidenceBps ?? signalPolicy.maxPythConfidenceBps,
      driftBps: getLatestObservedDriftBps(),
      safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      }),
    });

    if (!tradeGate.allowed) {
      sizingReason = tradeGate.reason;
      break;
    }

    if (!forceExitExecution && !economics.economicallyViable) {
      sizingReason = 'not_economically_viable';
      break;
    }

    if (forceExitExecution || economics.withinRiskBudget) {
      if (tradeAmount !== baseTradeAmount) {
        sizingReason = 'risk_budget_capped';
      }
      break;
    }

    const adjustedAmount = economics.riskAdjustedAmountLamports;
    if (
      !adjustedAmount
      || adjustedAmount < sizingPolicy.minTradeLamports
      || adjustedAmount >= tradeAmount
    ) {
      sizingReason = 'risk_budget_exhausted';
      break;
    }

    tradeAmount = Math.min(sizingPolicy.maxTradeLamports, adjustedAmount);
    tradePlan.inventory.amountAtomic = tradeAmount;
    tradePlan.inventory.riskAdjustedAmountAtomic = tradeAmount;
    sizingReason = 'risk_budget_capped';
  }

  if (!forceExitExecution && economics && (!economics.economicallyViable || !economics.withinRiskBudget)) {
    await persistTradeDecision(session, 'blocked', sizingReason ?? 'economics_blocked');
    await persistLastTradeGate(session, {
      at: new Date().toISOString(),
      decision: 'blocked',
      reason: sizingReason ?? 'economics_blocked',
      expectedEdgeBps: tradeGate?.expectedEdgeBps ?? effectiveSignal.momentumBps ?? null,
      estimatedCostBps: tradeGate?.estimatedCostBps ?? null,
      safetyBufferBps: tradeGate?.safetyBufferBps ?? strategyConfig.momentum.edgeSafetyBufferBps,
    });
    try {
      await persistLastSizing(session, {
        at: new Date().toISOString(),
        decision: 'skipped',
        reason: sizingReason,
        balanceLamports: String(balance),
        reserveLamports: String(positionState.status === 'flat' ? MIN_SOL_OPERATING_RESERVE_LAMPORTS : tradePlan.inventory.reserveAtomic),
        tradableLamports: String(positionState.status === 'flat' ? Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS) : tradePlan.inventory.tradableAtomic),
        fractionBps: tradePlan.direction === 'enter_long_sol' || tradePlan.direction === 'exit_long_sol' ? 10000 : sizingPolicy.tradeFractionBps,
        targetLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.targetAtomic),
        minTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.minTradeAtomic),
        maxTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.maxTradeAtomic),
        amountLamports: null,
        remainingRiskBudgetUsd: economics.remainingRiskBudgetUsd,
        quotedOutAmountAtomic: String(economics.quotedOutAmountAtomic),
        minimumOutputAtomic: String(economics.minimumOutputAtomic),
        priceImpactPct: economics.priceImpactPct,
        estimatedNetworkCostLamports: String(economics.estimatedNetworkCostLamports),
        estimatedNetworkCostOutputAtomic: String(economics.estimatedNetworkCostOutputAtomic),
        worstCaseSlippageOutputAtomic: String(economics.worstCaseSlippageOutputAtomic),
        totalWorstCaseCostOutputAtomic: String(economics.totalWorstCaseCostOutputAtomic),
        riskAdjustedAmountLamports: economics.riskAdjustedAmountLamports !== null
          ? String(economics.riskAdjustedAmountLamports)
          : null,
        tradeContext: buildSizingTradeContext(tradePlan.inventory),
      });
    } catch (err) {
      log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
    }

    log(
      'info',
      session.id,
      `sizing skip (${sizingReason}): amount=${tradeAmount} out=${economics.quotedOutAmountAtomic} minOut=${economics.minimumOutputAtomic} networkLamports=${economics.estimatedNetworkCostLamports} worstCaseAtomic=${economics.totalWorstCaseCostOutputAtomic} remainingRiskUsd=${economics.remainingRiskBudgetUsd.toFixed(4)}`,
    );
    if (prepare?.data?.executionId) {
      try {
        await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
          stage: 'worker_cancel',
          reason: sizingReason ?? 'economics_blocked',
        });
      } catch (err) {
        log('warn', session.id, `cancel prepared execution failed: ${String(err)}`);
      }
    }
    return;
  }

  if (tradeGate && !tradeGate.allowed) {
    await persistTradeDecision(session, 'blocked', tradeGate.reason);
    await persistLastTradeGate(session, {
      at: new Date().toISOString(),
      decision: 'blocked',
      reason: tradeGate.reason,
      expectedEdgeBps: tradeGate.expectedEdgeBps,
      estimatedCostBps: tradeGate.estimatedCostBps,
      safetyBufferBps: tradeGate.safetyBufferBps,
    });
    try {
      await persistLastSizing(session, {
        at: new Date().toISOString(),
        decision: 'skipped',
        reason: tradeGate.reason,
        balanceLamports: String(balance),
        reserveLamports: String(positionState.status === 'flat' ? MIN_SOL_OPERATING_RESERVE_LAMPORTS : tradePlan.inventory.reserveAtomic),
        tradableLamports: String(positionState.status === 'flat' ? Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS) : tradePlan.inventory.tradableAtomic),
        fractionBps: tradePlan.direction === 'enter_long_sol' || tradePlan.direction === 'exit_long_sol' ? 10000 : sizingPolicy.tradeFractionBps,
        targetLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.targetAtomic),
        minTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.minTradeAtomic),
        maxTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.maxTradeAtomic),
        amountLamports: null,
        remainingRiskBudgetUsd: economics?.remainingRiskBudgetUsd ?? remainingRiskBudgetUsd,
        quotedOutAmountAtomic: economics ? String(economics.quotedOutAmountAtomic) : null,
        minimumOutputAtomic: economics ? String(economics.minimumOutputAtomic) : null,
        priceImpactPct: economics?.priceImpactPct ?? null,
        estimatedNetworkCostLamports: economics ? String(economics.estimatedNetworkCostLamports) : null,
        estimatedNetworkCostOutputAtomic: economics ? String(economics.estimatedNetworkCostOutputAtomic) : null,
        worstCaseSlippageOutputAtomic: economics ? String(economics.worstCaseSlippageOutputAtomic) : null,
        totalWorstCaseCostOutputAtomic: economics ? String(economics.totalWorstCaseCostOutputAtomic) : null,
        riskAdjustedAmountLamports: null,
        tradeContext: buildSizingTradeContext(tradePlan.inventory),
      });
    } catch (err) {
      log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
    }
    log(
      'info',
      session.id,
      `trade gate blocked (${tradeGate.reason}): expectedEdgeBps=${tradeGate.expectedEdgeBps} estimatedCostBps=${tradeGate.estimatedCostBps} safetyBufferBps=${tradeGate.safetyBufferBps}`,
    );
    if (prepare?.data?.executionId) {
      try {
        await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
          stage: 'worker_cancel',
          reason: tradeGate.reason,
        });
      } catch (err) {
        log('warn', session.id, `cancel prepared execution failed: ${String(err)}`);
      }
    }
    return;
  }

  if (sizingReason === 'price_impact_too_high') {
    await persistTradeDecision(session, 'blocked', sizingReason);
    await persistLastTradeGate(session, {
      at: new Date().toISOString(),
      decision: 'blocked',
      reason: sizingReason,
      expectedEdgeBps: tradeGate?.expectedEdgeBps ?? effectiveSignal.momentumBps ?? null,
      estimatedCostBps: tradeGate?.estimatedCostBps ?? null,
      safetyBufferBps: tradeGate?.safetyBufferBps ?? strategyConfig.momentum.edgeSafetyBufferBps,
    });

    log(
      'info',
      session.id,
      `trade gate blocked (${sizingReason}): quoteImpactBps=${observedPriceImpactBps} maxAllowedBps=${MAX_QUOTE_PRICE_IMPACT_BPS}`,
    );

    if (prepare?.data?.executionId) {
      try {
        await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
          stage: 'worker_cancel',
          reason: sizingReason,
        });
      } catch (err) {
        log('warn', session.id, `cancel prepared execution failed: ${String(err)}`);
      }
    }
    return;
  }

  if (!prepare) {
    throw new Error('trade preparation did not run');
  }

  if (!prepare.ok || !prepare.data.preparedTransactionBase64 || !prepare.data.executionId) {
    await persistTradeDecision(session, 'blocked', 'prepare_failed');
    log('warn', session.id, `prepare failed (${prepare.status}): ${prepare.data.error ?? JSON.stringify(prepare.data)}`);
    if (prepare.data.shortfall) {
      await setSessionStatus(session.id, 'stopping', { stop_reason: 'depleted' }, { expectedStatuses: ['active'] });
      log(
        'info',
        session.id,
        `route setup shortfall: have ${prepare.data.shortfall.availableLamports}, need ${prepare.data.shortfall.requiredLamports} (gap ${prepare.data.shortfall.gapLamports}) â†’ stopping (sweep will run)`,
      );
      return;
    }
    const freshBal = await rlGetBalance(keypair.publicKey).catch(() => 0);
    if (freshBal < minimumRequiredLamports) {
      await setSessionStatus(session.id, 'stopping', { stop_reason: 'depleted' }, { expectedStatuses: ['active'] });
      log('info', session.id, `balance ${freshBal} lamports after prepare failure â†’ stopping (sweep will run)`);
    } else {
      const fails = (consecutiveSimFailures.get(session.id) ?? 0) + 1;
      consecutiveSimFailures.set(session.id, fails);
      if (fails >= 3) {
        await setSessionStatus(session.id, 'stopping', { stop_reason: 'repeated_simulation_failures' }, { expectedStatuses: ['active'] });
        log('warn', session.id, `${fails} consecutive prepare failures â†’ stopping`);
      }
    }
    return;
  }

  if (prepare.data.simulation?.err) {
    await persistTradeDecision(session, 'blocked', 'simulation_error');
    log('warn', session.id, `simulation error: ${JSON.stringify(prepare.data.simulation.err)}`);
    if (prepare.data.shortfall) {
      await setSessionStatus(session.id, 'stopping', { stop_reason: 'depleted' }, { expectedStatuses: ['active'] });
      log(
        'info',
        session.id,
        `simulation exposed route shortfall: have ${prepare.data.shortfall.availableLamports}, need ${prepare.data.shortfall.requiredLamports} (gap ${prepare.data.shortfall.gapLamports}) â†’ stopping (sweep will run)` ,
      );
      return;
    }
    const freshBal = await rlGetBalance(keypair.publicKey).catch(() => 0);
    if (freshBal < minimumRequiredLamports) {
      await setSessionStatus(session.id, 'stopping', { stop_reason: 'depleted' }, { expectedStatuses: ['active'] });
      log('info', session.id, `balance ${freshBal} lamports after simulation error â†’ stopping (sweep will run)`);
    } else {
      const fails = (consecutiveSimFailures.get(session.id) ?? 0) + 1;
      consecutiveSimFailures.set(session.id, fails);
      if (fails >= 3) {
        await setSessionStatus(session.id, 'stopping', { stop_reason: 'repeated_simulation_failures' }, { expectedStatuses: ['active'] });
        log('warn', session.id, `${fails} consecutive simulation failures â†’ stopping`);
      }
    }
    return;
  }

  try {
    if (tradeGate) {
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'allowed',
        reason: tradeGate.reason,
        expectedEdgeBps: tradeGate.expectedEdgeBps,
        estimatedCostBps: tradeGate.estimatedCostBps,
        safetyBufferBps: tradeGate.safetyBufferBps,
      });
    }
    await persistLastSizing(session, {
      at: new Date().toISOString(),
      decision: 'traded',
      reason: sizingReason,
      balanceLamports: String(balance),
      reserveLamports: String(positionState.status === 'flat' ? MIN_SOL_OPERATING_RESERVE_LAMPORTS : tradePlan.inventory.reserveAtomic),
      tradableLamports: String(positionState.status === 'flat' ? Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS) : tradePlan.inventory.tradableAtomic),
      fractionBps: tradePlan.direction === 'enter_long_sol' || tradePlan.direction === 'exit_long_sol' ? 10000 : sizingPolicy.tradeFractionBps,
      targetLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.targetAtomic),
      minTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.minTradeAtomic),
      maxTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.maxTradeAtomic),
      amountLamports: positionState.status === 'long_sol' ? String(tradeAmount) : null,
      remainingRiskBudgetUsd: economics?.remainingRiskBudgetUsd ?? remainingRiskBudgetUsd,
      quotedOutAmountAtomic: economics ? String(economics.quotedOutAmountAtomic) : null,
      minimumOutputAtomic: economics ? String(economics.minimumOutputAtomic) : null,
      priceImpactPct: economics?.priceImpactPct ?? null,
      estimatedNetworkCostLamports: economics ? String(economics.estimatedNetworkCostLamports) : null,
      estimatedNetworkCostOutputAtomic: economics ? String(economics.estimatedNetworkCostOutputAtomic) : null,
      worstCaseSlippageOutputAtomic: economics ? String(economics.worstCaseSlippageOutputAtomic) : null,
      totalWorstCaseCostOutputAtomic: economics ? String(economics.totalWorstCaseCostOutputAtomic) : null,
      riskAdjustedAmountLamports: positionState.status === 'long_sol' && tradeAmount !== baseTradeAmount
        ? String(tradeAmount)
        : null,
      tradeContext: buildSizingTradeContext({
        ...tradePlan.inventory,
        amountAtomic: tradeAmount,
        riskAdjustedAmountAtomic: tradeAmount !== baseTradeAmount ? tradeAmount : null,
      }),
    });
  } catch (err) {
    log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
  }

  // Step 2: Sign the prepared transaction
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(
      Buffer.from(prepare.data.preparedTransactionBase64, 'base64'),
    );
    tx.sign([keypair]);
  } catch (err) {
    log('warn', session.id, `sign failed: ${String(err)}`);
    try {
      await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
        stage: 'worker_cancel',
        reason: 'sign_failed',
      });
    } catch (cancelErr) {
      log('warn', session.id, `cancel prepared execution failed after sign error: ${String(cancelErr)}`);
    }
    return;
  }

  const signedBase64 = Buffer.from(tx.serialize()).toString('base64');

  // Step 3: Submit
  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId:            prepare.data.executionId,
    signedTransactionBase64: signedBase64,
    blockhash:              prepare.data.blockhash,
    lastValidBlockHeight:   prepare.data.lastValidBlockHeight,
  });

  if (!submit.ok) {
    await persistTradeDecision(session, 'blocked', 'submit_failed');
    log('warn', session.id, `submit failed (${submit.status}): ${submit.data.error ?? JSON.stringify(submit.data)}`);
    const submitErrorText = submit.data.error ?? '';
    const submitBlockhashExpired = submit.status === 409 && /blockhash|expired/i.test(submitErrorText);

    if (submitBlockhashExpired) {
      await releaseTradeWindowReservation(session);
      log('info', session.id, 'submit blockhash expired â†’ released cooldown for immediate rebuild');
    }

    if (submit.data.shortfall) {
      await setSessionStatus(session.id, 'stopping', { stop_reason: 'depleted' }, { expectedStatuses: ['active'] });
      log(
        'info',
        session.id,
        `submit exposed route shortfall: have ${submit.data.shortfall.availableLamports}, need ${submit.data.shortfall.requiredLamports} (gap ${submit.data.shortfall.gapLamports}) â†’ stopping (sweep will run)`,
      );
    }
    return;
  }

  log('info', session.id, `trade submitted â€” sig: ${submit.data.signature ?? 'pending'} status: ${submit.data.status}`);
  consecutiveSimFailures.delete(session.id);

  await persistTradeDecision(session, 'submitted', submit.data.status ?? 'submitted');

  try {
    await persistSchedulingState(session, {
      lastTradeSubmittedAt: new Date().toISOString(),
    });
  } catch (err) {
    log('warn', session.id, `failed to persist trade submit timestamp: ${String(err)}`);
  }

  const postSubmitBalance = await rlGetBalance(keypair.publicKey).catch(() => balance - tradeAmount);

  // Update session funding (rough PnL tracking â€” will be reconciled later)
  await mergeFundingPatch(session, {
    currentBalanceAtomic: String(postSubmitBalance),
  });
};

// â”€â”€ Cooldown tracker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const lastTradedAt = new Map<string, number>();
const consecutiveSimFailures = new Map<string, number>();
const sessionStatusPriority: Record<string, number> = {
  stopping: 0,
  awaiting_funding: 1,
  ready: 2,
  starting: 3,
  active: 4,
};

const getPersistedTradeAttemptMs = (session: RawSession): number => {
  const persisted = session.service_control.schedulingState?.lastTradeAttemptedAt;
  if (!persisted) return 0;
  const parsed = Date.parse(persisted);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getLastTradeAttemptMs = (session: RawSession): number => {
  const inMemory = lastTradedAt.get(session.id);
  if (inMemory !== undefined) return inMemory;

  const persisted = getPersistedTradeAttemptMs(session);
  if (persisted > 0) {
    lastTradedAt.set(session.id, persisted);
  }
  return persisted;
};

const getLastTradeSubmittedMs = (session: RawSession): number => {
  const submittedAt = session.service_control.schedulingState?.lastTradeSubmittedAt;
  if (!submittedAt) return 0;

  const parsed = Date.parse(submittedAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

const persistSchedulingState = async (
  session: RawSession,
  schedulingStatePatch: Partial<NonNullable<Session['serviceControl']['schedulingState']>>,
) => {
  const latestSession = await getSessionById(session.id);
  const baseServiceControl = latestSession?.service_control ?? session.service_control;
  const schedulingState = {
    lastTradeAttemptedAt: baseServiceControl.schedulingState?.lastTradeAttemptedAt ?? null,
    lastTradeSubmittedAt: baseServiceControl.schedulingState?.lastTradeSubmittedAt ?? null,
    ...schedulingStatePatch,
  };

  await mergeServiceControlPatch(session, { schedulingState });
};

const BLOCKED_REASON_COUNTER_LIMIT = 20;

const trimBlockedReasonCounts = (counts: Record<string, number>) => {
  const nextEntries = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, BLOCKED_REASON_COUNTER_LIMIT);

  return Object.fromEntries(nextEntries);
};

const persistTradeDecision = async (
  session: RawSession,
  outcome: NonNullable<NonNullable<Session['serviceControl']['schedulingState']>['lastDecisionOutcome']>,
  reason: string | null,
) => {
  const nowIso = new Date().toISOString();

  if (outcome === 'blocked' && reason) {
    const latestSession = await getSessionById(session.id);
    const currentCounts = latestSession?.service_control?.schedulingState?.blockedReasonCounts ?? {};
    const nextCounts = trimBlockedReasonCounts({
      ...currentCounts,
      [reason]: (currentCounts[reason] ?? 0) + 1,
    });

    await persistSchedulingState(session, {
      lastDecisionAt: nowIso,
      lastDecisionOutcome: outcome,
      lastDecisionReason: reason,
      lastBlockedAt: nowIso,
      lastBlockedReason: reason,
      blockedReasonCounts: nextCounts,
    });
    return;
  }

  await persistSchedulingState(session, {
    lastDecisionAt: nowIso,
    lastDecisionOutcome: outcome,
    lastDecisionReason: reason,
  });
};

const releaseTradeWindowReservation = async (session: RawSession) => {
  lastTradedAt.delete(session.id);

  try {
    await persistSchedulingState(session, {
      lastTradeAttemptedAt: null,
      lastTradeSubmittedAt: null,
    });
  } catch (err) {
    log('warn', session.id, `failed to release trade window reservation: ${String(err)}`);
  }
};

const persistLastSizing = async (
  session: RawSession,
  lastSizing: NonNullable<Session['serviceControl']['lastSizing']>,
) => {
  await mergeServiceControlPatch(session, { lastSizing });
};

const persistLastSignal = async (
  session: RawSession,
  lastSignal: NonNullable<Session['serviceControl']['lastSignal']>,
) => {
  await mergeServiceControlPatch(session, { lastSignal });
};

const persistLastTradeGate = async (
  session: RawSession,
  lastTradeGate: NonNullable<Session['serviceControl']['lastTradeGate']>,
) => {
  await mergeServiceControlPatch(session, { lastTradeGate });
};

const getPositionState = (session: RawSession): NonNullable<Session['serviceControl']['positionState']> =>
  session.service_control.positionState ?? {
    status: 'flat',
    entryPriceUsd: null,
    entryAt: null,
    quantityAtomic: null,
    highWaterPriceUsd: null,
    lastMarkedPriceUsd: null,
    lastMarkedAt: null,
    pendingExitReason: null,
    exitReason: null,
  };

const buildStoppedPositionState = (
  positionState: NonNullable<Session['serviceControl']['positionState']>,
): NonNullable<Session['serviceControl']['positionState']> => ({
  status: 'flat',
  entryPriceUsd: null,
  entryAt: null,
  quantityAtomic: null,
  highWaterPriceUsd: null,
  lastMarkedPriceUsd: positionState.lastMarkedPriceUsd,
  lastMarkedAt: positionState.lastMarkedAt,
  pendingExitReason: null,
  exitReason: positionState.pendingExitReason ?? positionState.exitReason,
});

const nextSessionEvaluationAt = new Map<string, number>();
let lastCadenceTelemetryLogMs = 0;

const applyCadenceJitter = (delayMs: number): number => {
  const bounded = Math.max(MIN_LOOP_MS, delayMs);
  const jitter = Math.max(0, LOOP_JITTER_RATIO);
  if (jitter === 0) return bounded;

  const jitterFactor = 1 - jitter + (Math.random() * jitter * 2);
  return Math.max(MIN_LOOP_MS, Math.round(bounded * jitterFactor));
};

const getSessionCadenceMs = (session: RawSession): number => {
  const cadence = getLiveSpeedProfile().cadenceMs;
  switch (session.status) {
    case 'awaiting_funding':
      return FUNDING_POLL_FALLBACK_MS;
    case 'ready':
    case 'starting':
      return cadence.readyStarting;
    case 'stopping':
      return cadence.stopping;
    case 'active': {
      const lastSubmittedMs = getLastTradeSubmittedMs(session);
      if (lastSubmittedMs > 0 && (Date.now() - lastSubmittedMs) < POST_SUBMIT_RECONCILE_GRACE_MS) {
        return cadence.postSubmitFast;
      }

      const positionState = getPositionState(session);
      if (positionState.status === 'long_sol') {
        return cadence.activeInPosition;
      }

      const signalStatus = session.service_control.lastSignal?.status;
      if (signalStatus === 'guarded_off' || signalStatus === 'warming_up') {
        return cadence.activeGuarded;
      }

      return cadence.activeFlat;
    }
    default:
      return POLL_MS;
  }
};

const reserveTradeWindow = async (session: RawSession): Promise<boolean> => {
  const last = getLastTradeAttemptMs(session);
  const elapsed = Date.now() - last;
  if (elapsed < session.risk_limits.cooldownMs) return false;

  const now = Date.now();
  lastTradedAt.set(session.id, now);

  try {
    const nowIso = new Date(now).toISOString();
    await persistSchedulingState(session, {
      lastTradeAttemptedAt: nowIso,
      lastDecisionAt: nowIso,
      lastDecisionOutcome: 'attempted',
      lastDecisionReason: null,
    });
  } catch (err) {
    log('warn', session.id, `failed to persist scheduling state: ${String(err)}`);
  }

  return true;
};

const orderSessionsForTick = (sessions: RawSession[]): RawSession[] =>
  [...sessions].sort((a, b) => {
    const priorityDiff = (sessionStatusPriority[a.status] ?? 99) - (sessionStatusPriority[b.status] ?? 99);
    if (priorityDiff !== 0) return priorityDiff;

    if (a.status === 'active' && b.status === 'active') {
      const lastTradeDiff = getLastTradeAttemptMs(a) - getLastTradeAttemptMs(b);
      if (lastTradeDiff !== 0) return lastTradeDiff;
    }

    const requestedAtDiff = a.requested_at.getTime() - b.requested_at.getTime();
    if (requestedAtDiff !== 0) return requestedAtDiff;

    return a.id.localeCompare(b.id);
  });

// â”€â”€ Sweep funds back to owner on session stop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type SessionTokenAccount = {
  address: PublicKey;
  programId: PublicKey;
  account: SplTokenAccount;
  mint: SplTokenMint;
};

type SweepResult = {
  solBalance: number;
  tokenProgramAccounts: string[];
  token2022Accounts: string[];
};

const SWEEP_SNAPSHOT_MAX_ATTEMPTS = 10;
const SWEEP_SNAPSHOT_WAIT_MS = 500;

const getSessionTokenAccounts = async (owner: PublicKey): Promise<SessionTokenAccount[]> => {
  const tokenPrograms = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const mintCache = new Map<string, SplTokenMint>();
  const accounts: SessionTokenAccount[] = [];

  for (const programId of tokenPrograms) {
    const tokenAccounts = await rlGetTokenAccountsByOwner(owner, programId);

    for (const tokenAccount of tokenAccounts.value) {
      const account = unpackAccount(tokenAccount.pubkey, tokenAccount.account, programId);
      const mintCacheKey = `${programId.toBase58()}:${account.mint.toBase58()}`;

      let mint = mintCache.get(mintCacheKey);
      if (!mint) {
        mint = await rlGetMint(account.mint, programId);
        mintCache.set(mintCacheKey, mint);
      }

      accounts.push({
        address: tokenAccount.pubkey,
        programId,
        account,
        mint,
      });
    }
  }

  return accounts;
};

const getWalletSweepSnapshot = async (
  owner: PublicKey,
  commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
): Promise<SweepResult> => {
  const solBalance = await rlGetBalance(owner, commitment);
  const tokenProgramAccounts = await rlGetTokenAccountsByOwner(owner, TOKEN_PROGRAM_ID, commitment);
  const token2022Accounts = await rlGetTokenAccountsByOwner(owner, TOKEN_2022_PROGRAM_ID, commitment);

  return {
    solBalance,
    tokenProgramAccounts: tokenProgramAccounts.value.map(({ pubkey }) => pubkey.toBase58()),
    token2022Accounts: token2022Accounts.value.map(({ pubkey }) => pubkey.toBase58()),
  };
};

const sweepSnapshotChanged = (before: SweepResult, after: SweepResult): boolean =>
  before.solBalance !== after.solBalance
  || before.tokenProgramAccounts.length !== after.tokenProgramAccounts.length
  || before.token2022Accounts.length !== after.token2022Accounts.length;

const isConfirmationExpiryError = (error: unknown): boolean =>
  error instanceof Error
  && (
    error.name === 'TransactionExpiredBlockheightExceededError'
    || error.message.includes('block height exceeded')
    || error.message.includes('has expired')
  );

const waitForPostSweepSnapshot = async (
  sessionId: string,
  owner: PublicKey,
  preSweepSnapshot: SweepResult,
): Promise<SweepResult> => {
  let latestSnapshot = await getWalletSweepSnapshot(owner, 'finalized');

  for (let attempt = 1; attempt <= SWEEP_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    if (sweepSnapshotChanged(preSweepSnapshot, latestSnapshot)) {
      return latestSnapshot;
    }

    if (attempt < SWEEP_SNAPSHOT_MAX_ATTEMPTS) {
      log('info', sessionId, `waiting for post-sweep snapshot to settle (${attempt}/${SWEEP_SNAPSHOT_MAX_ATTEMPTS})`);
      await new Promise<void>((resolve) => setTimeout(resolve, SWEEP_SNAPSHOT_WAIT_MS));
      latestSnapshot = await getWalletSweepSnapshot(owner, 'finalized');
    }
  }

  log('warn', sessionId, `post-sweep snapshot still matched pre-sweep state after ${SWEEP_SNAPSHOT_MAX_ATTEMPTS} attempts`);

  const confirmedSnapshot = await getWalletSweepSnapshot(owner, 'confirmed');
  if (sweepSnapshotChanged(preSweepSnapshot, confirmedSnapshot)) {
    log('info', sessionId, 'confirmed post-sweep snapshot changed after finalized lag');
    return confirmedSnapshot;
  }

  return latestSnapshot;
};

const hasResidualWalletState = (snapshot: SweepResult): boolean =>
  snapshot.solBalance > 0
  || snapshot.tokenProgramAccounts.length > 0
  || snapshot.token2022Accounts.length > 0;

const sweepFunds = async (session: RawSession): Promise<SweepResult> => {
  const ownerWallet = session.owner_wallet;

  // Refuse to sweep to the SOL mint placeholder
  if (ownerWallet === SOL_MINT) {
    log('warn', session.id, 'owner_wallet is SOL mint placeholder â€” skipping sweep');
    return getWalletSweepSnapshot(new PublicKey(session.session_wallet));
  }

  const keypair = await getKeypair(session.id);
  if (!keypair) {
    log('warn', session.id, 'no keypair found â€” cannot sweep funds');
    return getWalletSweepSnapshot(new PublicKey(session.session_wallet));
  }

  const conn = getConnection();
  const ownerPubkey = new PublicKey(ownerWallet);
  const sessionPubkey = keypair.publicKey;

  // Fetch SOL balance first â€” needed to decide if we can afford ATA creation
  const solBalance = await rlGetBalance(sessionPubkey);

  if (solBalance < TX_FEE_LAMPORTS) {
    log('warn', session.id, `solBalance ${solBalance} < tx fee â€” cannot sweep`);
    return getWalletSweepSnapshot(sessionPubkey);
  }

  const ixs: TransactionInstruction[] = [];
  let ownerAtaCreationCost = 0;
  let mayLeaveResidualState = false;
  const ownerAtaCreationRentByMint = new Map<string, number>();
  const sessionTokenAccounts = await getSessionTokenAccounts(sessionPubkey);
  const preSweepSnapshot: SweepResult = {
    solBalance,
    tokenProgramAccounts: sessionTokenAccounts
      .filter(({ programId }) => programId.equals(TOKEN_PROGRAM_ID))
      .map(({ address }) => address.toBase58()),
    token2022Accounts: sessionTokenAccounts
      .filter(({ programId }) => programId.equals(TOKEN_2022_PROGRAM_ID))
      .map(({ address }) => address.toBase58()),
  };

  for (const tokenAccount of sessionTokenAccounts) {
    const tokenProgramLabel = tokenAccount.programId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Token';

    if (tokenAccount.account.closeAuthority && !tokenAccount.account.closeAuthority.equals(sessionPubkey)) {
      log('warn', session.id, `skipping ${tokenProgramLabel} account ${tokenAccount.address.toBase58()} â€” close authority is ${tokenAccount.account.closeAuthority.toBase58()}`);
      mayLeaveResidualState = true;
      continue;
    }

    if (tokenAccount.account.isNative) {
      ixs.push(createCloseAccountInstruction(
        tokenAccount.address,
        ownerPubkey,
        sessionPubkey,
        [],
        tokenAccount.programId,
      ));
      log('info', session.id, `queuing native ${tokenProgramLabel} account close: ${tokenAccount.address.toBase58()} â†’ ${ownerWallet}`);
      continue;
    }

    if (tokenAccount.account.amount === 0n) {
      ixs.push(createCloseAccountInstruction(
        tokenAccount.address,
        ownerPubkey,
        sessionPubkey,
        [],
        tokenAccount.programId,
      ));
      log('info', session.id, `queuing empty ${tokenProgramLabel} account close: ${tokenAccount.address.toBase58()} (${tokenAccount.account.mint.toBase58()}) â†’ ${ownerWallet}`);
      continue;
    }

    if (tokenAccount.account.isFrozen) {
      log('warn', session.id, `skipping frozen ${tokenProgramLabel} account ${tokenAccount.address.toBase58()} (${tokenAccount.account.mint.toBase58()}) with balance ${tokenAccount.account.amount}`);
      mayLeaveResidualState = true;
      continue;
    }

    const ownerTokenAta = await getAssociatedTokenAddress(
      tokenAccount.account.mint,
      ownerPubkey,
      false,
      tokenAccount.programId,
    );

    let ownerTokenAtaExists = false;
    try {
      await getAccount(conn, ownerTokenAta, 'confirmed', tokenAccount.programId);
      ownerTokenAtaExists = true;
    } catch {
      // missing ATA, create below if affordable
    }

    if (!ownerTokenAtaExists) {
      const mintCacheKey = `${tokenAccount.programId.toBase58()}:${tokenAccount.account.mint.toBase58()}`;
      let requiredRent = ownerAtaCreationRentByMint.get(mintCacheKey);

      if (requiredRent === undefined) {
        requiredRent = await rlGetMinimumBalanceForRentExemption(getAccountLenForMint(tokenAccount.mint));
        ownerAtaCreationRentByMint.set(mintCacheKey, requiredRent);
      }

      const projectedLamportsAfterCreation = solBalance - ownerAtaCreationCost - requiredRent - TX_FEE_LAMPORTS;
      if (projectedLamportsAfterCreation < 0) {
        log('warn', session.id, `solBalance ${solBalance} too low to create owner ${tokenProgramLabel} ATA for mint ${tokenAccount.account.mint.toBase58()} â€” skipping token sweep of ${tokenAccount.account.amount}`);
        mayLeaveResidualState = true;
        continue;
      }

      ownerAtaCreationCost += requiredRent;
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(
        sessionPubkey,
        ownerTokenAta,
        ownerPubkey,
        tokenAccount.account.mint,
        tokenAccount.programId,
      ));
      log('info', session.id, `queuing owner ${tokenProgramLabel} ATA create for mint ${tokenAccount.account.mint.toBase58()} (${requiredRent} lamports rent)`);
    }

    ixs.push(createTransferInstruction(
      tokenAccount.address,
      ownerTokenAta,
      sessionPubkey,
      tokenAccount.account.amount,
      [],
      tokenAccount.programId,
    ));
    ixs.push(createCloseAccountInstruction(
      tokenAccount.address,
      ownerPubkey,
      sessionPubkey,
      [],
      tokenAccount.programId,
    ));
    log('info', session.id, `queuing ${tokenProgramLabel} sweep: mint ${tokenAccount.account.mint.toBase58()} amount ${tokenAccount.account.amount} â†’ ${ownerWallet}`);
  }

  // â”€â”€ SOL sweep â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Base fee for 1-signature versioned tx = 5,000 lamports (no priority fee).
  // Session wallet must land at exactly 0, not between 0 and rent-exempt.
  const solToSend = solBalance - ownerAtaCreationCost - TX_FEE_LAMPORTS;

  if (solToSend > 0) {
    ixs.push(SystemProgram.transfer({
      fromPubkey: sessionPubkey,
      toPubkey: ownerPubkey,
      lamports: solToSend,
    }));
    log('info', session.id, `queuing SOL sweep: ${solToSend} lamports â†’ ${ownerWallet}`);
  }

  if (ixs.length === 0) {
    log('info', session.id, 'session wallet empty â€” nothing to sweep');
    return getWalletSweepSnapshot(sessionPubkey);
  }

  const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: sessionPubkey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const sweepTx = new VersionedTransaction(message);
  sweepTx.sign([keypair]);

  const sig = await rlSendRawTransaction(sweepTx.serialize());
  let confirmationSettled = false;
  try {
    const confirmation = await rlConfirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

    if (confirmation.value.err) {
      throw new Error(`sweep transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    confirmationSettled = true;
    log('info', session.id, `sweep confirmed: ${sig}`);
  } catch (error) {
    if (isConfirmationExpiryError(error)) {
      log('warn', session.id, `sweep confirmation expired for ${sig}; verifying wallet state directly`);
    } else {
      throw error;
    }
  }

  const postSweepSnapshot = await waitForPostSweepSnapshot(session.id, sessionPubkey, preSweepSnapshot);
  if (!confirmationSettled && !sweepSnapshotChanged(preSweepSnapshot, postSweepSnapshot)) {
    throw new Error(`sweep transaction ${sig} expired before confirmation and wallet state did not change`);
  }

  if (!mayLeaveResidualState && hasResidualWalletState(postSweepSnapshot)) {
    log(
      'warn',
      session.id,
      `post-sweep verification found unexpected residual wallet state: SOL=${postSweepSnapshot.solBalance} token=${postSweepSnapshot.tokenProgramAccounts.length} token2022=${postSweepSnapshot.token2022Accounts.length}`,
    );
  }

  return postSweepSnapshot;
};

// â”€â”€ Stopping â†’ stopped â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const finalizeStop = async (session: RawSession): Promise<void> => {
  const sweepResult = await sweepFunds(session);
  const latestSession = await getSessionById(session.id);
  const latestPositionState = getPositionState(latestSession ?? session);

  if (hasResidualWalletState(sweepResult)) {
    const updatedFunding: Session['funding'] = {
      ...(latestSession?.funding ?? session.funding),
      currentBalanceAtomic: String(sweepResult.solBalance),
    };

    await setSessionStatus(session.id, 'stopping', {
      funding: updatedFunding,
    }, { expectedStatuses: ['stopping'] });

    log(
      'warn',
      session.id,
      `residual wallet state remains after sweep attempt â€” staying in stopping: SOL=${sweepResult.solBalance} token=${sweepResult.tokenProgramAccounts.length} token2022=${sweepResult.token2022Accounts.length}`,
    );
    return;
  }

  const updatedFunding: Session['funding'] = {
    ...(latestSession?.funding ?? session.funding),
    currentBalanceAtomic: String(sweepResult.solBalance),
  };
  const updatedServiceControl = mergeSessionServiceControl(
    latestSession?.service_control ?? session.service_control,
    {
      positionState: buildStoppedPositionState(latestPositionState),
    },
  );

  await setSessionStatus(session.id, 'stopped', {
    ended_at: new Date().toISOString(),
    stop_reason: session.stop_reason ?? 'user_requested',
    funding: updatedFunding,
    service_control: updatedServiceControl,
  }, { expectedStatuses: ['stopping'] });

  log('info', session.id, 'stopping â†’ stopped');
};

// â”€â”€ Main poll loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const log = (level: 'info' | 'warn' | 'error', sessionId: string, msg: string) => {
  console.log(JSON.stringify({
    level,
    service: 'roguezero-worker',
    sessionId,
    msg,
    ts: new Date().toISOString(),
  }));
};

const tick = async (): Promise<number> => {
  await refreshLiveRuntimeControl();
  let sessions: RawSession[];
  try {
    sessions = await querySessions(['awaiting_funding', 'ready', 'starting', 'active', 'stopping']);
  } catch (err) {
    console.error('[worker] DB query failed:', String(err));
    return POLL_MS;
  }

  syncFundingSubscriptions(sessions);

  sessions = orderSessionsForTick(sessions);

  const tickStartedAtMs = Date.now();
  const activeSessionIds = new Set(sessions.map((session) => session.id));
  const cadenceTelemetry = {
    processed: 0,
    deferred: 0,
    byStatus: {
      awaiting_funding: { processed: 0, deferred: 0 },
      ready: { processed: 0, deferred: 0 },
      starting: { processed: 0, deferred: 0 },
      active: { processed: 0, deferred: 0 },
      stopping: { processed: 0, deferred: 0 },
    } as Record<string, { processed: number; deferred: number }>,
  };

  for (const session of sessions) {
    const dueAtMs = nextSessionEvaluationAt.get(session.id) ?? 0;
    const nowMs = Date.now();
    const statusTelemetry = cadenceTelemetry.byStatus[session.status] ?? { processed: 0, deferred: 0 };
    cadenceTelemetry.byStatus[session.status] = statusTelemetry;

    if (nowMs < dueAtMs) {
      cadenceTelemetry.deferred += 1;
      statusTelemetry.deferred += 1;
      continue;
    }

    cadenceTelemetry.processed += 1;
    statusTelemetry.processed += 1;
    let nextCadenceMs = getSessionCadenceMs(session);

    try {
      switch (session.status) {
        case 'awaiting_funding':
          if (shouldRunFundingFallbackCheck(session.id)) {
            await runFundingCheck(session.id);
          }
          break;
        case 'ready':
          await activateSession(session);
          nextCadenceMs = Math.min(nextCadenceMs, getLiveSpeedProfile().cadenceMs.activeFlat);
          break;
        case 'starting':
          await activateSession(session);
          break;
        case 'active': {
          // Auto-stop: exceeded target duration
          const startedAtMs = session.started_at ? new Date(session.started_at).getTime() : 0;
          const targetMs = (session.user_control.targetDurationMinutes ?? 60) * 60_000;
          if (startedAtMs > 0 && (Date.now() - startedAtMs) > targetMs) {
            await setSessionStatus(session.id, 'stopping', { stop_reason: 'user_requested' }, { expectedStatuses: ['active'] });
            log('info', session.id, `target duration ${session.user_control.targetDurationMinutes}min exceeded â†’ stopping`);
            nextCadenceMs = Math.min(nextCadenceMs, getLiveSpeedProfile().cadenceMs.stopping);
            break;
          }

          // Auto-stop: stale session (no trade attempt for too long)
          const lastAttemptMs = getLastTradeAttemptMs(session);
          const staleLimitMs = STALE_SESSION_MINUTES * 60_000;
          if (lastAttemptMs > 0 && (Date.now() - lastAttemptMs) > staleLimitMs) {
            await setSessionStatus(session.id, 'stopping', { stop_reason: 'runtime_error' }, { expectedStatuses: ['active'] });
            log('warn', session.id, `no trade attempt for ${STALE_SESSION_MINUTES}min â†’ stale auto-stop`);
            nextCadenceMs = Math.min(nextCadenceMs, getLiveSpeedProfile().cadenceMs.stopping);
            break;
          }

          if (await reserveTradeWindow(session)) {
            await executeTrade(session);
          } else {
            const last = getLastTradeAttemptMs(session);
            const remainingCooldown = Math.max(0, session.risk_limits.cooldownMs - (Date.now() - last));
            nextCadenceMs = Math.max(MIN_LOOP_MS, Math.min(nextCadenceMs, remainingCooldown));
          }
          break;
        }
        case 'stopping':
          await finalizeStop(session);
          break;
      }
    } catch (err) {
      log('error', session.id, `unhandled error: ${String(err)}`);
    } finally {
      nextSessionEvaluationAt.set(session.id, Date.now() + applyCadenceJitter(nextCadenceMs));
    }
  }

  for (const sessionId of [...nextSessionEvaluationAt.keys()]) {
    if (!activeSessionIds.has(sessionId)) {
      nextSessionEvaluationAt.delete(sessionId);
    }
  }

  let nextDelayMs = POLL_MS;
  const nowMs = Date.now();
  for (const dueAtMs of nextSessionEvaluationAt.values()) {
    nextDelayMs = Math.min(nextDelayMs, Math.max(MIN_LOOP_MS, dueAtMs - nowMs));
  }

  if ((tickStartedAtMs - lastCadenceTelemetryLogMs) >= 60_000) {
    lastCadenceTelemetryLogMs = tickStartedAtMs;
    console.log(JSON.stringify({
      service: 'roguezero-worker',
      kind: 'loop_cadence',
      ts: new Date().toISOString(),
      sessions: sessions.length,
      processed: cadenceTelemetry.processed,
      deferred: cadenceTelemetry.deferred,
      nextDelayMs,
      byStatus: cadenceTelemetry.byStatus,
    }));
  }

  return nextDelayMs;
};

const scheduleNextTick = (delayMs: number) => {
  setTimeout(() => {
    void runLoop();
  }, delayMs);
};

const runLoop = async (): Promise<void> => {
  const nextDelayMs = await tick();
  scheduleNextTick(nextDelayMs);
};

// â”€â”€ Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log(JSON.stringify({
  service: 'roguezero-worker',
  status: 'starting',
  configReady: configReport.readyForLiveIntegration,
  missingLiveValues: configReport.missingLiveValues,
  pollIntervalMs: POLL_MS,
  minLoopIntervalMs: MIN_LOOP_MS,
  speedProfile: liveSpeedProfile.name,
  maxSolEntryUsd: liveSpeedProfile.maxSolEntryUsd,
  concurrentCapacity: liveSpeedProfile.concurrentCapacity,
  cadenceMs: {
    readyStarting: liveSpeedProfile.cadenceMs.readyStarting,
    activeInPosition: liveSpeedProfile.cadenceMs.activeInPosition,
    activeFlat: liveSpeedProfile.cadenceMs.activeFlat,
    activeGuarded: liveSpeedProfile.cadenceMs.activeGuarded,
    stopping: liveSpeedProfile.cadenceMs.stopping,
    postSubmitFast: liveSpeedProfile.cadenceMs.postSubmitFast,
    jitterRatio: LOOP_JITTER_RATIO,
  },
  apiBase: API_BASE,
  limits: {
    jupiterGeneralRps: JUPITER_GENERAL_RPS,
    jupiterGeneralBurst: JUPITER_GENERAL_BURST,
    heliusRpcRps: HELIUS_RPC_RPS,
    heliusRpcBurst: HELIUS_RPC_BURST,
    fundingPollFallbackMs: FUNDING_POLL_FALLBACK_MS,
    minTradeableLamports: MIN_TRADEABLE_LAMPORTS,
    maxRouteSetupLamports: MAX_ROUTE_SETUP_LAMPORTS,
    operatingBufferLamports: OPERATING_BUFFER_LAMPORTS,
  },
  priceFeeds: {
    pythPollMs: pricePollPolicy.pythPollMs,
    jupiterPricePollMs: pricePollPolicy.jupiterPricePollMs,
    maxConsecutiveFailures: pricePollPolicy.maxConsecutiveFailures,
    sharedTapeSize: pricePollPolicy.sharedTapeSize,
    pythHermesBaseUrl: pythPriceConfig?.hermesBaseUrl ?? null,
    pythApiKeyConfigured: !!pythPriceConfig?.apiKey,
    pythConfigured: !!pythPriceConfig,
    jupiterPriceConfigured: !!jupiterPriceConfig,
  },
  signal: {
    momentumLookbackSamples: signalPolicy.momentumLookbackSamples,
    momentumThresholdBps: signalPolicy.momentumThresholdBps,
    maxPythAgeSeconds: signalPolicy.maxPythAgeSeconds,
    maxPythConfidenceBps: signalPolicy.maxPythConfidenceBps,
    edgeSafetyBufferBps: signalPolicy.edgeSafetyBufferBps,
    minEntrySignalPersistenceSamples: MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES,
    maxQuotePriceImpactBps: MAX_QUOTE_PRICE_IMPACT_BPS,
    tokenUniverseAutoSortEnabled: TOKEN_UNIVERSE_AUTO_SORT_ENABLED,
    tokenUniverseAutoSortIntervalMs: TOKEN_UNIVERSE_AUTO_SORT_INTERVAL_MS,
    tokenUniverseAutoSortTopEnabled: TOKEN_UNIVERSE_AUTO_SORT_TOP_ENABLED,
    tokenUniverseAutoSortNotionalUsdcAtomic: TOKEN_UNIVERSE_AUTO_SORT_NOTIONAL_USDC_ATOMIC,
    tokenUniverseAutoSortMaxPriceImpactBps: TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS,
    tokenUniverseEngineMaxStaleMs: TOKEN_UNIVERSE_ENGINE_MAX_STALE_MS,
    tokenUniverseDeadPruneEnabled: TOKEN_UNIVERSE_DEAD_PRUNE_ENABLED,
    tokenUniverseDeadRunThreshold: TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD,
    tokenUniverseAdmissionStreak: TOKEN_UNIVERSE_ADMISSION_STREAK,
    tokenUniverseEvictionStreak: TOKEN_UNIVERSE_EVICTION_STREAK,
    tokenUniverseMinStayRuns: TOKEN_UNIVERSE_MIN_STAY_RUNS,
    tokenUniverseEvictionRankBuffer: TOKEN_UNIVERSE_EVICTION_RANK_BUFFER,
    universeScoutEnabled: WORKER_UNIVERSE_SCOUT_ENABLED,
    universeScoutMaxCandidates: WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES,
    universeScoutMaxSolPriceImpactBps: WORKER_UNIVERSE_SCOUT_MAX_SOL_PRICE_IMPACT_BPS,
    universeScoutMinSolRank: WORKER_UNIVERSE_SCOUT_MIN_SOL_RANK,
  },
  exits: {
    takeProfitBps: positionExitPolicy.takeProfitBps,
    stopLossBps: positionExitPolicy.stopLossBps,
    trailingStopBps: positionExitPolicy.trailingStopBps,
  },
  timestamp: new Date().toISOString(),
}));

if (!configReport.readyForLiveIntegration) {
  console.warn('[worker] config not fully live â€” missing:', configReport.missingLiveValues.join(', '));
}

// Verify DB connection on startup
getPool().query('SELECT 1').then(() => {
  console.log('[worker] DB connected');
}).catch((err: unknown) => {
  console.error('[worker] DB connection failed:', String(err));
});

const boot = async () => {
  try {
    await refreshLiveRuntimeControl(true);
    await ensureWorkerRuntimeStateStore();
    await loadPersistedMarketTapeState();
    await refreshTokenUniverseMints(true);
  } catch (err) {
    console.error('[worker] market tape restore failed:', String(err));
  }

  startPriceLoops();
  await runLoop();
};

void boot();
