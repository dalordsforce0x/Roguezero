import { Pool } from 'pg';
import { getRuntimeSpeedProfile, normalizeRuntimeSpeedProfileName } from '@/lib/runtimeControl';

const DEFAULT_ROTATION_INTERVAL_MINUTES = 15;

let pool: Pool | null = null;

const getDatabaseConnectionUrl = () => {
  const privateUrl = process.env.DATABASE_PRIVATE_URL?.trim();
  if (privateUrl) {
    return privateUrl;
  }

  if (process.env.ALLOW_PUBLIC_DATABASE_URL_FALLBACK !== 'true') {
    throw new Error('DATABASE_PRIVATE_URL is required for admin database access');
  }

  const publicUrl = process.env.DATABASE_URL?.trim();
  if (publicUrl) {
    return publicUrl;
  }

  throw new Error('DATABASE_PRIVATE_URL or DATABASE_URL is not set');
};

export function getPool(): Pool {
  if (!pool) {
    const databaseUrl = getDatabaseConnectionUrl();

    // Strip sslmode from the URL — pg-connection-string now treats sslmode=require
    // as verify-full (breaks TigerData). We manage SSL explicitly instead.
    const parsed = new URL(databaseUrl);
    parsed.searchParams.delete('sslmode');

    pool = new Pool({
      connectionString: parsed.toString(),
      ...(databaseUrl.includes('sslmode=require') ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 5,
    });
  }
  return pool;
}

export interface RzUser {
  id: string;
  username: string;
  wallet_address: string;
  group_id: string | null;
  group_name: string | null;
  group_bot_limit: number | null;
  license_key: string | null;
  expiry_date: string | null;
  access_enabled: boolean;
  max_wallet_usd: number;
  duration: string | null;
  gated_access_enrolled_at: string | null;
  license_key_revealed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RzUserGroup {
  id: string;
  name: string;
  bot_limit: number;
  member_count: number;
  active_member_count: number;
  created_at: string;
  updated_at: string;
}

export async function usersTableReady(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS rz_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT NOT NULL,
      wallet_address TEXT UNIQUE NOT NULL,
      license_key TEXT,
      expiry_date TIMESTAMPTZ,
      access_enabled BOOLEAN NOT NULL DEFAULT false,
      max_wallet_usd INTEGER NOT NULL DEFAULT 10000,
      duration TEXT,
      gated_access_enrolled_at TIMESTAMPTZ,
      license_key_revealed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE rz_users
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS group_id UUID,
      ADD COLUMN IF NOT EXISTS max_wallet_usd INTEGER NOT NULL DEFAULT 10000,
      ADD COLUMN IF NOT EXISTS gated_access_enrolled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS license_key_revealed_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS rz_user_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL,
      bot_limit INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE rz_user_groups
      ADD COLUMN IF NOT EXISTS bot_limit INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE TABLE IF NOT EXISTS trusted_web_devices (
      device_id_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS trusted_web_devices_user_idx ON trusted_web_devices(user_id);
    CREATE INDEX IF NOT EXISTS rz_users_wallet_idx ON rz_users(wallet_address);
    CREATE INDEX IF NOT EXISTS rz_users_group_idx ON rz_users(group_id);
    CREATE INDEX IF NOT EXISTS rz_user_groups_name_idx ON rz_user_groups(name);
  `);
}

const USER_SELECT = `
      u.id,
      u.username,
      u.wallet_address,
      u.group_id,
      g.name AS group_name,
      g.bot_limit AS group_bot_limit,
      u.license_key,
      u.expiry_date,
      u.access_enabled,
      u.max_wallet_usd,
      u.duration,
      COALESCE(u.gated_access_enrolled_at, td.first_enrolled_at) AS gated_access_enrolled_at,
      u.license_key_revealed_at,
      u.created_at,
      u.updated_at
    FROM rz_users u
    LEFT JOIN rz_user_groups g ON g.id = u.group_id
    LEFT JOIN (
      SELECT user_id, MIN(enrolled_at) AS first_enrolled_at
      FROM trusted_web_devices
      GROUP BY user_id
    ) td ON td.user_id = u.id::text`;

export async function listUsers(): Promise<RzUser[]> {
  const { rows } = await getPool().query<RzUser>(
    `SELECT ${USER_SELECT}
    ORDER BY u.created_at DESC`
  );
  return rows;
}

export async function listUserGroups(): Promise<RzUserGroup[]> {
  const { rows } = await getPool().query<RzUserGroup>(
    `SELECT
      g.id,
      g.name,
      g.bot_limit,
      COUNT(u.id)::int AS member_count,
      COUNT(u.id) FILTER (WHERE u.access_enabled AND (u.expiry_date IS NULL OR u.expiry_date > NOW()))::int AS active_member_count,
      g.created_at,
      g.updated_at
    FROM rz_user_groups g
    LEFT JOIN rz_users u ON u.group_id = g.id
    GROUP BY g.id
    ORDER BY g.name ASC`
  );
  return rows;
}

export async function createUserGroup(name: string, botLimit: number): Promise<RzUserGroup> {
  const { rows } = await getPool().query<RzUserGroup>(
    `INSERT INTO rz_user_groups (name, bot_limit)
     VALUES ($1, $2)
     RETURNING id, name, bot_limit, 0::int AS member_count, 0::int AS active_member_count, created_at, updated_at`,
    [name, botLimit]
  );
  return rows[0];
}

export async function updateUserGroup(id: string, name: string, botLimit: number): Promise<RzUserGroup> {
  const { rows } = await getPool().query<RzUserGroup>(
    `UPDATE rz_user_groups
     SET name = $1, bot_limit = $2, updated_at = NOW()
     WHERE id = $3
     RETURNING id, name, bot_limit, 0::int AS member_count, 0::int AS active_member_count, created_at, updated_at`,
    [name, botLimit, id]
  );
  return rows[0];
}

export async function assignUsersToGroup(groupId: string | null, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await getPool().query(
    `UPDATE rz_users SET group_id = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])`,
    [groupId, userIds]
  );
}

export async function createUser(
  username: string,
  walletAddress: string,
  duration: string,
  maxWalletUsd: number,
  groupId: string | null = null,
): Promise<RzUser> {
  const { rows } = await getPool().query<RzUser>(
    `INSERT INTO rz_users (username, wallet_address, duration, max_wallet_usd, group_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [username, walletAddress, duration, maxWalletUsd, groupId]
  );
  return rows[0];
}

export async function getUserById(id: string): Promise<RzUser | null> {
  const { rows } = await getPool().query<RzUser>(
    `SELECT ${USER_SELECT}
    WHERE u.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getUserByWallet(walletAddress: string): Promise<RzUser | null> {
  const { rows } = await getPool().query<RzUser>(
    `SELECT ${USER_SELECT}
    WHERE u.wallet_address = $1`,
    [walletAddress]
  );
  return rows[0] ?? null;
}

export async function assignLicense(
  id: string,
  licenseKey: string,
  expiryDate: Date
): Promise<RzUser> {
  const { rows } = await getPool().query<RzUser>(
    `UPDATE rz_users
     SET license_key = $1, expiry_date = $2, access_enabled = true, updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [licenseKey, expiryDate, id]
  );
  return rows[0];
}

export async function toggleAccess(id: string, enabled: boolean): Promise<RzUser> {
  const { rows } = await getPool().query<RzUser>(
    `UPDATE rz_users
     SET access_enabled = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [enabled, id]
  );
  return rows[0];
}

export async function updateMaxWalletUsd(id: string, maxWalletUsd: number): Promise<RzUser> {
  const { rows } = await getPool().query<RzUser>(
    `UPDATE rz_users
     SET max_wallet_usd = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [maxWalletUsd, id]
  );
  return rows[0];
}

export async function updateUserProfile(
  id: string,
  patch: {
    username?: string;
    walletAddress?: string;
    duration?: string;
    maxWalletUsd?: number;
    groupId?: string | null;
    expiryDate?: Date | null;
  },
): Promise<RzUser> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (patch.username !== undefined) add('username', patch.username);
  if (patch.walletAddress !== undefined) add('wallet_address', patch.walletAddress);
  if (patch.duration !== undefined) add('duration', patch.duration);
  if (patch.maxWalletUsd !== undefined) add('max_wallet_usd', patch.maxWalletUsd);
  if (patch.groupId !== undefined) add('group_id', patch.groupId);
  if (patch.expiryDate !== undefined) add('expiry_date', patch.expiryDate);

  if (assignments.length === 0) {
    const existing = await getUserById(id);
    if (!existing) throw new Error('User not found');
    return existing;
  }

  values.push(id);
  const { rows } = await getPool().query<RzUser>(
    `UPDATE rz_users
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING *`,
    values,
  );
  return rows[0];
}

