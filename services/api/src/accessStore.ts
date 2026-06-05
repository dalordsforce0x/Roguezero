import { getPool } from './sessionStore.js';

type AccessUserRow = {
  id: string;
  username: string;
  wallet_address: string;
  license_key: string | null;
  expiry_date: string | null;
  access_enabled: boolean;
  max_wallet_usd: number;
  duration: string | null;
  gated_access_enrolled_at: string | null;
  license_key_revealed_at: string | null;
};

type TrustedDeviceRow = {
  device_id_hash: string;
  user_id: string;
  enrolled_at: string;
  last_seen_at: string;
};

type WebAccessSessionRow = {
  token_hash: string;
  user_id: string;
  device_id_hash: string;
  access_mode: 'trusted_device' | 'license_key' | 'live_session_bypass';
  trusted_until: string;
  created_at: string;
  last_seen_at: string;
};

export type AccessUser = {
  id: string;
  username: string;
  walletAddress: string;
  expiryDate: string | null;
  accessEnabled: boolean;
  maxWalletUsd: number;
  duration: string | null;
  gatedAccessEnrolledAt: string | null;
  licenseKeyRevealedAt: string | null;
};

export type TrustedDeviceEnrollment = {
  deviceIdHash: string;
  userId: string;
  enrolledAt: string;
  lastSeenAt: string;
};

export type WebAccessSession = {
  tokenHash: string;
  userId: string;
  deviceIdHash: string;
  accessMode: 'trusted_device' | 'license_key' | 'live_session_bypass';
  trustedUntil: string;
  createdAt: string;
  lastSeenAt: string;
};

let readyPromise: Promise<void> | null = null;

const mapAccessUser = (row: AccessUserRow): AccessUser => ({
  id: row.id,
  username: row.username,
  walletAddress: row.wallet_address,
  expiryDate: row.expiry_date,
  accessEnabled: row.access_enabled,
  maxWalletUsd: row.max_wallet_usd,
  duration: row.duration,
  gatedAccessEnrolledAt: row.gated_access_enrolled_at,
  licenseKeyRevealedAt: row.license_key_revealed_at,
});

const mapTrustedDevice = (row: TrustedDeviceRow): TrustedDeviceEnrollment => ({
  deviceIdHash: row.device_id_hash,
  userId: row.user_id,
  enrolledAt: row.enrolled_at,
  lastSeenAt: row.last_seen_at,
});

