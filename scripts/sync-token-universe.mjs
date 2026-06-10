import dotenv from 'dotenv';
import pg from 'pg';

const limitArg = Number(process.argv[2] ?? 250);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : 250;

dotenv.config({ path: '.env' });

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const TOKEN_API_BASE_URL = (process.env.JUPITER_TOKEN_API_BASE_URL || 'https://api.jup.ag/tokens/v2').replace(/\/$/, '');
const TOKEN_SYNC_SOURCE_LIMIT = Number(process.env.TOKEN_SYNC_SOURCE_LIMIT ?? limit);
const parseBoolEnv = (value, defaultValue) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
};

const TOKEN_SAFETY_REQUIRE_VERIFIED = parseBoolEnv(process.env.TOKEN_ADMISSION_REQUIRE_VERIFIED, true);
const TOKEN_SAFETY_MIN_ORGANIC_SCORE = Number(process.env.TOKEN_ADMISSION_MIN_ORGANIC_SCORE ?? 50);
const TOKEN_SAFETY_MIN_LIQUIDITY_USD = Number(process.env.TOKEN_ADMISSION_MIN_LIQUIDITY_USD ?? 50_000);
const TOKEN_SAFETY_MIN_HOLDER_COUNT = Number(process.env.TOKEN_ADMISSION_MIN_HOLDER_COUNT ?? 1_000);
const TOKEN_SAFETY_MIN_24H_VOLUME_USD = Number(process.env.TOKEN_ADMISSION_MIN_24H_VOLUME_USD ?? 25_000);
const TOKEN_SAFETY_MAX_TOP_HOLDERS_PCT = Number(process.env.TOKEN_ADMISSION_MAX_TOP_HOLDERS_PCT ?? 35);
const TOKEN_SAFETY_MAX_DEV_BALANCE_PCT = Number(process.env.TOKEN_ADMISSION_MAX_DEV_BALANCE_PCT ?? 5);
const TOKEN_SAFETY_REJECT_UNKNOWN_DEV_BALANCE = parseBoolEnv(process.env.TOKEN_ADMISSION_REJECT_UNKNOWN_DEV_BALANCE, false);
const TOKEN_SAFETY_REQUIRE_MINT_AUTH_DISABLED = parseBoolEnv(process.env.TOKEN_ADMISSION_REQUIRE_MINT_AUTH_DISABLED, true);
const TOKEN_SAFETY_REQUIRE_FREEZE_AUTH_DISABLED = parseBoolEnv(process.env.TOKEN_ADMISSION_REQUIRE_FREEZE_AUTH_DISABLED, true);
const TOKEN_SAFETY_REJECT_SUS = parseBoolEnv(process.env.TOKEN_ADMISSION_REJECT_SUS, true);
const TOKEN_SAFETY_BLOCK_PUMP_MINTS = parseBoolEnv(process.env.TOKEN_ADMISSION_BLOCK_PUMP_MINTS, true);

const collectJupiterApiKeys = () => {
  const keys = [
    process.env.JUPITER_API_KEY,
    ...Object.entries(process.env)
      .filter(([key, value]) => /^JUPITER_API_KEY_[A-Z0-9_]+$/.test(key) && typeof value === 'string')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value),
  ];

  const seen = new Set();
  return keys
    .map((value) => value?.trim() ?? '')
    .filter((value) => value.length > 0 && !value.startsWith('YOUR_') && !value.startsWith('CHANGEME_') && !value.startsWith('REPLACE_'))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
};

const jupiterApiKeys = collectJupiterApiKeys();
if (jupiterApiKeys.length === 0) {
  throw new Error('JUPITER_API_KEY or JUPITER_API_KEY_* is required for Jupiter Token API sync');
}

let jupiterKeyCursor = 0;
const nextJupiterApiKey = () => {
  const key = jupiterApiKeys[jupiterKeyCursor % jupiterApiKeys.length];
  jupiterKeyCursor = (jupiterKeyCursor + 1) % jupiterApiKeys.length;
  return key;
};

const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');

