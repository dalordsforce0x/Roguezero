import { Pool } from 'pg';

let pool: Pool | null = null;

const getDatabaseConnectionUrl = () => {
  const privateUrl = process.env.DATABASE_PRIVATE_URL?.trim();
  if (privateUrl) {
    return privateUrl;
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
  license_key: string | null;
  expiry_date: string | null;
  access_enabled: boolean;
  duration: string | null;
  gated_access_enrolled_at: string | null;
  license_key_revealed_at: string | null;
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
      duration TEXT,
      gated_access_enrolled_at TIMESTAMPTZ,
      license_key_revealed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE rz_users
      ADD COLUMN IF NOT EXISTS gated_access_enrolled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS license_key_revealed_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS rz_users_wallet_idx ON rz_users(wallet_address);
  `);
}

export async function listUsers(): Promise<RzUser[]> {
  const { rows } = await getPool().query<RzUser>(
    'SELECT * FROM rz_users ORDER BY created_at DESC'
  );
  return rows;
}

export async function createUser(
  username: string,
  walletAddress: string,
  duration: string
): Promise<RzUser> {
  const { rows } = await getPool().query<RzUser>(
    `INSERT INTO rz_users (username, wallet_address, duration)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [username, walletAddress, duration]
  );
  return rows[0];
}

export async function getUserById(id: string): Promise<RzUser | null> {
  const { rows } = await getPool().query<RzUser>(
    'SELECT * FROM rz_users WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

export async function getUserByWallet(walletAddress: string): Promise<RzUser | null> {
  const { rows } = await getPool().query<RzUser>(
    'SELECT * FROM rz_users WHERE wallet_address = $1',
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

export async function listActiveSessions(): Promise<AdminSessionRow[]> {
  const { rows } = await getPool().query<AdminSessionRow>(
    `SELECT s.id, s.user_id, u.username, s.owner_wallet, s.session_wallet, s.requested_at, s.status, s.started_at, s.stop_reason, s.funding, s.service_control
     FROM sessions s
     INNER JOIN rz_users u ON u.id = s.user_id
     WHERE s.status NOT IN ('stopped', 'error')
     ORDER BY s.requested_at DESC
     LIMIT 50`
  );
  return rows;
}

export async function forceStopSession(sessionId: string): Promise<AdminSessionRow | null> {
  const { rows } = await getPool().query<AdminSessionRow>(
    `UPDATE sessions
     SET status = 'stopping', stop_reason = 'operator_stop', ended_at = NOW()
     WHERE id = $1 AND status IN ('active', 'paused', 'ready', 'starting', 'awaiting_funding')
     RETURNING *`,
    [sessionId]
  );
  return rows[0] ?? null;
}