const mapWebAccessSession = (row: WebAccessSessionRow): WebAccessSession => ({
  tokenHash: row.token_hash,
  userId: row.user_id,
  deviceIdHash: row.device_id_hash,
  accessMode: row.access_mode,
  trustedUntil: row.trusted_until,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

const isLicenseExpired = (expiryDate: string | null | undefined) => (
  Boolean(expiryDate) && new Date(expiryDate as string) < new Date()
);

const assertUserAccess = (user: AccessUserRow | null) => {
  if (!user) {
    throw new Error('User not found');
  }

  if (!user.access_enabled) {
    throw new Error('Access disabled');
  }

  if (isLicenseExpired(user.expiry_date)) {
    throw new Error('License expired');
  }

  if (!user.license_key) {
    throw new Error('License key not assigned');
  }

  return user;
};

export const accessTablesReady = async () => {
  if (!readyPromise) {
    const dbPool = getPool();
    readyPromise = dbPool.query(`
      ALTER TABLE rz_users
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS max_wallet_usd INTEGER NOT NULL DEFAULT 10000,
        ADD COLUMN IF NOT EXISTS gated_access_enrolled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS license_key_revealed_at TIMESTAMPTZ;
    `)
      .then(() => dbPool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS rz_users_license_key_unique
        ON rz_users (license_key)
        WHERE license_key IS NOT NULL;
      `))
      .then(() => dbPool.query(`
        CREATE TABLE IF NOT EXISTS trusted_web_devices (
          device_id_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS trusted_web_devices_user_idx
        ON trusted_web_devices (user_id);
      `))
      .then(() => dbPool.query(`
        CREATE TABLE IF NOT EXISTS web_access_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          device_id_hash TEXT NOT NULL,
          access_mode TEXT NOT NULL,
          trusted_until TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (access_mode IN ('trusted_device', 'license_key', 'live_session_bypass'))
        );
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS web_access_sessions_user_idx
        ON web_access_sessions (user_id);
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS web_access_sessions_device_idx
        ON web_access_sessions (device_id_hash);
      `))
      .then(() => undefined);
  }

  return readyPromise;
};

export const getAccessUserByWallet = async (walletAddress: string) => {
  await accessTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<AccessUserRow>(
      `SELECT id, username, wallet_address, license_key, expiry_date, access_enabled,
        COALESCE(max_wallet_usd, 10000)::integer AS max_wallet_usd,
        duration,
            gated_access_enrolled_at, license_key_revealed_at
       FROM rz_users
      WHERE wallet_address = $1
      LIMIT 1`,
    [walletAddress],
  );

  return result.rows[0] ? mapAccessUser(result.rows[0]) : null;
};

export const getAccessUserByLicenseKey = async (licenseKey: string) => {
  await accessTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<AccessUserRow>(
      `SELECT id, username, wallet_address, license_key, expiry_date, access_enabled,
        COALESCE(max_wallet_usd, 10000)::integer AS max_wallet_usd,
        duration,
            gated_access_enrolled_at, license_key_revealed_at
       FROM rz_users
      WHERE license_key = $1
      LIMIT 1`,
    [licenseKey],
  );

  return result.rows[0] ? mapAccessUser(result.rows[0]) : null;
};

export const getTrustedDeviceEnrollment = async (deviceIdHash: string) => {
  await accessTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<TrustedDeviceRow>(
    `SELECT device_id_hash, user_id, enrolled_at, last_seen_at
       FROM trusted_web_devices
      WHERE device_id_hash = $1
      LIMIT 1`,
    [deviceIdHash],
  );

  return result.rows[0] ? mapTrustedDevice(result.rows[0]) : null;
};

export const getLiveSessionCountForUser = async (userId: string) => {
  await accessTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM sessions
      WHERE user_id = $1
        AND status IN ('awaiting_funding', 'ready', 'starting', 'active', 'paused', 'stopping')`,
    [userId],
  );

  return Number(result.rows[0]?.count ?? '0');
};

export const enrollTrustedDeviceForWallet = async (walletAddress: string, deviceIdHash: string) => {
  await accessTablesReady();
  const dbPool = getPool();
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query<AccessUserRow>(
          `SELECT id, username, wallet_address, license_key, expiry_date, access_enabled,
            COALESCE(max_wallet_usd, 10000)::integer AS max_wallet_usd,
            duration,
              gated_access_enrolled_at, license_key_revealed_at
         FROM rz_users
        WHERE wallet_address = $1
        LIMIT 1
        FOR UPDATE`,
      [walletAddress],
    );

    const user = assertUserAccess(userResult.rows[0] ?? null);
    const firstReveal = user.license_key_revealed_at === null;
    const now = new Date().toISOString();

    const updatedUserResult = await client.query<AccessUserRow>(
      `UPDATE rz_users
          SET gated_access_enrolled_at = COALESCE(gated_access_enrolled_at, $2::timestamptz),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, username, wallet_address, license_key, expiry_date, access_enabled,
                  COALESCE(max_wallet_usd, 10000)::integer AS max_wallet_usd,
                  duration,
                  gated_access_enrolled_at, license_key_revealed_at`,
      [user.id, now],
    );

    await client.query(
      `INSERT INTO trusted_web_devices (device_id_hash, user_id, enrolled_at, last_seen_at)
       VALUES (
         $1,
         $2,
         COALESCE((SELECT gated_access_enrolled_at FROM rz_users WHERE id::text = $2), now()),
         now()
       )
       ON CONFLICT (device_id_hash)
       DO UPDATE SET user_id = EXCLUDED.user_id, last_seen_at = now()`,
      [deviceIdHash, user.id],
    );

    await client.query('COMMIT');

    return {
      user: mapAccessUser(updatedUserResult.rows[0]),
      licenseKey: firstReveal ? user.license_key : null,
      firstReveal,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const acknowledgeLicenseKeyReveal = async (userId: string) => {
  await accessTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<AccessUserRow>(
    `UPDATE rz_users
        SET license_key_revealed_at = COALESCE(license_key_revealed_at, NOW()),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, username, wallet_address, license_key, expiry_date, access_enabled,
                COALESCE(max_wallet_usd, 10000)::integer AS max_wallet_usd,
                duration,
                gated_access_enrolled_at, license_key_revealed_at`,
    [userId],
  );

  return result.rows[0] ? mapAccessUser(result.rows[0]) : null;
};

export const verifyTrustedDeviceLicense = async (licenseKey: string, deviceIdHash: string) => {
  await accessTablesReady();
  const dbPool = getPool();
  const device = await getTrustedDeviceEnrollment(deviceIdHash);
  if (!device) {
    throw new Error('Trusted device enrollment not found');
  }

  const result = await dbPool.query<AccessUserRow>(
      `SELECT id, username, wallet_address, license_key, expiry_date, access_enabled,
        COALESCE(max_wallet_usd, 10000)::integer AS max_wallet_usd,
        duration,
            gated_access_enrolled_at, license_key_revealed_at
       FROM rz_users
      WHERE license_key = $1
      LIMIT 1`,
    [licenseKey],
  );

  const user = assertUserAccess(result.rows[0] ?? null);

  if (user.id !== device.userId) {
    throw new Error('License key does not match the enrolled device');
  }

  await dbPool.query(
    `UPDATE trusted_web_devices
        SET last_seen_at = NOW()
      WHERE device_id_hash = $1`,
    [deviceIdHash],
  );

  return mapAccessUser(user);
};

export const createWebAccessSession = async (params: {
  tokenHash: string;
  userId: string;
  deviceIdHash: string;
  accessMode: WebAccessSession['accessMode'];
  trustedUntil: string;
}) => {
  await accessTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<WebAccessSessionRow>(
    `INSERT INTO web_access_sessions (token_hash, user_id, device_id_hash, access_mode, trusted_until, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, NOW(), NOW())
     ON CONFLICT (token_hash)
     DO UPDATE SET user_id = EXCLUDED.user_id,
                   device_id_hash = EXCLUDED.device_id_hash,
                   access_mode = EXCLUDED.access_mode,
                   trusted_until = EXCLUDED.trusted_until,
                   last_seen_at = NOW()
     RETURNING token_hash, user_id, device_id_hash, access_mode, trusted_until, created_at, last_seen_at`,
    [params.tokenHash, params.userId, params.deviceIdHash, params.accessMode, params.trustedUntil],
  );

  return mapWebAccessSession(result.rows[0]);
};

export const verifyWebAccessSession = async (tokenHash: string, deviceIdHash: string) => {
  await accessTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<WebAccessSessionRow>(
    `SELECT token_hash, user_id, device_id_hash, access_mode, trusted_until, created_at, last_seen_at
       FROM web_access_sessions
      WHERE token_hash = $1
        AND device_id_hash = $2
      LIMIT 1`,
    [tokenHash, deviceIdHash],
  );

  const row = result.rows[0] ?? null;
  if (!row) {
    return null;
  }

  if (new Date(row.trusted_until) <= new Date()) {
    await dbPool.query('DELETE FROM web_access_sessions WHERE token_hash = $1', [tokenHash]);
    return null;
  }

  await dbPool.query(
    `UPDATE web_access_sessions
        SET last_seen_at = NOW()
      WHERE token_hash = $1`,
    [tokenHash],
  );

  return mapWebAccessSession(row);
};
