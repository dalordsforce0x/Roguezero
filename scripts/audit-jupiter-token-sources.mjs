import 'dotenv/config';

const TOKEN_API_BASE_URL = (process.env.JUPITER_TOKEN_API_BASE_URL || 'https://api.jup.ag/tokens/v2').replace(/\/$/, '');
const QUOTE_BASE_URL = process.env.JUPITER_QUOTE_BASE_URL || 'https://api.jup.ag/swap/v2/order';
const SOURCE_LIMIT = Number(process.env.TOKEN_SOURCE_AUDIT_LIMIT ?? 500);
const ROUTE_LIMIT_PER_SOURCE = Number(process.env.TOKEN_SOURCE_AUDIT_ROUTE_LIMIT ?? 25);
const QUOTE_SLEEP_MS = Number(process.env.TOKEN_SOURCE_AUDIT_QUOTE_SLEEP_MS ?? 60);
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
const MAX_5_USDC_IMPACT_BPS = Number(process.env.TOKEN_ADMISSION_MAX_5_USDC_IMPACT_BPS ?? process.env.TOKEN_ADMISSION_MAX_5_SOL_IMPACT_BPS ?? 50);
const MAX_10_USDC_IMPACT_BPS = Number(process.env.TOKEN_ADMISSION_MAX_10_USDC_IMPACT_BPS ?? process.env.TOKEN_ADMISSION_MAX_10_SOL_IMPACT_BPS ?? 100);

const DEFAULT_SOURCE_PATHS = [
  `toptraded/1h?limit=${SOURCE_LIMIT}`,
  `toptraded/24h?limit=${SOURCE_LIMIT}`,
  `toporganicscore/1h?limit=${SOURCE_LIMIT}`,
  `toporganicscore/24h?limit=${SOURCE_LIMIT}`,
  `toptrending/1h?limit=${SOURCE_LIMIT}`,
  `toptrending/24h?limit=${SOURCE_LIMIT}`,
  `tag?query=verified`,
  `recent`,
];
const SOURCE_PATHS = (process.env.TOKEN_SOURCE_AUDIT_PATHS?.trim()
  ? process.env.TOKEN_SOURCE_AUDIT_PATHS.split(',').map((value) => value.trim()).filter(Boolean)
  : DEFAULT_SOURCE_PATHS);

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
  throw new Error('JUPITER_API_KEY or JUPITER_API_KEY_* is required');
}

let jupiterKeyCursor = 0;
const jupiterHeaders = () => {
  const key = jupiterApiKeys[jupiterKeyCursor % jupiterApiKeys.length];
  jupiterKeyCursor = (jupiterKeyCursor + 1) % jupiterApiKeys.length;
  return { 'x-api-key': key, Accept: 'application/json' };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  };
};

const evaluateTokenSafety = (token) => {
  const safety = getTokenSafetySnapshot(token);
  const riskFlags = [];

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

  return { admitted: riskFlags.length === 0, riskFlags, safety };
};

const parseImpactBps = (priceImpactPct) => {
  const parsed = Number(priceImpactPct ?? 0);
  if (!Number.isFinite(parsed)) return null;
  const absoluteImpact = Math.abs(parsed);
  return absoluteImpact <= 1 ? Math.round(absoluteImpact * 10_000) : Math.round(absoluteImpact * 100);
};

const fetchTokenSource = async (path) => {
  const response = await fetch(`${TOKEN_API_BASE_URL}/${path}`, { headers: jupiterHeaders() });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error(`${path} returned non-array payload`);
  return payload;
};

const quote = async ({ inputMint, outputMint, amount }) => {
  const url = new URL(QUOTE_BASE_URL);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', '50');
  url.searchParams.set('restrictIntermediateTokens', 'true');

  const response = await fetch(url, { headers: jupiterHeaders() });
  if (!response.ok) {
    return { ok: false, status: response.status, error: (await response.text()).slice(0, 180) };
  }
  const payload = await response.json();
  return {
    ok: true,
    outAmount: payload.outAmount ?? null,
    impactBps: parseImpactBps(payload.priceImpactPct),
    routePlanLength: Array.isArray(payload.routePlan) ? payload.routePlan.length : null,
  };
};