const client = new pg.Client({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
});

// Tokens with fixed high priority. Only CORE_ALWAYS_ENABLE bypasses Token API safety checks;
// everything else still has to pass verification/audit/liquidity/holder gates before being enabled.
const PINNED = new Map([
  ['So11111111111111111111111111111111111111112',  { symbol: 'SOL',     priority: 100000 }],
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', { symbol: 'USDC',    priority: 99999  }],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', { symbol: 'USDT',    priority: 99998  }],
  ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', { symbol: 'JUP',     priority: 99997  }],
  ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', { symbol: 'JitoSOL', priority: 99996  }],
  ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', { symbol: 'mSOL',    priority: 99995  }],
  ['bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', { symbol: 'bSOL',    priority: 99994  }],
  ['jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', { symbol: 'JTO',     priority: 99993  }],
  ['HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', { symbol: 'PYTH',   priority: 99992  }],
  ['KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', { symbol: 'KMNO',   priority: 99991  }],
  ['3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', { symbol: 'WBTC',   priority: 99990  }],
  ['85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', { symbol: 'W',      priority: 99989  }],
  ['hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', { symbol: 'HNT',    priority: 99988  }],
  ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', { symbol: 'BONK',  priority: 99987  }],
  ['EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', { symbol: 'WIF',   priority: 99986  }],
  ['MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', { symbol: 'MEW',    priority: 99985  }],
  ['7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', { symbol: 'POPCAT', priority: 99984 }],
  ['27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4', { symbol: 'JLP',   priority: 99983  }],
  ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', { symbol: 'RAY',   priority: 99982  }],
  ['orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', { symbol: 'ORCA',   priority: 99981  }],
  ['MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', { symbol: 'MNDE',   priority: 99980  }],
  ['7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', { symbol: 'stSOL',  priority: 99979  }],
  ['5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', { symbol: 'DRIFT',  priority: 99978  }],
  ['JET6zMJWkCN9tpRT2v3jNAAQtEfZVPRo8XgMMns9eHg', { symbol: 'JET',    priority: 99977  }],
  ['SHDWyBxihqiCjDYwvisits5jfez2EfbR347c5cKAgqje', { symbol: 'SHDW',   priority: 99976  }],
  ['HxhWkVpk5NS4Ltg5nij2G671CKXFRKPK8vy271Ub4uEK', { symbol: 'HXRO',  priority: 99975  }],
  ['GeDS162t9yGJuLEHPWXXGrb1zwkzinCgRwnT8vHYjKza', { symbol: 'MEAN',   priority: 99974  }],
  ['7i5KKsX2weiTkry7jA4ZwSuXGhs5eJBEjY8vVxR4pfRx', { symbol: 'GMT',   priority: 99973  }],
  ['AFbX8oGjGpmVFywabs9DVmleBkzf2LeafELTE1wiron1', { symbol: 'GST',    priority: 99972  }],
  ['ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx', { symbol: 'ATLAS',  priority: 99971  }],
  ['poLisWXnNRwC6oBu1vHiuKQzFjGL4XDSu4g9qjz9qVk', { symbol: 'POLIS',  priority: 99970  }],
  ['StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT', { symbol: 'STEP',   priority: 99969  }],
  ['9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E', { symbol: 'BTC',    priority: 99968  }],
  ['2FPyTwcZLUgFDPdBqjZCZLBQEsEkpDmr2t9DKFMnZj7t', { symbol: 'ETH',   priority: 99967  }],
  ['Saber2gLauYim4Mvftnrasomsv6NvAuncvMEZwcLpD1', { symbol: 'SBR',    priority: 99966  }],
  ['SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt', { symbol: 'SRM',    priority: 99965  }],
]);

const CORE_ALWAYS_ENABLE = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS',
]);

const HARD_BLOCKED_MINTS = new Set([
  '4SZjjNABoqhbd4hnapbvoEPEqT8mnNkfbEoAwALf1V8t', // CAVE
  'mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6',  // MOBILE (thin)
]);