export async function deleteUser(id: string): Promise<void> {
  await getPool().query('DELETE FROM rz_users WHERE id = $1', [id]);
}

// ── Session admin operations ─────────────────────────────────────────────────

export interface AdminSessionRow {
  id: string;
  user_id: string;
  username: string;
  owner_wallet: string;
  session_wallet: string;
  requested_at: string;
  status: string;
  started_at: string | null;
  stop_reason: string | null;
  funding: Record<string, unknown>;
  service_control: Record<string, unknown>;
}

export interface TokenUniverseTokenRow {
  mint: string;
  symbol: string;
  enabled: boolean;
  priority: number;
  notes: string | null;
  tradeCount7d: number;
  confirmedTradeCount7d: number;
  lastTradedAt: string | null;
  currentlyActive: boolean;
}

export interface TokenUniverseOverview {
  generatedAt: string;
  summary: {
    configuredTokens: number;
    enabledTokens: number;
    activelyHeldTokens: number;
    tradedTokens7d: number;
  };
  bestToken: {
    mint: string;
    symbol: string;
    tradeCount7d: number;
    confirmedTradeCount7d: number;
    currentlyActive: boolean;
  } | null;
  activeTokens: Array<{
    mint: string;
    symbol: string;
    activeSessionCount: number;
  }>;
  autoSort: {
    status: 'applied' | 'skipped' | 'unknown';
    reason: string | null;
    sourceTable: string | null;
    candidateCount: number;
    enabledCount: number;
    lastRunAt: string | null;
    top: Array<{
      rank: number;
      mint: string;
      symbol: string;
      score: number;
      momentumBps: number;
      priceImpactBps: number | null;
      routeFound: boolean;
    }>;
  };
  scanner: {
    latestRun: {
      id: string;
      status: string;
      reason: string | null;
      candidateCount: number;
      acceptedCount: number;
      rejectedCount: number;
      providerCostEstimate: number;
      finishedAt: string;
    } | null;
    activeCandidates: Array<{
      mint: string;
      symbol: string;
      status: string;
      signalScore: number | null;
      routeQuality: number | null;
      slippageBps: number | null;
      validUntil: string;
      riskFlags: string[];
    }>;
  };
  admission: {
    summary: {
      total: number;
      admitted: number;
      rejected: number;
      latestObservedAt: string | null;
    };
    candidates: Array<{
      mint: string;
      symbol: string;
      bucket: string;
      status: string;
      priority: number;
      successfulQuoteCount: number;
      maxImpactBps: number;
      riskFlags: string[];
      observedAt: string;
    }>;
  };
  health: {
    trackedMints: number;
    activeDeadCandidates: number;
    topDead: Array<{
      mint: string;
      symbol: string;
      deadRuns: number;
      lastReason: string | null;
      lastSeenAt: string;
    }>;
  };
  deadletter: {
    openCount: number;
    recoveredCount: number;
    recent: Array<{
      mint: string;
      symbol: string;
      reason: string;
      deadRuns: number;
      dumpedAt: string;
      recoveredAt: string | null;
      score: number | null;
      momentumBps: number | null;
      priceImpactBps: number | null;
    }>;
  };
  tokens: TokenUniverseTokenRow[];
}