const routeProbe = async (token) => {
  const mint = getTokenMint(token);
  const entry5 = await quote({ inputMint: USDC_MINT, outputMint: mint, amount: 5_000_000 });
  await sleep(QUOTE_SLEEP_MS);
  const entry10 = await quote({ inputMint: USDC_MINT, outputMint: mint, amount: 10_000_000 });
  await sleep(QUOTE_SLEEP_MS);

  const out5 = Number(entry5.outAmount ?? 0);
  const out10 = Number(entry10.outAmount ?? 0);
  const exit5 = entry5.ok && Number.isFinite(out5) && out5 > 0
    ? await quote({ inputMint: mint, outputMint: USDC_MINT, amount: Math.floor(out5) })
    : { ok: false, skipped: true };
  await sleep(QUOTE_SLEEP_MS);
  const exit10 = entry10.ok && Number.isFinite(out10) && out10 > 0
    ? await quote({ inputMint: mint, outputMint: USDC_MINT, amount: Math.floor(out10) })
    : { ok: false, skipped: true };
  await sleep(QUOTE_SLEEP_MS);

  const pass = entry5.ok
    && entry10.ok
    && exit5.ok
    && exit10.ok
    && entry5.impactBps !== null
    && entry10.impactBps !== null
    && exit5.impactBps !== null
    && exit10.impactBps !== null
    && entry5.impactBps <= MAX_5_USDC_IMPACT_BPS
    && entry10.impactBps <= MAX_10_USDC_IMPACT_BPS
    && exit5.impactBps <= MAX_5_USDC_IMPACT_BPS
    && exit10.impactBps <= MAX_10_USDC_IMPACT_BPS;

  return { pass, entry5, entry10, exit5, exit10 };
};

const countFlags = (tokens) => {
  const counts = new Map();
  for (const token of tokens) {
    for (const flag of token.riskFlags ?? []) {
      counts.set(flag, (counts.get(flag) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([flag, count]) => ({ flag, count }));
};

const summarizeSource = async (path) => {
  const tokens = await fetchTokenSource(path);
  const seen = new Set();
  const evaluated = [];

  for (const token of tokens) {
    const mint = getTokenMint(token);
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    const safetyResult = evaluateTokenSafety(token);
    evaluated.push({
      mint,
      symbol: getTokenSymbol(token),
      safetyPass: safetyResult.admitted,
      riskFlags: safetyResult.riskFlags,
      safety: safetyResult.safety,
      raw: {
        organicScore: token?.organicScore ?? token?.organic_score ?? null,
        liquidity: token?.liquidity ?? token?.liquidityUsd ?? token?.stats24h?.liquidity ?? null,
        volume24h: getToken24hVolumeUsd(token),
        holderCount: token?.holderCount ?? token?.holder_count ?? token?.holders ?? null,
        tags: token?.tags ?? null,
      },
    });
  }

  const safetyPassing = evaluated.filter((entry) => entry.safetyPass);
  const routeSamples = [];
  for (const entry of safetyPassing.slice(0, Math.max(0, ROUTE_LIMIT_PER_SOURCE))) {
    const token = tokens.find((candidate) => getTokenMint(candidate) === entry.mint);
    const routes = await routeProbe(token);
    routeSamples.push({
      symbol: entry.symbol,
      mint: entry.mint,
      pass: routes.pass,
      entry5ImpactBps: routes.entry5.impactBps ?? null,
      entry10ImpactBps: routes.entry10.impactBps ?? null,
      exit5ImpactBps: routes.exit5.impactBps ?? null,
      exit10ImpactBps: routes.exit10.impactBps ?? null,
    });
  }

  return {
    path,
    fetched: tokens.length,
    unique: evaluated.length,
    safetyPass: safetyPassing.length,
    routePassInSample: routeSamples.filter((sample) => sample.pass).length,
    routeSampled: routeSamples.length,
    topRejectFlags: countFlags(evaluated.filter((entry) => !entry.safetyPass)).slice(0, 10),
    safetyPassExamples: safetyPassing.slice(0, 15).map((entry) => ({
      symbol: entry.symbol,
      mint: entry.mint,
      raw: entry.raw,
    })),
    routePassExamples: routeSamples.filter((sample) => sample.pass).slice(0, 15),
    routeFailExamples: routeSamples.filter((sample) => !sample.pass).slice(0, 10),
  };
};

const main = async () => {
  const summaries = [];
  for (const path of SOURCE_PATHS) {
    console.error(`[audit] ${path}`);
    summaries.push(await summarizeSource(path));
  }
  console.log(JSON.stringify({
    sourceLimit: SOURCE_LIMIT,
    routeLimitPerSource: ROUTE_LIMIT_PER_SOURCE,
    thresholds: {
      requireVerified: TOKEN_SAFETY_REQUIRE_VERIFIED,
      minOrganicScore: TOKEN_SAFETY_MIN_ORGANIC_SCORE,
      minLiquidityUsd: TOKEN_SAFETY_MIN_LIQUIDITY_USD,
      minHolderCount: TOKEN_SAFETY_MIN_HOLDER_COUNT,
      min24hVolumeUsd: TOKEN_SAFETY_MIN_24H_VOLUME_USD,
      maxTopHoldersPct: TOKEN_SAFETY_MAX_TOP_HOLDERS_PCT,
      maxDevBalancePct: TOKEN_SAFETY_MAX_DEV_BALANCE_PCT,
      max5UsdcImpactBps: MAX_5_USDC_IMPACT_BPS,
      max10UsdcImpactBps: MAX_10_USDC_IMPACT_BPS,
    },
    summaries,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
