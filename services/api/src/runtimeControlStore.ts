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
  } | null;
  updated_at: string;
};

const CONTROL_KEY = 'global_live_runtime';
let readyPromise: Promise<void> | null = null;

export type RuntimeControlState = {
  speedProfile: RuntimeSpeedProfileName;
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

  return {
    speedProfile,
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
     DO UPDATE SET state = EXCLUDED.state,
                   updated_at = NOW()
     RETURNING control_key, state, updated_at`,
    [CONTROL_KEY, JSON.stringify({ speedProfile })],
  );

  return hydrateRuntimeControlState(result.rows[0] ?? null);
};
