import { getPool } from './sessionStore.js';

type ManagerRow = {
  id: string;
  name: string;
  management_key: string | null;
  duration: string | null;
  expiry_date: string | null;
  access_enabled: boolean;
};

export type Manager = {
  id: string;
  name: string;
  duration: string | null;
  expiryDate: string | null;
  accessEnabled: boolean;
  maskedKey: string | null;
};

export type ManagerScopedGroup = {
  id: string;
  name: string;
  botLimit: number;
};

export type ManagerScopedUser = {
  id: string;
  username: string;
  walletAddress: string;
  groupId: string | null;
  groupName: string | null;
  accessEnabled: boolean;
  expiryDate: string | null;
  maxWalletUsd: number;
};

let readyPromise: Promise<void> | null = null;

const maskManagementKey = (key: string | null): string | null => {
  if (!key) return null;
  // The RZer0BotLord prefix is shared across all manager keys (not secret); the
  // remainder is masked down to the last 4 chars so the header can identify the
  // active license without ever exposing the full credential.
  const tail = key.slice(-4);
  return `RZer0BotLord…${tail}`;
};

const mapManager = (row: ManagerRow): Manager => ({
  id: row.id,
  name: row.name,
  duration: row.duration,
  expiryDate: row.expiry_date,
  accessEnabled: row.access_enabled,
  maskedKey: maskManagementKey(row.management_key),
});

const isExpired = (expiryDate: string | null | undefined) => (
  Boolean(expiryDate) && new Date(expiryDate as string) < new Date()
);

const assertManagerAccess = (row: ManagerRow | null): ManagerRow => {
  if (!row) {
    throw new Error('Manager not found');
  }
  if (!row.access_enabled) {
    throw new Error('Access disabled');
  }
  if (isExpired(row.expiry_date)) {
    throw new Error('License expired');
  }
  if (!row.management_key) {
    throw new Error('License key not assigned');
  }
  return row;
};

export const managerTablesReady = async () => {
  if (!readyPromise) {
    const dbPool = getPool();
    readyPromise = dbPool.query(`
      CREATE TABLE IF NOT EXISTS rz_managers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        management_key TEXT UNIQUE,
        duration TEXT,
        expiry_date TIMESTAMPTZ,
        access_enabled BOOLEAN NOT NULL DEFAULT false,
        key_revealed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
      .then(() => dbPool.query(`
        ALTER TABLE rz_user_groups
          ADD COLUMN IF NOT EXISTS manager_id UUID;
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS rz_managers_key_idx ON rz_managers (management_key);
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS rz_user_groups_manager_idx ON rz_user_groups (manager_id);
      `))
      .then(() => undefined);
  }

  return readyPromise;
};

/**
 * Validate a management key. Throws if the manager is missing, disabled,
 * expired, or has no key assigned. Returns the manager identity on success.
 */
export const verifyManagerLicense = async (managementKey: string): Promise<Manager> => {
  await managerTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<ManagerRow>(
    `SELECT id, name, management_key, duration, expiry_date, access_enabled
       FROM rz_managers
      WHERE management_key = $1
      LIMIT 1`,
    [managementKey],
  );

  const manager = assertManagerAccess(result.rows[0] ?? null);
  return mapManager(manager);
};

export const getManagerById = async (managerId: string): Promise<Manager | null> => {
  await managerTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<ManagerRow>(
    `SELECT id, name, management_key, duration, expiry_date, access_enabled
       FROM rz_managers
      WHERE id = $1
      LIMIT 1`,
    [managerId],
  );
  return result.rows[0] ? mapManager(result.rows[0]) : null;
};

/** Groups bound to this manager (group -> manager is 1:N). */
export const getGroupsForManager = async (managerId: string): Promise<ManagerScopedGroup[]> => {
  await managerTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<{ id: string; name: string; bot_limit: number }>(
    `SELECT id, name, bot_limit
       FROM rz_user_groups
      WHERE manager_id = $1
      ORDER BY name ASC`,
    [managerId],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, botLimit: row.bot_limit }));
};

/** All users across all groups bound to this manager. */
export const getUsersForManager = async (managerId: string): Promise<ManagerScopedUser[]> => {
  await managerTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<{
    id: string;
    username: string;
    wallet_address: string;
    group_id: string | null;
    group_name: string | null;
    access_enabled: boolean;
    expiry_date: string | null;
    max_wallet_usd: number;
  }>(
    `SELECT u.id, u.username, u.wallet_address, u.group_id, g.name AS group_name,
            u.access_enabled, u.expiry_date,
            COALESCE(u.max_wallet_usd, 10000)::integer AS max_wallet_usd
       FROM rz_users u
       JOIN rz_user_groups g ON g.id = u.group_id
      WHERE g.manager_id = $1
      ORDER BY g.name ASC, u.username ASC`,
    [managerId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    username: row.username,
    walletAddress: row.wallet_address,
    groupId: row.group_id,
    groupName: row.group_name,
    accessEnabled: row.access_enabled,
    expiryDate: row.expiry_date,
    maxWalletUsd: row.max_wallet_usd,
  }));
};

/**
 * Authorization guard: returns true only if the given user belongs to a group
 * bound to this manager. Every manager action on a user/session MUST pass this.
 */
export const managerCanAccessUser = async (managerId: string, userId: string): Promise<boolean> => {
  await managerTablesReady();
  const dbPool = getPool();
  const result = await dbPool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM rz_users u
         JOIN rz_user_groups g ON g.id = u.group_id
        WHERE u.id = $1
          AND g.manager_id = $2
     ) AS exists`,
    [userId, managerId],
  );
  return Boolean(result.rows[0]?.exists);
};
