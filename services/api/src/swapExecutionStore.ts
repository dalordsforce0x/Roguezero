import pg from 'pg';
import { getDatabaseConnectionUrl } from '@roguezero/runtime-config';
import { swapExecutionSchema, type SwapExecution } from '@roguezero/session-schema';

type PreparedExecutionRecord = {
  id: string;
  swapPath: '/build';
  status: 'prepared' | 'failed';
  inputMint: string;
  outputMint: string;
  amount: string;
  taker: string;
  feeTokenSymbol: 'SOL' | 'USDC' | 'USDT';
  feeAccount: string;
  platformFeeBps: number;
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  recommendedComputeUnitLimit: number | null;
  preparedTransactionBase64: string | null;
  simulation: {
    err: unknown;
    unitsConsumed: number | null;
    logs: string[];
  };
  build: Record<string, unknown>;
  confirmation: Record<string, unknown> | null;
  signatureStatus: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  preparedAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  signature: string | null;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
};

type SubmittedExecutionUpdate = {
  id: string;
  status: 'submitted' | 'confirmed' | 'failed';
  signature: string;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  confirmation: Record<string, unknown> | null;
  signatureStatus: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
  submittedAt: string;
  confirmedAt: string | null;
  updatedAt: string;
};

type FailedExecutionUpdate = {
  id: string;
  lastError: Record<string, unknown>;
  updatedAt: string;
};

type ExecutionStatus = 'prepared' | 'submitted' | 'confirmed' | 'failed';