type StrategyKey = 'momentum' | 'mean_reversion' | 'supertrend';

type StrategyControlsPatch = {
  enabledStrategies?: StrategyKey[];
  activeStrategy?: StrategyKey;
  queuedStrategy?: StrategyKey;
  rotationIntervalMinutes?: number;
  autoRotationEnabled?: boolean;
  momentum?: {
    lookbackSamples?: number;
    thresholdBps?: number;
    edgeSafetyBufferBps?: number;
  };
  meanReversion?: {
    length?: number;
    stdMultiplier?: number;
    minBandWidthFraction?: number;
    entryThreshold?: number;
    exitThreshold?: number;
  };
  supertrend?: {
    candleSamples?: number;
    atrPeriod?: number;
    multiplier?: number;
  };
};

type StrategyUniverseEntry = {
  key?: unknown;
  enabled?: unknown;
  [key: string]: unknown;
};

type RuntimeControlRow = {
  control_key: string;
  state: {
    speedProfile?: unknown;
    modeSource?: unknown;
    recommendedProfile?: unknown;
    transitionReason?: unknown;
    lastTransitionAt?: unknown;
    pressure?: unknown;
    entriesEnabled?: unknown;
    maintenanceReason?: unknown;
  } | null;
  updated_at: string;
};

const RUNTIME_CONTROL_KEY = 'global_live_runtime';

export async function listActiveSessions(): Promise<AdminSessionRow[]> {
  const { rows } = await getPool().query<AdminSessionRow>(
    `SELECT s.id, s.user_id, u.username, s.owner_wallet, s.session_wallet, s.requested_at, s.status, s.started_at, s.stop_reason, s.funding, s.service_control
     FROM sessions s
     INNER JOIN rz_users u ON u.id::text = s.user_id
     WHERE s.status NOT IN ('stopped', 'error')
     ORDER BY s.requested_at DESC
     LIMIT 50`
  );
  return rows;
}

export async function forceStopSession(sessionId: string): Promise<AdminSessionRow | null> {
  console.warn(`[admin] forceStopSession disabled by user-only stop invariant: ${sessionId}`);
  return null;
}

const strategyKeyValues: StrategyKey[] = ['momentum', 'mean_reversion', 'supertrend'];

const asPositiveInt = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const asNonNegativeNumber = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const asNumber = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const isStrategyKey = (value: unknown): value is StrategyKey => (
  typeof value === 'string' && strategyKeyValues.includes(value as StrategyKey)
);

const getDefaultStrategyConfig = () => ({
  autoRotationEnabled: true,
  momentum: {
    lookbackSamples: 5,
    thresholdBps: 8,
    edgeSafetyBufferBps: 5,
  },
  meanReversion: {
    length: 20,
    stdMultiplier: 2,
    minBandWidthFraction: 0.006,
    entryThreshold: 0,
    exitThreshold: 0.5,
  },
  supertrend: {
    candleSamples: 10,
    atrPeriod: 10,
    multiplier: 3,
  },
});

