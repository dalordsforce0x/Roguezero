import {
  getRuntimeSpeedProfile,
  normalizeRuntimeSpeedProfileName,
  type RuntimeSpeedProfileName,
} from '@roguezero/runtime-config';
import { getPool } from './sessionStore.js';

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

const CONTROL_KEY = 'global_live_runtime';
let readyPromise: Promise<void> | null = null;

export type RuntimeControlState = {
  speedProfile: RuntimeSpeedProfileName;
  modeSource: 'auto' | 'manual';
  recommendedProfile: RuntimeSpeedProfileName;
  transitionReason: string | null;
  lastTransitionAt: string | null;
  pressure: Record<string, unknown> | null;
  entriesEnabled: boolean;
  maintenanceReason: string | null;
  updatedAt: string;
  profile: ReturnType<typeof getRuntimeSpeedProfile>;
};

export const runtimeControlStoreReady = async () => {
  if (!readyPromise) {
    readyPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS runtime_control_settings (
        control_key TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => undefined);
  }

  return readyPromise;
};

const hydrateRuntimeControlState = (row: RuntimeControlRow | null): RuntimeControlState => {
  const speedProfile = normalizeRuntimeSpeedProfileName(
    typeof row?.state?.speedProfile === 'string' ? row.state.speedProfile : undefined,
  );
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
    modeSource,
    recommendedProfile,
    transitionReason,
    lastTransitionAt,
    pressure,
    entriesEnabled,
    maintenanceReason,
    updatedAt: row?.updated_at ?? new Date().toISOString(),
    profile: getRuntimeSpeedProfile(speedProfile, process.env),
  };
};

export const getLiveRuntimeControl = async (): Promise<RuntimeControlState> => {
  await runtimeControlStoreReady();
  const dbPool = getPool();
  const result = await dbPool.query<RuntimeControlRow>(
    `SELECT control_key, state, updated_at
       FROM runtime_control_settings
      WHERE control_key = $1
      LIMIT 1`,
    [CONTROL_KEY],
  );

  const existing = result.rows[0] ?? null;
  if (existing) {
    return hydrateRuntimeControlState(existing);
  }

  const defaultState = {
    speedProfile: normalizeRuntimeSpeedProfileName(process.env.WORKER_SPEED_PROFILE),
  };

  const insertResult = await dbPool.query<RuntimeControlRow>(
    `INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = runtime_control_settings.state
     RETURNING control_key, state, updated_at`,
    [CONTROL_KEY, JSON.stringify(defaultState)],
  );

  return hydrateRuntimeControlState(insertResult.rows[0] ?? null);
};

export const setLiveRuntimeSpeedProfile = async (speedProfileInput: string): Promise<RuntimeControlState> => {
  await runtimeControlStoreReady();
  const dbPool = getPool();
  const speedProfile = normalizeRuntimeSpeedProfileName(speedProfileInput);

  const result = await dbPool.query<RuntimeControlRow>(
    `INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = runtime_control_settings.state || EXCLUDED.state,
                   updated_at = NOW()
     RETURNING control_key, state, updated_at`,
    [CONTROL_KEY, JSON.stringify({ speedProfile, modeSource: 'manual' })],
  );

  return hydrateRuntimeControlState(result.rows[0] ?? null);
};

export const setLiveRuntimeMode = async (modeInput: string): Promise<RuntimeControlState> => {
  await runtimeControlStoreReady();
  const dbPool = getPool();
  const modeSource = modeInput === 'manual' ? 'manual' : 'auto';

  const result = await dbPool.query<RuntimeControlRow>(
    `INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = runtime_control_settings.state || EXCLUDED.state,
                   updated_at = NOW()
     RETURNING control_key, state, updated_at`,
    [CONTROL_KEY, JSON.stringify({ modeSource })],
  );

  return hydrateRuntimeControlState(result.rows[0] ?? null);
};

export const setLiveRuntimeEntriesEnabled = async (
  entriesEnabledInput: unknown,
  reasonInput?: unknown,
): Promise<RuntimeControlState> => {
  await runtimeControlStoreReady();
  const dbPool = getPool();
  const entriesEnabled = entriesEnabledInput !== false;
  const maintenanceReason = typeof reasonInput === 'string' && reasonInput.trim().length > 0
    ? reasonInput.trim().slice(0, 160)
    : (entriesEnabled ? null : 'deployment');

  const result = await dbPool.query<RuntimeControlRow>(
    `INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = runtime_control_settings.state || EXCLUDED.state,
                   updated_at = NOW()
     RETURNING control_key, state, updated_at`,
    [CONTROL_KEY, JSON.stringify({ entriesEnabled, maintenanceReason })],
  );

  return hydrateRuntimeControlState(result.rows[0] ?? null);
};