type RawExecutionRow = {
  id: string;
  swap_path: '/build';
  status: 'prepared' | 'submitted' | 'confirmed' | 'failed';
  input_mint: string;
  output_mint: string;
  amount: string;
  taker: string;
  fee_token_symbol: 'SOL' | 'USDC' | 'USDT';
  fee_account: string;
  platform_fee_bps: number;
  blockhash: string | null;
  last_valid_block_height: string | null;
  recommended_compute_unit_limit: number | null;
  prepared_transaction_base64: string | null;
  signature: string | null;
  confirmation_status: 'processed' | 'confirmed' | 'finalized' | null;
  simulation: { err: unknown; unitsConsumed: number | null; logs: string[] };
  build_response: Record<string, unknown>;
  confirmation: Record<string, unknown> | null;
  signature_status: Record<string, unknown> | null;
  last_error: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  prepared_at: Date | string;
  submitted_at: Date | string | null;
  confirmed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const { Pool } = pg;
let pool: pg.Pool | null = null;

const getPool = () => {
  if (pool) {
    return pool;
  }

  const databaseUrl = getDatabaseConnectionUrl(process.env);

  const parsed = new URL(databaseUrl);
  parsed.searchParams.delete('sslmode');

  pool = new Pool({
    connectionString: parsed.toString(),
    ...(databaseUrl.includes('sslmode=require')
      ? {
          ssl: {
            rejectUnauthorized: false,
          },
        }
      : {}),
  });

  return pool;
};

let readyPromise: Promise<void> | null = null;

const toIsoString = (value: Date | string | null) => {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const mapRow = (row: RawExecutionRow): SwapExecution =>
  swapExecutionSchema.parse({
    id: row.id,
    swapPath: row.swap_path,
    status: row.status,
    inputMint: row.input_mint,
    outputMint: row.output_mint,
    amount: row.amount,
    taker: row.taker,
    feeTokenSymbol: row.fee_token_symbol,
    feeAccount: row.fee_account,
    platformFeeBps: row.platform_fee_bps,
    blockhash: row.blockhash || null,
    lastValidBlockHeight: row.last_valid_block_height === null ? null : Number(row.last_valid_block_height),
    recommendedComputeUnitLimit: row.recommended_compute_unit_limit || null,
    preparedTransactionBase64: row.prepared_transaction_base64,
    signature: row.signature,
    confirmationStatus: row.confirmation_status,
    simulation: row.simulation,
    build: row.build_response,
    confirmation: row.confirmation,
    signatureStatus: row.signature_status,
    lastError: row.last_error,
    metadata: row.metadata ?? undefined,
    preparedAt: toIsoString(row.prepared_at),
    submittedAt: toIsoString(row.submitted_at),
    confirmedAt: toIsoString(row.confirmed_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });

const ensureReady = async () => {
  const pool = getPool();

  if (!readyPromise) {
    readyPromise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS swap_executions (
          id UUID PRIMARY KEY,
          swap_path TEXT NOT NULL,
          status TEXT NOT NULL,
          input_mint TEXT NOT NULL,
          output_mint TEXT NOT NULL,
          amount TEXT NOT NULL,
          taker TEXT NOT NULL,
          fee_token_symbol TEXT NOT NULL,
          fee_account TEXT NOT NULL,
          platform_fee_bps INTEGER NOT NULL,
          blockhash TEXT,
          last_valid_block_height BIGINT,
          recommended_compute_unit_limit INTEGER,
          prepared_transaction_base64 TEXT,
          signature TEXT,
          confirmation_status TEXT,
          simulation JSONB NOT NULL,
          build_response JSONB NOT NULL,
          confirmation JSONB,
          signature_status JSONB,
          last_error JSONB,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          prepared_at TIMESTAMPTZ NOT NULL,
          submitted_at TIMESTAMPTZ,
          confirmed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `)
      .then(() => pool.query(`
        ALTER TABLE swap_executions
        ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      `))
      .then(() => pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS swap_executions_one_inflight_per_taker_idx
        ON swap_executions (taker)
        WHERE status IN ('prepared', 'submitted')
      `))
      .then(() => undefined);
  }

  return readyPromise;
};

export const executionStoreReady = () => ensureReady();

const uniqueViolationCode = '23505';

export const isSwapExecutionUniqueViolation = (error: unknown) => (
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === uniqueViolationCode
);

export const createPreparedExecution = async (record: PreparedExecutionRecord) => {
  await ensureReady();
  const pool = getPool();

  const result = await pool.query<RawExecutionRow>(
    `
      INSERT INTO swap_executions (
        id,
        swap_path,
        status,
        input_mint,
        output_mint,
        amount,
        taker,
        fee_token_symbol,
        fee_account,
        platform_fee_bps,
        blockhash,
        last_valid_block_height,
        recommended_compute_unit_limit,
        prepared_transaction_base64,
        signature,
        confirmation_status,
        simulation,
        build_response,
        confirmation,
        signature_status,
        last_error,
        metadata,
        prepared_at,
        submitted_at,
        confirmed_at,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb,
        $23::timestamptz, $24::timestamptz, $25::timestamptz, $26::timestamptz, $27::timestamptz
      )
      RETURNING *
    `,
    [
      record.id,
      record.swapPath,
      record.status,
      record.inputMint,
      record.outputMint,
      record.amount,
      record.taker,
      record.feeTokenSymbol,
      record.feeAccount,
      record.platformFeeBps,
      record.blockhash,
      record.lastValidBlockHeight,
      record.recommendedComputeUnitLimit,
      record.preparedTransactionBase64,
      record.signature,
      record.confirmationStatus,
      JSON.stringify(record.simulation),
      JSON.stringify(record.build),
      record.confirmation ? JSON.stringify(record.confirmation) : null,
      record.signatureStatus ? JSON.stringify(record.signatureStatus) : null,
      record.lastError ? JSON.stringify(record.lastError) : null,
      JSON.stringify(record.metadata),
      record.preparedAt,
      record.submittedAt,
      record.confirmedAt,
      record.createdAt,
      record.updatedAt,
    ],
  );

  return mapRow(result.rows[0]);
};

export const updateSubmittedExecution = async (record: SubmittedExecutionUpdate) => {
  await ensureReady();
  const pool = getPool();

  const result = await pool.query<RawExecutionRow>(
    `
      UPDATE swap_executions
      SET
        status = $2,
        signature = $3,
        confirmation_status = $4,
        confirmation = $5::jsonb,
        signature_status = $6::jsonb,
        last_error = $7::jsonb,
        submitted_at = $8::timestamptz,
        confirmed_at = $9::timestamptz,
        updated_at = $10::timestamptz
      WHERE id = $1
      RETURNING *
    `,
    [
      record.id,
      record.status,
      record.signature,
      record.confirmationStatus,
      record.confirmation ? JSON.stringify(record.confirmation) : null,
      record.signatureStatus ? JSON.stringify(record.signatureStatus) : null,
      record.lastError ? JSON.stringify(record.lastError) : null,
      record.submittedAt,
      record.confirmedAt,
      record.updatedAt,
    ],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapRow(result.rows[0]);
};

export const markExecutionFailed = async (record: FailedExecutionUpdate) => {
  await ensureReady();
  const pool = getPool();

  const result = await pool.query<RawExecutionRow>(
    `
      UPDATE swap_executions
      SET
        status = 'failed',
        last_error = $2::jsonb,
        updated_at = $3::timestamptz
      WHERE id = $1
      RETURNING *
    `,
    [record.id, JSON.stringify(record.lastError), record.updatedAt],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapRow(result.rows[0]);
};

export const getExecutionById = async (id: string) => {
  await ensureReady();
  const pool = getPool();

  const result = await pool.query<RawExecutionRow>(
    'SELECT * FROM swap_executions WHERE id = $1',
    [id],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapRow(result.rows[0]);
};

export const getActiveExecutionByTaker = async (taker: string) => {
  await ensureReady();
  const pool = getPool();

  const result = await pool.query<RawExecutionRow>(
    `
      SELECT *
      FROM swap_executions
      WHERE taker = $1
        AND status IN ('prepared', 'submitted')
      ORDER BY updated_at ASC
      LIMIT 1
    `,
    [taker],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapRow(result.rows[0]);
};

export const listExecutionsByStatus = async (
  statuses: ExecutionStatus[],
  limit = 100,
) => {
  await ensureReady();
  const pool = getPool();

  if (statuses.length === 0) {
    return [] as SwapExecution[];
  }

  const result = await pool.query<RawExecutionRow>(
    `
      SELECT *
      FROM swap_executions
      WHERE status = ANY($1::text[])
      ORDER BY updated_at ASC
      LIMIT $2
    `,
    [statuses, limit],
  );

  return result.rows.map(mapRow);
};
