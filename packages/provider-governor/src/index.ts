import type pg from 'pg';

const DEFAULT_TABLE_NAME = 'provider_rate_limits';
const DEFAULT_BUDGET_TABLE_NAME = 'provider_monthly_budgets';
const TABLE_READY = new WeakMap<pg.Pool, Map<string, Promise<void>>>();

export type BucketComputation = {
  granted: boolean;
  availableTokens: number;
  waitMs: number;
};

export type BudgetPressureLevel = 'normal' | 'watch' | 'throttle' | 'halt';

export type BudgetComputation = {
  granted: boolean;
  pressure: BudgetPressureLevel;
  usedUnits: number;
  reservedUnits: number;
  monthlyLimitUnits: number;
  usageRatio: number;
  elapsedRatio: number;
  projectedUsageRatio: number;
  remainingUnits: number;
};

export type ExponentialBackoffOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
};

export type SharedTokenBucketOptions = {
  pool: pg.Pool;
  key: string;
  maxTokens: number;
  refillRatePerSec: number;
  tableName?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export type MonthlyBudgetGovernorOptions = {
  pool: pg.Pool;
  key: string;
  monthlyLimitUnits: number;
  tableName?: string;
  enforceLimit?: boolean;
  now?: () => Date;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const computeBucketState = (params: {
  availableTokens: number;
  elapsedMs: number;
  maxTokens: number;
  refillRatePerSec: number;
  requestedTokens?: number;
}): BucketComputation => {
  const requestedTokens = params.requestedTokens ?? 1;
  const refilledTokens = Math.min(
    params.maxTokens,
    params.availableTokens + (params.elapsedMs / 1000) * params.refillRatePerSec,
  );

  if (refilledTokens >= requestedTokens) {
    return {
      granted: true,
      availableTokens: refilledTokens - requestedTokens,
      waitMs: 0,
    };
  }

  const missingTokens = requestedTokens - refilledTokens;
  const waitMs = Math.ceil((missingTokens / params.refillRatePerSec) * 1000);

  return {
    granted: false,
    availableTokens: refilledTokens,
    waitMs,
  };
};

const clampRatio = (value: number) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

export const getUtcMonthWindow = (date: Date) => {
  const periodStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));

  return {
    periodStart,
    periodEnd,
  };
};

export const computeBudgetState = (params: {
  usedUnits: number;
  reserveUnits?: number;
  monthlyLimitUnits: number;
  now: Date;
  periodStart: Date;
  periodEnd: Date;
  enforceLimit?: boolean;
}): BudgetComputation => {
  const reserveUnits = Math.max(0, params.reserveUnits ?? 1);
  const monthlyLimitUnits = Math.max(0, params.monthlyLimitUnits);
  const usedUnits = Math.max(0, params.usedUnits);
  const nextUsedUnits = usedUnits + reserveUnits;
  const periodMs = Math.max(1, params.periodEnd.getTime() - params.periodStart.getTime());
  const elapsedMs = Math.max(0, params.now.getTime() - params.periodStart.getTime());
  const elapsedRatio = clampRatio(elapsedMs / periodMs);
  const usageRatio = monthlyLimitUnits > 0 ? nextUsedUnits / monthlyLimitUnits : 1;
  const projectedUsageRatio = elapsedRatio > 0
    ? usageRatio / Math.max(elapsedRatio, 0.01)
    : usageRatio;
  const pressure: BudgetPressureLevel = usageRatio >= 1
    ? 'halt'
    : (usageRatio >= 0.9 || projectedUsageRatio >= 1.1)
      ? 'throttle'
      : (usageRatio >= 0.75 || projectedUsageRatio >= 0.9)
        ? 'watch'
        : 'normal';
  const granted = monthlyLimitUnits > 0
    && (!(params.enforceLimit ?? true) || nextUsedUnits <= monthlyLimitUnits);

  return {
    granted,
    pressure,
    usedUnits: nextUsedUnits,
    reservedUnits: reserveUnits,
    monthlyLimitUnits,
    usageRatio,
    elapsedRatio,
    projectedUsageRatio,
    remainingUnits: Math.max(0, monthlyLimitUnits - nextUsedUnits),
  };
};

export const getExponentialBackoffDelayMs = (
  attempt: number,
  options: ExponentialBackoffOptions = {},
) => {
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const random = options.random ?? Math.random;
  const baseDelay = Math.min(initialDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
  const jitterFactor = 1 - jitterRatio + random() * jitterRatio * 2;
  return Math.max(0, Math.round(baseDelay * jitterFactor));
};

const getTableReadyMap = (pool: pg.Pool) => {
  let tableMap = TABLE_READY.get(pool);

  if (!tableMap) {
    tableMap = new Map<string, Promise<void>>();
    TABLE_READY.set(pool, tableMap);
  }

  return tableMap;
};

const ensureTableReady = async (pool: pg.Pool, tableName: string) => {
  const tableMap = getTableReadyMap(pool);
  let ready = tableMap.get(tableName);

  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        bucket_key TEXT PRIMARY KEY,
        available_tokens DOUBLE PRECISION NOT NULL,
        max_tokens DOUBLE PRECISION NOT NULL,
        refill_rate_per_sec DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).then(() => undefined);
    tableMap.set(tableName, ready);
  }

  return ready;
};