const symbolOk = (symbol) => (
  typeof symbol === 'string'
  && symbol.length >= 2
  && symbol.length <= 16
  && /^[A-Za-z0-9\-.]+$/.test(symbol)
);

const jupiterHeaders = () => ({
  'x-api-key': nextJupiterApiKey(),
  Accept: 'application/json',
});

const TOKEN_SOURCE_PATHS = [
  `toptrending/1h?limit=${TOKEN_SYNC_SOURCE_LIMIT}`,
  `toptrending/24h?limit=${TOKEN_SYNC_SOURCE_LIMIT}`,
  `toporganicscore/24h?limit=${TOKEN_SYNC_SOURCE_LIMIT}`,
  `toporganicscore/1h?limit=${Math.ceil(TOKEN_SYNC_SOURCE_LIMIT / 2)}`,
  `toptraded/24h?limit=${TOKEN_SYNC_SOURCE_LIMIT}`,
  `toptraded/1h?limit=${Math.ceil(TOKEN_SYNC_SOURCE_LIMIT / 2)}`,
  'tag?query=verified',
  'recent',
];

const fetchTokenSource = async (path) => {
  const url = `${TOKEN_API_BASE_URL}/${path}`;
  const res = await fetch(url, { headers: jupiterHeaders() });
  if (!res.ok) {
    throw new Error(`Jupiter Token API ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const payload = await res.json();
  if (!Array.isArray(payload)) {
    throw new Error(`Jupiter Token API ${path} returned unexpected shape`);
  }
  return payload;
};

const getTokenMint = (token) => token?.id ?? token?.address ?? token?.mint;
const getTokenSymbol = (token) => token?.symbol ?? '';

const asFiniteNumber = (...values) => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const asBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalized)) return true;
    if (['false', 'no', '0'].includes(normalized)) return false;
  }
  return null;
};

const hasVerifiedTag = (token) => Array.isArray(token?.tags)
  && token.tags.some((tag) => String(tag).toLowerCase() === 'verified');

const sumFiniteNumbers = (...values) => {
  let total = 0;
  let found = false;
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      total += parsed;
      found = true;
    }
  }
  return found ? total : null;
};

const getToken24hVolumeUsd = (token) => asFiniteNumber(
  token?.stats24h?.volume,
  token?.daily_volume,
  token?.volume24h,
) ?? sumFiniteNumbers(token?.stats24h?.buyVolume, token?.stats24h?.sellVolume);

const getMintAuthorityDisabled = (token, audit) => {
  const auditValue = asBoolean(audit.mintAuthorityDisabled ?? audit.mint_authority_disabled);
  if (auditValue !== null) return auditValue;
  if (Object.prototype.hasOwnProperty.call(token ?? {}, 'mintAuthority')) {
    return token?.mintAuthority === null;
  }
  return null;
};

const getTokenSafetySnapshot = (token) => {
  const audit = token?.audit && typeof token.audit === 'object' ? token.audit : {};
  return {
    isVerified: asBoolean(token?.isVerified ?? token?.verified) ?? hasVerifiedTag(token),
    organicScore: asFiniteNumber(token?.organicScore, token?.organic_score),
    liquidityUsd: asFiniteNumber(token?.liquidity, token?.liquidityUsd, token?.stats24h?.liquidity),
    holderCount: asFiniteNumber(token?.holderCount, token?.holder_count, token?.holders),
    volume24hUsd: getToken24hVolumeUsd(token),
    mintAuthorityDisabled: getMintAuthorityDisabled(token, audit),
    freezeAuthorityDisabled: asBoolean(audit.freezeAuthorityDisabled ?? audit.freeze_authority_disabled),
    isSus: asBoolean(audit.isSus ?? audit.sus ?? audit.is_sus),
    topHoldersPercentage: asFiniteNumber(audit.topHoldersPercentage, audit.top_holders_percentage),
    devBalancePercentage: asFiniteNumber(audit.devBalancePercentage, audit.dev_balance_percentage),
    // Momentum + market-cap windows from Jupiter v2 (persisted for runtime tier/size decisions).
    priceChange1hPct: asFiniteNumber(token?.stats1h?.priceChange),
    priceChange24hPct: asFiniteNumber(token?.stats24h?.priceChange),
    mcapUsd: asFiniteNumber(token?.mcap, token?.marketCap, token?.fdv),
    organicScoreLabel: typeof token?.organicScoreLabel === 'string' ? token.organicScoreLabel : null,
  };
};

const evaluateTokenSafety = (token) => {
  const mint = getTokenMint(token);
  const safety = getTokenSafetySnapshot(token);
  const riskFlags = [];

  if (CORE_ALWAYS_ENABLE.has(mint)) {
    return { admitted: true, riskFlags, safety, bypassReason: 'core_always_enable' };
  }

  if (TOKEN_SAFETY_BLOCK_PUMP_MINTS && String(mint).toLowerCase().endsWith('pump')) riskFlags.push('pump_mint_blocked');
  if (TOKEN_SAFETY_REQUIRE_VERIFIED && safety.isVerified !== true) riskFlags.push('unverified');
  if (safety.organicScore === null || safety.organicScore < TOKEN_SAFETY_MIN_ORGANIC_SCORE) riskFlags.push('low_organic_score');
  if (safety.liquidityUsd === null || safety.liquidityUsd < TOKEN_SAFETY_MIN_LIQUIDITY_USD) riskFlags.push('low_liquidity');
  if (safety.holderCount === null || safety.holderCount < TOKEN_SAFETY_MIN_HOLDER_COUNT) riskFlags.push('low_holder_count');
  if (safety.volume24hUsd === null || safety.volume24hUsd < TOKEN_SAFETY_MIN_24H_VOLUME_USD) riskFlags.push('low_24h_volume');
  if (TOKEN_SAFETY_REQUIRE_MINT_AUTH_DISABLED && safety.mintAuthorityDisabled !== true) riskFlags.push('mint_authority_enabled_or_unknown');
  if (TOKEN_SAFETY_REQUIRE_FREEZE_AUTH_DISABLED && safety.freezeAuthorityDisabled !== true) riskFlags.push('freeze_authority_enabled_or_unknown');
  if (TOKEN_SAFETY_REJECT_SUS && safety.isSus === true) riskFlags.push('jupiter_audit_sus');
  if (safety.topHoldersPercentage === null || safety.topHoldersPercentage > TOKEN_SAFETY_MAX_TOP_HOLDERS_PCT) riskFlags.push('top_holders_concentrated_or_unknown');
  if (safety.devBalancePercentage === null) {
    if (TOKEN_SAFETY_REJECT_UNKNOWN_DEV_BALANCE) riskFlags.push('dev_balance_unknown');
  } else if (safety.devBalancePercentage > TOKEN_SAFETY_MAX_DEV_BALANCE_PCT) {
    riskFlags.push('dev_balance_high');
  }

  return { admitted: riskFlags.length === 0, riskFlags, safety, bypassReason: null };
};

const computeDiscoveryScore = (token, sourcePriority) => {
  const organicScore = Number(token?.organicScore ?? token?.organic_score ?? 0);
  const dailyVolume = Number(getToken24hVolumeUsd(token) ?? 0);
  const liquidity = Number(token?.liquidity ?? token?.liquidityUsd ?? token?.stats24h?.liquidity ?? 0);
  return sourcePriority + Math.max(0, organicScore) + Math.log10(Math.max(1, dailyVolume)) * 100 + Math.log10(Math.max(1, liquidity)) * 50;
};

const main = async () => {
  console.error(`[sync] using ${jupiterApiKeys.length} Jupiter API key(s) via round-robin selector`);
  const raw = [];
  let sourceIndex = 0;
  for (const path of TOKEN_SOURCE_PATHS) {
    const sourceTokens = await fetchTokenSource(path);
    const sourcePriority = Math.max(0, 80_000 - (sourceIndex * 10_000));
    sourceIndex++;
    console.error(`[sync] source: ${TOKEN_API_BASE_URL}/${path} (${sourceTokens.length} tokens)`);
    for (const token of sourceTokens) {
      raw.push({
        ...token,
        _rzDiscoveryScore: computeDiscoveryScore(token, sourcePriority),
        _rzDiscoverySource: path,
      });
    }
  }

  // Dedupe by mint address.
  const dedupedMap = new Map();
  const rejectionCounts = new Map();
  for (const token of raw) {
    if (!token || typeof token !== 'object') continue;
    const mint = getTokenMint(token);
    if (typeof mint !== 'string' || mint.length < 32 || mint.length > 44) continue;
    if (HARD_BLOCKED_MINTS.has(mint)) continue;
    const sym = getTokenSymbol(token);
    if (!symbolOk(sym)) continue;
    const safetyResult = evaluateTokenSafety(token);
    if (!safetyResult.admitted) {
      for (const flag of safetyResult.riskFlags) {
        rejectionCounts.set(flag, (rejectionCounts.get(flag) ?? 0) + 1);
      }
      continue;
    }
    token._rzSafety = safetyResult;
    if (!dedupedMap.has(mint)) dedupedMap.set(mint, token);
  }

  // Sort: pinned tokens first (by priority desc), then the rest alphabetically.
  const all = [...dedupedMap.values()];
  all.sort((a, b) => {
    const pa = PINNED.get(getTokenMint(a))?.priority ?? Number(a._rzDiscoveryScore ?? 0);
    const pb = PINNED.get(getTokenMint(b))?.priority ?? Number(b._rzDiscoveryScore ?? 0);
    if (pa !== pb) return pb - pa;
    return (a.symbol ?? '').localeCompare(b.symbol ?? '');
  });

  const selected = all.slice(0, limit);

  await client.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.rz_token_universe (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        priority INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      ALTER TABLE public.rz_token_universe
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS is_verified BOOLEAN,
        ADD COLUMN IF NOT EXISTS organic_score NUMERIC,
        ADD COLUMN IF NOT EXISTS organic_score_label TEXT,
        ADD COLUMN IF NOT EXISTS liquidity_usd NUMERIC,
        ADD COLUMN IF NOT EXISTS volume_24h_usd NUMERIC,
        ADD COLUMN IF NOT EXISTS mcap_usd NUMERIC,
        ADD COLUMN IF NOT EXISTS holder_count NUMERIC,
        ADD COLUMN IF NOT EXISTS top_holders_pct NUMERIC,
        ADD COLUMN IF NOT EXISTS dev_balance_pct NUMERIC,
        ADD COLUMN IF NOT EXISTS price_change_1h_pct NUMERIC,
        ADD COLUMN IF NOT EXISTS price_change_24h_pct NUMERIC,
        ADD COLUMN IF NOT EXISTS mint_auth_disabled BOOLEAN,
        ADD COLUMN IF NOT EXISTS freeze_auth_disabled BOOLEAN,
        ADD COLUMN IF NOT EXISTS is_sus BOOLEAN,
        ADD COLUMN IF NOT EXISTS discovery_source TEXT,
        ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ
    `);

    // First disable all; selected set will be re-enabled.
    await client.query('UPDATE public.rz_token_universe SET enabled = false, updated_at = now()');

    let idx = 0;
    for (const token of selected) {
      const mint = getTokenMint(token);
      const sym = (token.symbol ?? '').toUpperCase();
      const pinned = PINNED.get(mint);
      const priority = pinned?.priority ?? Math.max(1, Math.floor(Number(token._rzDiscoveryScore ?? 0)) || (50000 - idx));
      const notes = token._rzSafety?.bypassReason === 'core_always_enable'
        ? 'core-seed'
        : `jupiter-token-api-v2:${token._rzDiscoverySource ?? 'unknown'};safety=verified-audit-liquidity`;
      const s = token._rzSafety?.safety ?? {};
      await client.query(
        `INSERT INTO public.rz_token_universe (
           mint, symbol, enabled, priority, notes,
           is_verified, organic_score, organic_score_label,
           liquidity_usd, volume_24h_usd, mcap_usd,
           holder_count, top_holders_pct, dev_balance_pct,
           price_change_1h_pct, price_change_24h_pct,
           mint_auth_disabled, freeze_auth_disabled, is_sus,
           discovery_source, synced_at, updated_at
         )
         VALUES ($1, $2, true, $3, $4,
                 $5, $6, $7,
                 $8, $9, $10,
                 $11, $12, $13,
                 $14, $15,
                 $16, $17, $18,
                 $19, now(), now())
         ON CONFLICT (mint)
         DO UPDATE SET symbol = EXCLUDED.symbol,
                       enabled = true,
                       priority = EXCLUDED.priority,
                       notes = EXCLUDED.notes,
                       is_verified = EXCLUDED.is_verified,
                       organic_score = EXCLUDED.organic_score,
                       organic_score_label = EXCLUDED.organic_score_label,
                       liquidity_usd = EXCLUDED.liquidity_usd,
                       volume_24h_usd = EXCLUDED.volume_24h_usd,
                       mcap_usd = EXCLUDED.mcap_usd,
                       holder_count = EXCLUDED.holder_count,
                       top_holders_pct = EXCLUDED.top_holders_pct,
                       dev_balance_pct = EXCLUDED.dev_balance_pct,
                       price_change_1h_pct = EXCLUDED.price_change_1h_pct,
                       price_change_24h_pct = EXCLUDED.price_change_24h_pct,
                       mint_auth_disabled = EXCLUDED.mint_auth_disabled,
                       freeze_auth_disabled = EXCLUDED.freeze_auth_disabled,
                       is_sus = EXCLUDED.is_sus,
                       discovery_source = EXCLUDED.discovery_source,
                       synced_at = now(),
                       updated_at = now()`,
        [
          mint, sym, priority, notes,
          s.isVerified, s.organicScore, s.organicScoreLabel,
          s.liquidityUsd, s.volume24hUsd, s.mcapUsd,
          s.holderCount, s.topHoldersPercentage, s.devBalancePercentage,
          s.priceChange1hPct, s.priceChange24hPct,
          s.mintAuthorityDisabled, s.freezeAuthorityDisabled, s.isSus,
          token._rzDiscoverySource ?? null,
        ],
      );
      idx++;
    }

    await client.query('COMMIT');

    const countResult = await client.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled
         FROM public.rz_token_universe`,
    );

    console.log(JSON.stringify({
      mode: 'jupiter_token_api_v2',
      apiBaseUrl: TOKEN_API_BASE_URL,
      requestedLimit: limit,
      upstreamTotal: raw.length,
      safetyRejected: [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1]).map(([flag, count]) => ({ flag, count })),
      imported: selected.length,
      dbTotals: countResult.rows[0],
      thresholds: {
        requireVerified: TOKEN_SAFETY_REQUIRE_VERIFIED,
        minOrganicScore: TOKEN_SAFETY_MIN_ORGANIC_SCORE,
        minLiquidityUsd: TOKEN_SAFETY_MIN_LIQUIDITY_USD,
        minHolderCount: TOKEN_SAFETY_MIN_HOLDER_COUNT,
        min24hVolumeUsd: TOKEN_SAFETY_MIN_24H_VOLUME_USD,
        maxTopHoldersPct: TOKEN_SAFETY_MAX_TOP_HOLDERS_PCT,
        maxDevBalancePct: TOKEN_SAFETY_MAX_DEV_BALANCE_PCT,
        blockPumpMints: TOKEN_SAFETY_BLOCK_PUMP_MINTS,
        requireMintAuthDisabled: TOKEN_SAFETY_REQUIRE_MINT_AUTH_DISABLED,
        requireFreezeAuthDisabled: TOKEN_SAFETY_REQUIRE_FREEZE_AUTH_DISABLED,
        rejectSus: TOKEN_SAFETY_REJECT_SUS,
      },
      sample: selected.slice(0, 15).map((t) => ({ mint: getTokenMint(t), symbol: (t.symbol ?? '').toUpperCase(), source: t._rzDiscoverySource })),
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
};

await main();