export async function updateSessionStrategyControls(
  sessionId: string,
  patch: StrategyControlsPatch,
): Promise<AdminSessionRow | null> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    const existingResult = await client.query<AdminSessionRow>(
      `SELECT s.id, s.user_id, COALESCE(u.username, s.user_id) AS username, s.owner_wallet, s.session_wallet,
              s.requested_at, s.status, s.started_at, s.stop_reason, s.funding, s.service_control
         FROM sessions s
         LEFT JOIN rz_users u ON u.id::text = s.user_id
        WHERE s.id = $1
        LIMIT 1
        FOR UPDATE`,
      [sessionId],
    );

    if (!existingResult.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }

    const existing = existingResult.rows[0];
    const serviceControl = asRecord(existing.service_control);
    const strategyUniverse = Array.isArray(serviceControl.strategyUniverse)
      ? serviceControl.strategyUniverse.filter((entry): entry is StrategyUniverseEntry => (
          Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
        ))
      : [];

    const enabledStrategies = patch.enabledStrategies
      ? patch.enabledStrategies.filter((value) => isStrategyKey(value))
      : strategyUniverse.filter((entry) => entry.enabled === true).map((entry) => entry.key).filter(isStrategyKey);

    if (enabledStrategies.length === 0) {
      throw new Error('At least one strategy must remain enabled');
    }

    const nextStrategyUniverse = strategyUniverse.map((entry) => ({
      ...entry,
      enabled: isStrategyKey(entry.key) && enabledStrategies.includes(entry.key),
    }));

    const rotationState = asRecord(serviceControl.rotationState);
    const nextActiveStrategy = patch.activeStrategy ?? rotationState.activeStrategy;
    const nextQueuedStrategy = patch.queuedStrategy ?? rotationState.queuedStrategy;

    if (!isStrategyKey(nextActiveStrategy) || !enabledStrategies.includes(nextActiveStrategy)) {
      throw new Error('activeStrategy must be an enabled strategy');
    }
    if (!isStrategyKey(nextQueuedStrategy) || !enabledStrategies.includes(nextQueuedStrategy)) {
      throw new Error('queuedStrategy must be an enabled strategy');
    }

    const defaultStrategyConfig = getDefaultStrategyConfig();
    const strategyConfig = asRecord(serviceControl.strategyConfig);
    const currentStrategyConfig = {
      ...defaultStrategyConfig,
      ...strategyConfig,
      momentum: {
        ...defaultStrategyConfig.momentum,
        ...asRecord(strategyConfig.momentum),
      },
      meanReversion: {
        ...defaultStrategyConfig.meanReversion,
        ...asRecord(strategyConfig.meanReversion),
      },
      supertrend: {
        ...defaultStrategyConfig.supertrend,
        ...asRecord(strategyConfig.supertrend),
      },
    };

    const nextStrategyConfig = {
      autoRotationEnabled: patch.autoRotationEnabled ?? currentStrategyConfig.autoRotationEnabled,
      momentum: {
        lookbackSamples: asPositiveInt(patch.momentum?.lookbackSamples) ?? currentStrategyConfig.momentum.lookbackSamples,
        thresholdBps: asPositiveInt(patch.momentum?.thresholdBps) ?? currentStrategyConfig.momentum.thresholdBps,
        edgeSafetyBufferBps: asNonNegativeNumber(patch.momentum?.edgeSafetyBufferBps) ?? currentStrategyConfig.momentum.edgeSafetyBufferBps,
      },
      meanReversion: {
        length: asPositiveInt(patch.meanReversion?.length) ?? currentStrategyConfig.meanReversion.length,
        stdMultiplier: asNonNegativeNumber(patch.meanReversion?.stdMultiplier) ?? currentStrategyConfig.meanReversion.stdMultiplier,
        minBandWidthFraction: asNonNegativeNumber(patch.meanReversion?.minBandWidthFraction) ?? currentStrategyConfig.meanReversion.minBandWidthFraction,
        entryThreshold: asNumber(patch.meanReversion?.entryThreshold) ?? currentStrategyConfig.meanReversion.entryThreshold,
        exitThreshold: asNumber(patch.meanReversion?.exitThreshold) ?? currentStrategyConfig.meanReversion.exitThreshold,
      },
      supertrend: {
        candleSamples: asPositiveInt(patch.supertrend?.candleSamples) ?? currentStrategyConfig.supertrend.candleSamples,
        atrPeriod: asPositiveInt(patch.supertrend?.atrPeriod) ?? currentStrategyConfig.supertrend.atrPeriod,
        multiplier: asNonNegativeNumber(patch.supertrend?.multiplier) ?? currentStrategyConfig.supertrend.multiplier,
      },
    };

    const nextServiceControl = {
      ...serviceControl,
      strategyUniverse: nextStrategyUniverse,
      strategyConfig: nextStrategyConfig,
      rotationState: {
        ...rotationState,
        activeStrategy: nextActiveStrategy,
        queuedStrategy: nextQueuedStrategy,
        rotationIntervalMinutes: asPositiveInt(patch.rotationIntervalMinutes) ?? rotationState.rotationIntervalMinutes ?? DEFAULT_ROTATION_INTERVAL_MINUTES,
      },
    };

    const updateResult = await client.query<AdminSessionRow>(
      `UPDATE sessions
          SET service_control = $2::jsonb
        WHERE id = $1
        RETURNING id, user_id, owner_wallet, session_wallet, requested_at, status, started_at, stop_reason, funding, service_control`,
      [sessionId, JSON.stringify(nextServiceControl)],
    );

    await client.query('COMMIT');

    const row = updateResult.rows[0];
    return {
      ...row,
      username: existing.username,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runtimeControlReady(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS runtime_control_settings (
      control_key TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

const hydrateRuntimeControl = (row: RuntimeControlRow | null) => {
  const speedProfile = normalizeRuntimeSpeedProfileName(
    typeof row?.state?.speedProfile === 'string' ? row.state.speedProfile : undefined,
  );
  const profile = getRuntimeSpeedProfile(speedProfile);
  const modeSource = row?.state?.modeSource === 'manual' ? 'manual' : 'auto';
  const recommendedProfile = normalizeRuntimeSpeedProfileName(
    typeof row?.state?.recommendedProfile === 'string' ? row.state.recommendedProfile : speedProfile,
  );
  const transitionReason =
    typeof row?.state?.transitionReason === 'string' ? row.state.transitionReason : null;
  const lastTransitionAt =
    typeof row?.state?.lastTransitionAt === 'string' ? row.state.lastTransitionAt : null;
  const pressure =
    row?.state?.pressure && typeof row.state.pressure === 'object'
      ? (row.state.pressure as Record<string, unknown>)
      : null;
  const entriesEnabled = row?.state?.entriesEnabled === false ? false : true;
  const maintenanceReason =
    typeof row?.state?.maintenanceReason === 'string' && row.state.maintenanceReason.trim().length > 0
      ? row.state.maintenanceReason.trim().slice(0, 160)
      : null;

  return {
    speedProfile,
    profile,
    modeSource,
    recommendedProfile,
    transitionReason,
    lastTransitionAt,
    pressure,
    entriesEnabled,
    maintenanceReason,
    updatedAt: row?.updated_at ?? new Date().toISOString(),
  };
};

async function getRuntimeControlState() {
  await runtimeControlReady();
  const result = await getPool().query<RuntimeControlRow>(
    `SELECT control_key, state, updated_at
       FROM runtime_control_settings
      WHERE control_key = $1
      LIMIT 1`,
    [RUNTIME_CONTROL_KEY],
  );

  const existing = result.rows[0] ?? null;
  if (existing) {
    return hydrateRuntimeControl(existing);
  }

  const speedProfile = normalizeRuntimeSpeedProfileName(process.env.WORKER_SPEED_PROFILE);
  const insertResult = await getPool().query<RuntimeControlRow>(
    `INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = runtime_control_settings.state
     RETURNING control_key, state, updated_at`,
    [RUNTIME_CONTROL_KEY, JSON.stringify({ speedProfile })],
  );

  return hydrateRuntimeControl(insertResult.rows[0] ?? null);
}

export async function getLiveRuntimeControlSnapshot() {
  const control = await getRuntimeControlState();
  const liveResult = await getPool().query<{ count: string }>(
    `SELECT count(DISTINCT user_id)::text AS count
       FROM sessions
      WHERE status IN ('active', 'starting')`,
  );
  const reservedResult = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM sessions
      WHERE status IN ('awaiting_funding', 'ready', 'starting', 'active', 'paused', 'stopping')`,
  );

  return {
    speedProfile: control.speedProfile,
    label: control.profile.label,
    concurrentCapacity: control.profile.concurrentCapacity,
    maxOpenPositions: control.profile.maxOpenPositions,
    modeSource: control.modeSource,
    recommendedProfile: control.recommendedProfile,
    recommendedLabel: getRuntimeSpeedProfile(control.recommendedProfile).label,
    transitionReason: control.transitionReason,
    lastTransitionAt: control.lastTransitionAt,
    pressure: control.pressure,
    entriesEnabled: control.entriesEnabled,
    maintenanceReason: control.maintenanceReason,
    cadenceMs: control.profile.cadenceMs,
    liveSessions: Number(liveResult.rows[0]?.count ?? '0'),
    reservedSessions: Number(reservedResult.rows[0]?.count ?? '0'),
    updatedAt: control.updatedAt,
  };
}

export async function setLiveRuntimeSpeedProfile(speedProfileInput: string) {
  await runtimeControlReady();
  const speedProfile = normalizeRuntimeSpeedProfileName(speedProfileInput);

  // Operator pin: override the profile and mark the mode manual, but merge so the
  // worker-written recommendation/pressure telemetry is preserved.
  await getPool().query(
    `INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = runtime_control_settings.state || EXCLUDED.state,
                   updated_at = NOW()`,
    [RUNTIME_CONTROL_KEY, JSON.stringify({ speedProfile, modeSource: 'manual' })],
  );

  return getLiveRuntimeControlSnapshot();
}

export async function setLiveRuntimeMode(modeInput: string) {
  await runtimeControlReady();
  const modeSource = modeInput === 'manual' ? 'manual' : 'auto';

  // Returning to auto hands fleet control back to the worker auto-shift loop;
  // merge so the current effective profile and telemetry are retained.
  await getPool().query(
    `INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = runtime_control_settings.state || EXCLUDED.state,
                   updated_at = NOW()`,
    [RUNTIME_CONTROL_KEY, JSON.stringify({ modeSource })],
  );

  return getLiveRuntimeControlSnapshot();
}

export async function setLiveRuntimeEntriesEnabled(entriesEnabledInput: unknown, reasonInput?: unknown) {
  await runtimeControlReady();
  const entriesEnabled = entriesEnabledInput !== false;
  const maintenanceReason = typeof reasonInput === 'string' && reasonInput.trim().length > 0
    ? reasonInput.trim().slice(0, 160)
    : (entriesEnabled ? null : 'deployment');

  await getPool().query(
    `INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = runtime_control_settings.state || EXCLUDED.state,
                   updated_at = NOW()`,
    [RUNTIME_CONTROL_KEY, JSON.stringify({ entriesEnabled, maintenanceReason })],
  );

  return getLiveRuntimeControlSnapshot();
}

type UniverseTableCandidate = {
  table_name: string;
};

const UNIVERSE_TABLE_CANDIDATES = [
  'rz_token_universe',
  'token_universe',
  'rz_token_universe',
];

const MINT_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
};

const isSafeSqlIdentifier = (value: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);

type WorkerRuntimeStateRow = {
  state: {
    status?: unknown;
    reason?: unknown;
    sourceTable?: unknown;
    candidateCount?: unknown;
    enabledCount?: unknown;
    lastRunAt?: unknown;
    top?: unknown;
  } | null;
};

type WorkerRuntimeHealthRow = {
  state: {
    mints?: Record<string, {
      deadRuns?: unknown;
      lastReason?: unknown;
      lastSeenAt?: unknown;
    }>;
  } | null;
};

export async function getTokenUniverseOverview(): Promise<TokenUniverseOverview> {
  const pool = getPool();

  const universeTableResult = await pool.query<UniverseTableCandidate>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [UNIVERSE_TABLE_CANDIDATES],
  );

  const selectedUniverseTable = universeTableResult.rows[0]?.table_name ?? null;

  let configuredTokens: Array<{
    mint: string;
    symbol: string | null;
    enabled: boolean;
    priority: number;
    notes: string | null;
  }> = [];

  if (selectedUniverseTable && isSafeSqlIdentifier(selectedUniverseTable)) {
    const selectedColumnsResult = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1`,
      [selectedUniverseTable],
    );
    const selectedColumns = new Set(selectedColumnsResult.rows.map((row) => row.column_name));
    const notesSelect = selectedColumns.has('notes')
      ? ', notes::text AS notes'
      : ', NULL::text AS notes';

    const configuredResult = await pool.query<{
      mint: string;
      symbol: string | null;
      enabled: boolean | null;
      priority: number | null;
      notes: string | null;
    }>(
      `SELECT
         COALESCE(mint::text, '') AS mint,
         symbol::text AS symbol,
         COALESCE(enabled, true) AS enabled,
         COALESCE(priority, 0) AS priority
         ${notesSelect}
       FROM public.${selectedUniverseTable}
       ORDER BY COALESCE(priority, 0) DESC, symbol ASC NULLS LAST`,
    );

    configuredTokens = configuredResult.rows
      .filter((row) => row.mint.length > 0)
      .map((row) => ({
        mint: row.mint,
        symbol: row.symbol,
        enabled: row.enabled ?? true,
        priority: row.priority ?? 0,
        notes: row.notes,
      }));
  }

  const tradeStatsResult = await pool.query<{
    mint: string;
    trade_count_7d: string;
    confirmed_trade_count_7d: string;
    last_traded_at: string | null;
  }>(
    `WITH expanded AS (
       SELECT
         unnest(ARRAY[input_mint, output_mint]) AS mint,
         status,
         COALESCE(confirmed_at, submitted_at, prepared_at, created_at) AS traded_at
       FROM swap_executions
       WHERE COALESCE(confirmed_at, submitted_at, prepared_at, created_at) >= NOW() - INTERVAL '7 days'
     )
     SELECT
       mint,
       count(*)::text AS trade_count_7d,
       count(*) FILTER (WHERE status = 'confirmed')::text AS confirmed_trade_count_7d,
       max(traded_at)::text AS last_traded_at
     FROM expanded
     GROUP BY mint`,
  ).catch(() => ({ rows: [] as Array<{
    mint: string;
    trade_count_7d: string;
    confirmed_trade_count_7d: string;
    last_traded_at: string | null;
  }> }));

  const activeTokensResult = await pool.query<{
    mint: string;
    active_session_count: string;
  }>(
    `WITH active_position_rows AS (
       SELECT
         jsonb_object_keys(COALESCE(service_control -> 'positionsState' -> 'positions', '{}'::jsonb)) AS mint
       FROM sessions
       WHERE status = 'active'

       UNION ALL

       SELECT
         CASE
           WHEN jsonb_object_length(COALESCE(service_control -> 'positionsState' -> 'positions', '{}'::jsonb)) = 0
             AND COALESCE(service_control -> 'positionState' ->> 'status', 'flat') IN ('long', 'long_sol')
             THEN COALESCE(service_control -> 'positionState' ->> 'positionMint', 'So11111111111111111111111111111111111111112')
           ELSE NULL
         END AS mint
       FROM sessions
       WHERE status = 'active'
     )
     SELECT
       mint,
       count(*)::text AS active_session_count
     FROM active_position_rows
     WHERE mint IS NOT NULL
     GROUP BY 1`,
  ).catch(() => ({ rows: [] as Array<{ mint: string; active_session_count: string }> }));

  const tradeStatsByMint = new Map(
    tradeStatsResult.rows.map((row) => [row.mint, {
      tradeCount7d: Number(row.trade_count_7d ?? '0'),
      confirmedTradeCount7d: Number(row.confirmed_trade_count_7d ?? '0'),
      lastTradedAt: row.last_traded_at,
    }]),
  );

  const activeByMint = new Map(
    activeTokensResult.rows
      .filter((row) => row.mint)
      .map((row) => [row.mint, Number(row.active_session_count ?? '0')]),
  );

  const configuredByMint = new Map(configuredTokens.map((token) => [token.mint, token]));
  const allMints = new Set<string>([
    ...configuredTokens.map((token) => token.mint),
    ...tradeStatsByMint.keys(),
    ...activeByMint.keys(),
  ]);

  const tokens: TokenUniverseTokenRow[] = [...allMints].map((mint) => {
    const configured = configuredByMint.get(mint);
    const trades = tradeStatsByMint.get(mint);
    const activeSessionCount = activeByMint.get(mint) ?? 0;

    return {
      mint,
      symbol: configured?.symbol ?? MINT_SYMBOLS[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
      enabled: configured?.enabled ?? true,
      priority: configured?.priority ?? 0,
      notes: configured?.notes ?? null,
      tradeCount7d: trades?.tradeCount7d ?? 0,
      confirmedTradeCount7d: trades?.confirmedTradeCount7d ?? 0,
      lastTradedAt: trades?.lastTradedAt ?? null,
      currentlyActive: activeSessionCount > 0,
    };
  }).sort((a, b) => {
    if (b.currentlyActive !== a.currentlyActive) return Number(b.currentlyActive) - Number(a.currentlyActive);
    if (b.confirmedTradeCount7d !== a.confirmedTradeCount7d) return b.confirmedTradeCount7d - a.confirmedTradeCount7d;
    if (b.tradeCount7d !== a.tradeCount7d) return b.tradeCount7d - a.tradeCount7d;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.symbol.localeCompare(b.symbol);
  });

  const bestToken = tokens.find((token) => token.confirmedTradeCount7d > 0)
    ?? tokens.find((token) => token.tradeCount7d > 0)
    ?? null;

  const activeTokens = [...activeByMint.entries()]
    .filter(([, count]) => count > 0)
    .map(([mint, count]) => ({
      mint,
      symbol: configuredByMint.get(mint)?.symbol ?? MINT_SYMBOLS[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
      activeSessionCount: count,
    }))
    .sort((a, b) => b.activeSessionCount - a.activeSessionCount);

  const autoSortResult = await pool.query<WorkerRuntimeStateRow>(
    `SELECT state
       FROM worker_runtime_state_cache
      WHERE state_key = $1
      LIMIT 1`,
    ['token_universe_autosort_v1'],
  ).catch(() => ({ rows: [] as WorkerRuntimeStateRow[] }));

  const autoSortState = autoSortResult.rows[0]?.state ?? null;
  const autoSortTopRaw = Array.isArray(autoSortState?.top) ? autoSortState?.top : [];
  const autoSortTop = autoSortTopRaw
    .map((entry) => {
      const record = entry as Record<string, unknown>;
      const mint = typeof record.mint === 'string' ? record.mint : null;
      const rank = Number(record.rank ?? 0);
      const score = Number(record.score ?? 0);
      const momentumBps = Number(record.momentumBps ?? 0);
      const priceImpactBps = record.priceImpactBps === null || record.priceImpactBps === undefined
        ? null
        : Number(record.priceImpactBps);
      const routeFound = record.routeFound === true;

      if (!mint || !Number.isFinite(rank) || !Number.isFinite(score) || !Number.isFinite(momentumBps)) {
        return null;
      }

      return {
        rank,
        mint,
        symbol: configuredByMint.get(mint)?.symbol ?? MINT_SYMBOLS[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
        score,
        momentumBps,
        priceImpactBps: priceImpactBps !== null && Number.isFinite(priceImpactBps) ? priceImpactBps : null,
        routeFound,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 5);

  const scannerRunResult = await pool.query<{
    id: string;
    status: string;
    reason: string | null;
    candidate_count: number | string;
    accepted_count: number | string;
    rejected_count: number | string;
    provider_cost_estimate: number | string;
    finished_at: string;
  }>(
    `SELECT id, status, reason, candidate_count, accepted_count, rejected_count, provider_cost_estimate, finished_at::text AS finished_at
       FROM public.market_scanner_runs
      WHERE scanner_name = 'token_universe_autosort'
      ORDER BY finished_at DESC
      LIMIT 1`,
  ).catch(() => ({ rows: [] as Array<{
    id: string;
    status: string;
    reason: string | null;
    candidate_count: number | string;
    accepted_count: number | string;
    rejected_count: number | string;
    provider_cost_estimate: number | string;
    finished_at: string;
  }> }));

  const latestScannerRun = scannerRunResult.rows[0] ?? null;
  const scannerCandidatesResult = latestScannerRun
    ? await pool.query<{
      output_mint: string;
      output_symbol: string | null;
      status: string;
      signal_score: number | string | null;
      route_quality: number | string | null;
      slippage_bps: number | string | null;
      valid_until: string;
      risk_flags: unknown;
    }>(
      `SELECT output_mint, output_symbol, status, signal_score, route_quality, slippage_bps, valid_until::text AS valid_until, risk_flags
         FROM public.market_candidates
        WHERE scanner_run_id = $1
        ORDER BY status ASC, route_quality DESC NULLS LAST
        LIMIT 20`,
      [latestScannerRun.id],
    ).catch(() => ({ rows: [] as Array<{
      output_mint: string;
      output_symbol: string | null;
      status: string;
      signal_score: number | string | null;
      route_quality: number | string | null;
      slippage_bps: number | string | null;
      valid_until: string;
      risk_flags: unknown;
    }> }))
    : { rows: [] as Array<{
      output_mint: string;
      output_symbol: string | null;
      status: string;
      signal_score: number | string | null;
      route_quality: number | string | null;
      slippage_bps: number | string | null;
      valid_until: string;
      risk_flags: unknown;
    }> };

  const admissionResult = await pool.query<{
    mint: string;
    symbol: string;
    bucket: string | null;
    status: string;
    priority: number | null;
    successful_quote_count: number | string | null;
    max_impact_bps: number | string | null;
    risk_flags: unknown;
    observed_at: string;
  }>(
    `SELECT mint, symbol, bucket, status, priority, successful_quote_count, max_impact_bps, risk_flags, observed_at::text AS observed_at
       FROM public.token_admission_candidates
      ORDER BY COALESCE(priority, 0) DESC, observed_at DESC
      LIMIT 40`,
  ).catch(() => ({ rows: [] as Array<{
    mint: string;
    symbol: string;
    bucket: string | null;
    status: string;
    priority: number | null;
    successful_quote_count: number | string | null;
    max_impact_bps: number | string | null;
    risk_flags: unknown;
    observed_at: string;
  }> }));

  const admissionCandidates = admissionResult.rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol,
    bucket: row.bucket ?? 'unknown',
    status: row.status,
    priority: Number(row.priority ?? 0),
    successfulQuoteCount: Number(row.successful_quote_count ?? 0),
    maxImpactBps: Number(row.max_impact_bps ?? 0),
    riskFlags: Array.isArray(row.risk_flags)
      ? row.risk_flags.filter((value): value is string => typeof value === 'string')
      : [],
    observedAt: row.observed_at,
  }));

  const healthStateResult = await pool.query<WorkerRuntimeHealthRow>(
    `SELECT state
       FROM worker_runtime_state_cache
      WHERE state_key = $1
      LIMIT 1`,
    ['token_universe_health_v1'],
  ).catch(() => ({ rows: [] as WorkerRuntimeHealthRow[] }));

  const healthMintsRaw = healthStateResult.rows[0]?.state?.mints ?? {};
  const healthEntries = Object.entries(healthMintsRaw)
    .map(([mint, value]) => {
      const rawDeadRuns = Number(value?.deadRuns ?? 0);
      const deadRuns = Number.isFinite(rawDeadRuns) ? Math.max(0, Math.floor(rawDeadRuns)) : 0;
      const lastReason = typeof value?.lastReason === 'string' ? value.lastReason : null;
      const lastSeenAt = typeof value?.lastSeenAt === 'string' ? value.lastSeenAt : null;
      return {
        mint,
        symbol: configuredByMint.get(mint)?.symbol ?? MINT_SYMBOLS[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
        deadRuns,
        lastReason,
        lastSeenAt,
      };
    })
    .filter((entry) => entry.lastSeenAt !== null)
    .sort((a, b) => {
      if (b.deadRuns !== a.deadRuns) return b.deadRuns - a.deadRuns;
      return Date.parse(b.lastSeenAt ?? '') - Date.parse(a.lastSeenAt ?? '');
    });

  const deadletterColumnsResult = await pool.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'rz_token_universe_deadletter'`,
  ).catch(() => ({ rows: [] as Array<{ column_name: string }> }));

  const deadletterColumns = new Set(deadletterColumnsResult.rows.map((row) => row.column_name));
  const deadletterHasTable = deadletterColumns.size > 0;
  const hasRecoveredAt = deadletterColumns.has('recovered_at');

  const deadletterRows = deadletterHasTable
    ? await pool.query<{
      mint: string;
      symbol: string | null;
      reason: string;
      dead_runs: number;
      dumped_at: string;
      recovered_at: string | null;
      score: number | null;
      momentum_bps: number | null;
      price_impact_bps: number | null;
    }>(
      hasRecoveredAt
        ? `SELECT mint, symbol, reason, dead_runs, dumped_at, recovered_at, score, momentum_bps, price_impact_bps
             FROM public.rz_token_universe_deadletter
            ORDER BY dumped_at DESC
            LIMIT 50`
        : `SELECT mint, symbol, reason, dead_runs, dumped_at, NULL::text AS recovered_at, score, momentum_bps, price_impact_bps
             FROM public.rz_token_universe_deadletter
            ORDER BY dumped_at DESC
            LIMIT 50`,
    ).catch(() => ({ rows: [] as Array<{
      mint: string;
      symbol: string | null;
      reason: string;
      dead_runs: number;
      dumped_at: string;
      recovered_at: string | null;
      score: number | null;
      momentum_bps: number | null;
      price_impact_bps: number | null;
    }> }))
    : { rows: [] as Array<{
      mint: string;
      symbol: string | null;
      reason: string;
      dead_runs: number;
      dumped_at: string;
      recovered_at: string | null;
      score: number | null;
      momentum_bps: number | null;
      price_impact_bps: number | null;
    }> };

  const deadletterRecent = deadletterRows.rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol ?? configuredByMint.get(row.mint)?.symbol ?? MINT_SYMBOLS[row.mint] ?? `${row.mint.slice(0, 4)}…${row.mint.slice(-4)}`,
    reason: row.reason,
    deadRuns: Number(row.dead_runs ?? 0),
    dumpedAt: row.dumped_at,
    recoveredAt: row.recovered_at,
    score: row.score,
    momentumBps: row.momentum_bps,
    priceImpactBps: row.price_impact_bps,
  }));

  const deadletterOpenCount = deadletterRecent.filter((row) => !row.recoveredAt).length;
  const deadletterRecoveredCount = deadletterRecent.filter((row) => !!row.recoveredAt).length;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      configuredTokens: configuredTokens.length,
      enabledTokens: configuredTokens.filter((token) => token.enabled).length,
      activelyHeldTokens: activeTokens.length,
      tradedTokens7d: tokens.filter((token) => token.tradeCount7d > 0).length,
    },
    bestToken: bestToken
      ? {
          mint: bestToken.mint,
          symbol: bestToken.symbol,
          tradeCount7d: bestToken.tradeCount7d,
          confirmedTradeCount7d: bestToken.confirmedTradeCount7d,
          currentlyActive: bestToken.currentlyActive,
        }
      : null,
        autoSort: {
          status: autoSortState?.status === 'applied' || autoSortState?.status === 'skipped'
            ? autoSortState.status
            : 'unknown',
          reason: typeof autoSortState?.reason === 'string' ? autoSortState.reason : null,
          sourceTable: typeof autoSortState?.sourceTable === 'string' ? autoSortState.sourceTable : null,
          candidateCount: Number(autoSortState?.candidateCount ?? 0),
          enabledCount: Number(autoSortState?.enabledCount ?? 0),
          lastRunAt: typeof autoSortState?.lastRunAt === 'string' ? autoSortState.lastRunAt : null,
          top: autoSortTop,
        },
    scanner: {
      latestRun: latestScannerRun
        ? {
            id: latestScannerRun.id,
            status: latestScannerRun.status,
            reason: latestScannerRun.reason,
            candidateCount: Number(latestScannerRun.candidate_count ?? 0),
            acceptedCount: Number(latestScannerRun.accepted_count ?? 0),
            rejectedCount: Number(latestScannerRun.rejected_count ?? 0),
            providerCostEstimate: Number(latestScannerRun.provider_cost_estimate ?? 0),
            finishedAt: latestScannerRun.finished_at,
          }
        : null,
      activeCandidates: scannerCandidatesResult.rows.map((row) => {
        const riskFlags = Array.isArray(row.risk_flags)
          ? row.risk_flags.filter((value): value is string => typeof value === 'string')
          : [];
        return {
          mint: row.output_mint,
          symbol: row.output_symbol ?? configuredByMint.get(row.output_mint)?.symbol ?? MINT_SYMBOLS[row.output_mint] ?? `${row.output_mint.slice(0, 4)}…${row.output_mint.slice(-4)}`,
          status: row.status,
          signalScore: row.signal_score === null ? null : Number(row.signal_score),
          routeQuality: row.route_quality === null ? null : Number(row.route_quality),
          slippageBps: row.slippage_bps === null ? null : Number(row.slippage_bps),
          validUntil: row.valid_until,
          riskFlags,
        };
      }),
    },
    admission: {
      summary: {
        total: admissionCandidates.length,
        admitted: admissionCandidates.filter((candidate) => candidate.status === 'admitted').length,
        rejected: admissionCandidates.filter((candidate) => candidate.status === 'rejected').length,
        latestObservedAt: admissionCandidates.reduce<string | null>((latest, candidate) => {
          if (!latest) return candidate.observedAt;
          return Date.parse(candidate.observedAt) > Date.parse(latest) ? candidate.observedAt : latest;
        }, null),
      },
      candidates: admissionCandidates,
    },
    health: {
      trackedMints: healthEntries.length,
      activeDeadCandidates: healthEntries.filter((entry) => entry.deadRuns > 0).length,
      topDead: healthEntries
        .filter((entry) => entry.deadRuns > 0)
        .slice(0, 10)
        .map((entry) => ({
          mint: entry.mint,
          symbol: entry.symbol,
          deadRuns: entry.deadRuns,
          lastReason: entry.lastReason,
          lastSeenAt: entry.lastSeenAt ?? new Date().toISOString(),
        })),
    },
    deadletter: {
      openCount: deadletterOpenCount,
      recoveredCount: deadletterRecoveredCount,
      recent: deadletterRecent,
    },
    activeTokens,
    tokens,
  };
}