export class SharedTokenBucket {
  private readonly tableName: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: SharedTokenBucketOptions) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
  }

  async acquire(requestedTokens = 1): Promise<void> {
    for (;;) {
      const waitMs = await this.reserve(requestedTokens);
      if (waitMs === 0) {
        return;
      }

      await this.sleep(waitMs);
    }
  }

  private async reserve(requestedTokens: number): Promise<number> {
    await ensureTableReady(this.options.pool, this.tableName);
    const client = await this.options.pool.connect();
    const now = this.now();

    try {
      await client.query('BEGIN');
      await client.query(
        `
          INSERT INTO ${this.tableName} (
            bucket_key,
            available_tokens,
            max_tokens,
            refill_rate_per_sec,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (bucket_key) DO NOTHING
        `,
        [
          this.options.key,
          this.options.maxTokens,
          this.options.maxTokens,
          this.options.refillRatePerSec,
          now.toISOString(),
        ],
      );

      const result = await client.query<{
        available_tokens: number;
        updated_at: Date;
      }>(
        `
          SELECT available_tokens, updated_at
          FROM ${this.tableName}
          WHERE bucket_key = $1
          FOR UPDATE
        `,
        [this.options.key],
      );

      if (result.rowCount === 0) {
        throw new Error(`Rate limit bucket ${this.options.key} could not be loaded`);
      }

      const row = result.rows[0];
      const elapsedMs = Math.max(0, now.getTime() - new Date(row.updated_at).getTime());
      const nextState = computeBucketState({
        availableTokens: Number(row.available_tokens),
        elapsedMs,
        maxTokens: this.options.maxTokens,
        refillRatePerSec: this.options.refillRatePerSec,
        requestedTokens,
      });

      await client.query(
        `
          UPDATE ${this.tableName}
          SET
            available_tokens = $2,
            max_tokens = $3,
            refill_rate_per_sec = $4,
            updated_at = $5
          WHERE bucket_key = $1
        `,
        [
          this.options.key,
          nextState.availableTokens,
          this.options.maxTokens,
          this.options.refillRatePerSec,
          now.toISOString(),
        ],
      );

      await client.query('COMMIT');
      return nextState.waitMs;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const createSharedTokenBucket = (options: SharedTokenBucketOptions) =>
  new SharedTokenBucket(options);

const ensureBudgetTableReady = async (pool: pg.Pool, tableName: string) => {
  const tableMap = getTableReadyMap(pool);
  const key = `budget:${tableName}`;
  let ready = tableMap.get(key);

  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        budget_key TEXT NOT NULL,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        used_units DOUBLE PRECISION NOT NULL,
        monthly_limit_units DOUBLE PRECISION NOT NULL,
        pressure TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (budget_key, period_start)
      )
    `).then(() => undefined);
    tableMap.set(key, ready);
  }

  return ready;
};

export class MonthlyBudgetGovernor {
  private readonly tableName: string;
  private readonly now: () => Date;
  private readonly enforceLimit: boolean;

  constructor(private readonly options: MonthlyBudgetGovernorOptions) {
    this.tableName = options.tableName ?? DEFAULT_BUDGET_TABLE_NAME;
    this.now = options.now ?? (() => new Date());
    this.enforceLimit = options.enforceLimit ?? true;
  }

  async reserve(units = 1): Promise<BudgetComputation> {
    await ensureBudgetTableReady(this.options.pool, this.tableName);
    const client = await this.options.pool.connect();
    const now = this.now();
    const { periodStart, periodEnd } = getUtcMonthWindow(now);

    try {
      await client.query('BEGIN');
      await client.query(
        `
          INSERT INTO ${this.tableName} (
            budget_key,
            period_start,
            period_end,
            used_units,
            monthly_limit_units,
            pressure,
            updated_at
          ) VALUES ($1, $2, $3, 0, $4, 'normal', $5)
          ON CONFLICT (budget_key, period_start) DO NOTHING
        `,
        [
          this.options.key,
          periodStart.toISOString(),
          periodEnd.toISOString(),
          this.options.monthlyLimitUnits,
          now.toISOString(),
        ],
      );

      const result = await client.query<{
        used_units: number;
      }>(
        `
          SELECT used_units
          FROM ${this.tableName}
          WHERE budget_key = $1
            AND period_start = $2
          FOR UPDATE
        `,
        [this.options.key, periodStart.toISOString()],
      );

      if (result.rowCount === 0) {
        throw new Error(`Monthly budget ${this.options.key} could not be loaded`);
      }

      const budgetState = computeBudgetState({
        usedUnits: Number(result.rows[0].used_units),
        reserveUnits: units,
        monthlyLimitUnits: this.options.monthlyLimitUnits,
        now,
        periodStart,
        periodEnd,
        enforceLimit: this.enforceLimit,
      });

      if (budgetState.granted) {
        await client.query(
          `
            UPDATE ${this.tableName}
            SET
              used_units = $3,
              monthly_limit_units = $4,
              pressure = $5,
              period_end = $6,
              updated_at = $7
            WHERE budget_key = $1
              AND period_start = $2
          `,
          [
            this.options.key,
            periodStart.toISOString(),
            budgetState.usedUnits,
            this.options.monthlyLimitUnits,
            budgetState.pressure,
            periodEnd.toISOString(),
            now.toISOString(),
          ],
        );
      }

      await client.query('COMMIT');
      return budgetState;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const createMonthlyBudgetGovernor = (options: MonthlyBudgetGovernorOptions) =>
  new MonthlyBudgetGovernor(options);
