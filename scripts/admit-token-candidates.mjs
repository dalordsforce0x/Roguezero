import 'dotenv/config';
import pg from 'pg';
import { buildMintMarketDataMap, coingeckoMeta } from './coingeckoMarketData.mjs';

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();

if (!databaseUrl) {
  throw new Error('DATABASE_PRIVATE_URL is required');
}

const parsed = new URL(databaseUrl);
parsed.searchParams.delete('sslmode');

const pool = new pg.Pool({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
});

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const APPLY_TO_UNIVERSE = process.env.TOKEN_ADMISSION_APPLY_TO_UNIVERSE !== 'false';
// Additive-only mode: the feeder ONLY adds/enables newly-admitted tokens and never
// disables existing universe rows. Eviction/pruning of dead tokens is owned by the
// worker autosort engine (applyTokenUniverseAutoSort), which has streak protection.
// This is the SAFE mode for unattended scheduled runs. Default ON for that reason;
// set TOKEN_ADMISSION_ADDITIVE_ONLY=false only for an intentional full universe rewrite.
const ADDITIVE_ONLY = process.env.TOKEN_ADMISSION_ADDITIVE_ONLY !== 'false';
const TOKEN_API_BASE_URL = (process.env.JUPITER_TOKEN_API_BASE_URL || 'https://api.jup.ag/tokens/v2').replace(/\/$/, '');
const QUOTE_BASE_URL = process.env.JUPITER_QUOTE_BASE_URL || 'https://api.jup.ag/swap/v2/order';
const TOKEN_ADMISSION_SOURCE_LIMIT = Number(process.env.TOKEN_ADMISSION_SOURCE_LIMIT ?? 250);
const MAX_5_USDC_IMPACT_BPS = Number(process.env.TOKEN_ADMISSION_MAX_5_USDC_IMPACT_BPS ?? process.env.TOKEN_ADMISSION_MAX_5_SOL_IMPACT_BPS ?? 50);
const MAX_10_USDC_IMPACT_BPS = Number(process.env.TOKEN_ADMISSION_MAX_10_USDC_IMPACT_BPS ?? process.env.TOKEN_ADMISSION_MAX_10_SOL_IMPACT_BPS ?? 100);
const MIN_SUCCESSFUL_QUOTE_COUNT = Number(process.env.TOKEN_ADMISSION_MIN_SUCCESSFUL_QUOTES ?? 4);
const QUOTE_SLEEP_MS = Number(process.env.TOKEN_ADMISSION_QUOTE_SLEEP_MS ?? 175);
const CANDIDATE_LIMIT = Number(process.env.TOKEN_ADMISSION_CANDIDATE_LIMIT ?? 500);
const REJECTED_EVIDENCE_LIMIT = Number(process.env.TOKEN_ADMISSION_REJECTED_EVIDENCE_LIMIT ?? CANDIDATE_LIMIT);
const parseBoolEnv = (value, defaultValue) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
};
const REQUIRE_EXIT_ROUTES = parseBoolEnv(process.env.TOKEN_ADMISSION_REQUIRE_EXIT_ROUTES, true);

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

// CoinGecko market-cap admission gate (slow-moving context, NOT a trade-timing input).
// Enrichment is best-effort and ON by default; the gate itself only rejects tokens when a
// floor/rank ceiling is configured (>0). Tokens CoinGecko doesn't list are never rejected on
// market-cap grounds unless TOKEN_ADMISSION_REQUIRE_COINGECKO_LISTING is explicitly set true.
const COINGECKO_ENRICH_ENABLED = parseBoolEnv(process.env.TOKEN_ADMISSION_COINGECKO_ENABLED, true);
// Default $250k floor: blocks literal dust the discovery feeds (top-trending/recent) can surface,
// while leaving the whole legit memecoin range tradeable. Additive-only feeder => this only gates
// NEW admissions; it never disables an existing universe row. Raise to 1_000_000 for stricter.
const TOKEN_SAFETY_MIN_MARKET_CAP_USD = Number(process.env.TOKEN_ADMISSION_MIN_MARKET_CAP_USD ?? 250_000);
const TOKEN_SAFETY_MAX_MARKET_CAP_RANK = Number(process.env.TOKEN_ADMISSION_MAX_MARKET_CAP_RANK ?? 0);
const TOKEN_SAFETY_REQUIRE_COINGECKO_LISTING = parseBoolEnv(process.env.TOKEN_ADMISSION_REQUIRE_COINGECKO_LISTING, false);

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
  throw new Error('JUPITER_API_KEY or JUPITER_API_KEY_* is required for Jupiter Token API / route admission');
}

let jupiterKeyCursor = 0;
const nextJupiterApiKey = () => {
  const key = jupiterApiKeys[jupiterKeyCursor % jupiterApiKeys.length];
  jupiterKeyCursor = (jupiterKeyCursor + 1) % jupiterApiKeys.length;
  return key;
};

const jupiterHeaders = () => ({
  'x-api-key': nextJupiterApiKey(),
  Accept: 'application/json',
});

// Tokens that are always admitted without quote testing.
const ALWAYS_ADMIT = new Map([
  ['So11111111111111111111111111111111111111112',  { symbol: 'SOL',     priority: 100000, bucket: 'base'   }],
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', { symbol: 'USDC',  priority: 99999,  bucket: 'stable' }],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', { symbol: 'USDT',  priority: 99998,  bucket: 'stable' }],
  ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', { symbol: 'JUP',   priority: 99997,  bucket: 'major'  }],
  ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', { symbol: 'JitoSOL', priority: 99996, bucket: 'lst' }],
  ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', { symbol: 'mSOL',  priority: 99995,  bucket: 'lst'   }],
  ['bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', { symbol: 'bSOL',  priority: 99994,  bucket: 'lst'   }],
  ['jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', { symbol: 'JTO',   priority: 99993,  bucket: 'major'  }],
  ['HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', { symbol: 'PYTH', priority: 99992,  bucket: 'major'  }],
  ['KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', { symbol: 'KMNO', priority: 99991,  bucket: 'major'  }],
]);

const HARD_BLOCKED_MINTS = new Set([
  '4SZjjNABoqhbd4hnapbvoEPEqT8mnNkfbEoAwALf1V8t', // CAVE
  'mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6',  // MOBILE (thin liquidity)
]);

const TOKEN_SOURCE_PATHS = [
  `toptraded/1h?limit=${TOKEN_ADMISSION_SOURCE_LIMIT}`,
  `toptraded/24h?limit=${TOKEN_ADMISSION_SOURCE_LIMIT}`,
  `toporganicscore/24h?limit=${TOKEN_ADMISSION_SOURCE_LIMIT}`,
  `toporganicscore/1h?limit=${Math.ceil(TOKEN_ADMISSION_SOURCE_LIMIT / 2)}`,
  'tag?query=verified',
  `toptrending/24h?limit=${TOKEN_ADMISSION_SOURCE_LIMIT}`,
  `toptrending/1h?limit=${Math.ceil(TOKEN_ADMISSION_SOURCE_LIMIT / 2)}`,
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
  };
};

const evaluateTokenSafety = (token) => {
  const safety = getTokenSafetySnapshot(token);
  const riskFlags = [];

  if (TOKEN_SAFETY_BLOCK_PUMP_MINTS && String(getTokenMint(token) ?? '').toLowerCase().endsWith('pump')) riskFlags.push('pump_mint_blocked');
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

// CoinGecko market-cap gate. Returns the risk flags this token earns from market-cap context.
// `marketData` is { marketCapUsd, marketCapRank, ... } or null when CoinGecko has no listing.
const evaluateMarketCapGate = (marketData) => {
  const flags = [];
  if (!marketData) {
    if (TOKEN_SAFETY_REQUIRE_COINGECKO_LISTING) flags.push('not_listed_on_coingecko');
    return flags;
  }
  if (TOKEN_SAFETY_MIN_MARKET_CAP_USD > 0) {
    const cap = Number(marketData.marketCapUsd);
    // Only reject on a real positive cap below the floor. A $0/null cap is a CoinGecko quirk
    // for wrapped/bridged assets (e.g. WBTC, PBTC) and must NOT trip the floor; those tokens
    // still have to clear every other safety gate (verified, liquidity, holders, routes).
    if (Number.isFinite(cap) && cap > 0 && cap < TOKEN_SAFETY_MIN_MARKET_CAP_USD) flags.push('below_market_cap_floor');
  }
  if (TOKEN_SAFETY_MAX_MARKET_CAP_RANK > 0) {
    const rank = Number(marketData.marketCapRank);
    // Only reject on a real positive rank worse than the ceiling; no-rank tokens are judged
    // by the USD floor instead so we never reject a legit token merely for lacking a rank.
    if (Number.isFinite(rank) && rank > 0 && rank > TOKEN_SAFETY_MAX_MARKET_CAP_RANK) flags.push('market_cap_rank_too_low');
  }
  return flags;
};

const computeDiscoveryScore = (token, sourcePriority) => {
  const organicScore = Number(token?.organicScore ?? token?.organic_score ?? 0);
  const dailyVolume = Number(getToken24hVolumeUsd(token) ?? 0);
  const liquidity = Number(token?.liquidity ?? token?.liquidityUsd ?? token?.stats24h?.liquidity ?? 0);
  return sourcePriority + Math.max(0, organicScore) + Math.log10(Math.max(1, dailyVolume)) * 100 + Math.log10(Math.max(1, liquidity)) * 50;
};

// Fetch candidates from Jupiter Token API v2 on the authenticated api.jup.ag path.
// RogueZero production runs on Jupiter Pro keys/buckets.
const fetchCandidates = async () => {
  const seen = new Set();
  const candidates = [];
  let routeCandidateCount = 0;
  let rejectedEvidenceCount = 0;

  // Always-admit tokens first.
  for (const [mint, meta] of ALWAYS_ADMIT) {
    seen.add(mint);
    candidates.push({ mint, symbol: meta.symbol, priority: meta.priority, bucket: meta.bucket, enabledByDefault: true });
  }

  let sourceIndex = 0;
  for (const path of TOKEN_SOURCE_PATHS) {
    const sourceTokens = await fetchTokenSource(path);
    console.error(`[admit] source: ${TOKEN_API_BASE_URL}/${path} (${sourceTokens.length} tokens)`);
    const sourceBucket = path.startsWith('toptraded/1h')
      ? 'top_traded_1h'
      : path.startsWith('toptraded/24h')
        ? 'top_traded_24h'
        : path.startsWith('toporganicscore')
      ? 'organic_score'
      : path.startsWith('toptraded')
        ? 'top_traded'
        : path.startsWith('toptrending')
          ? 'top_trending'
          : path === 'recent'
            ? 'recent'
            : 'verified';
    const sourcePriority = Math.max(0, 80_000 - (sourceIndex * 10_000));
    sourceIndex++;

    for (const token of sourceTokens) {
      if (routeCandidateCount >= CANDIDATE_LIMIT && rejectedEvidenceCount >= REJECTED_EVIDENCE_LIMIT) break;
      const mint = getTokenMint(token);
      if (!mint || seen.has(mint)) continue;
      if (HARD_BLOCKED_MINTS.has(mint)) continue;
      const sym = getTokenSymbol(token);
      if (!sym || sym.length < 2 || sym.length > 16) continue;
      const safetyResult = evaluateTokenSafety(token);
      if (safetyResult.admitted && routeCandidateCount >= CANDIDATE_LIMIT) continue;
      if (!safetyResult.admitted && rejectedEvidenceCount >= REJECTED_EVIDENCE_LIMIT) continue;
      seen.add(mint);
      candidates.push({
        mint,
        symbol: sym,
        priority: Math.floor(computeDiscoveryScore(token, sourcePriority)),
        bucket: sourceBucket,
        forceReject: !safetyResult.admitted,
        preRiskFlags: safetyResult.riskFlags,
        tokenApi: {
          source: path,
          organicScore: token?.organicScore ?? token?.organic_score ?? null,
          dailyVolume: getToken24hVolumeUsd(token),
          liquidity: token?.liquidity ?? token?.liquidityUsd ?? token?.stats24h?.liquidity ?? null,
          holderCount: token?.holderCount ?? token?.holder_count ?? token?.holders ?? null,
          decimals: token?.decimals ?? null,
          tags: token?.tags ?? null,
          safety: safetyResult.safety,
        },
      });
      if (safetyResult.admitted) {
        routeCandidateCount++;
      } else {
        rejectedEvidenceCount++;
      }
    }

    if (routeCandidateCount >= CANDIDATE_LIMIT && rejectedEvidenceCount >= REJECTED_EVIDENCE_LIMIT) break;
  }

  console.error(`[admit] collected ${routeCandidateCount} safety-passing route candidates and ${rejectedEvidenceCount} rejected evidence rows`);

  return candidates;
};

const quoteAmounts = [
  { label: '1USDC', amount: 1_000_000 },
  { label: '2USDC', amount: 2_000_000 },
  { label: '5USDC', amount: 5_000_000 },
  { label: '10USDC', amount: 10_000_000 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseImpactBps = (priceImpactPct) => {
  const parsed = Number(priceImpactPct ?? 0);
  if (!Number.isFinite(parsed)) return null;
  const absoluteImpact = Math.abs(parsed);
  return absoluteImpact <= 1 ? Math.round(absoluteImpact * 10_000) : Math.round(absoluteImpact * 100);
};

const quoteRoute = async ({ inputMint, outputMint, amount }) => {
  if (inputMint === outputMint) {
    return { skipped: true, reason: 'base_asset' };
  }

  const url = new URL(QUOTE_BASE_URL);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', '50');
  url.searchParams.set('restrictIntermediateTokens', 'true');

  const response = await fetch(url, { headers: jupiterHeaders() });
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: (await response.text()).slice(0, 300),
    };
  }

  const payload = await response.json();
  return {
    ok: true,
    outAmount: payload.outAmount ?? null,
    impactBps: parseImpactBps(payload.priceImpactPct),
    routePlanLength: Array.isArray(payload.routePlan) ? payload.routePlan.length : null,
  };
};

const evaluateCandidate = async (candidate) => {
  const quotes = {};
  const exitQuotes = {};

  if (!candidate.forceReject) {
    for (const quoteAmount of quoteAmounts) {
      const entryQuote = await quoteRoute({
        inputMint: USDC_MINT,
        outputMint: candidate.mint,
        amount: quoteAmount.amount,
      });
      quotes[quoteAmount.label] = entryQuote;
      await sleep(QUOTE_SLEEP_MS);

      const outAmount = Number(entryQuote.outAmount ?? 0);
      if (REQUIRE_EXIT_ROUTES && entryQuote.ok && Number.isFinite(outAmount) && outAmount > 0) {
        exitQuotes[quoteAmount.label] = await quoteRoute({
          inputMint: candidate.mint,
          outputMint: USDC_MINT,
          amount: Math.floor(outAmount),
        });
      }
      await sleep(QUOTE_SLEEP_MS);
    }
  }

  const successfulQuotes = Object.values(quotes).filter((quote) => quote.ok).length;
  const successfulExitQuotes = Object.values(exitQuotes).filter((quote) => quote.ok).length;
  const impact5Usdc = quotes['5USDC']?.impactBps ?? null;
  const impact10Usdc = quotes['10USDC']?.impactBps ?? null;
  const exitImpact5Usdc = exitQuotes['5USDC']?.impactBps ?? null;
  const exitImpact10Usdc = exitQuotes['10USDC']?.impactBps ?? null;
  const riskFlags = [...(candidate.preRiskFlags ?? [])];

  if (candidate.forceReject) riskFlags.push('force_rejected');
  if (candidate.bucket === 'blocked') riskFlags.push('blocked_token');
  if (successfulQuotes < MIN_SUCCESSFUL_QUOTE_COUNT && candidate.mint !== SOL_MINT) riskFlags.push('insufficient_successful_quotes');
  if (REQUIRE_EXIT_ROUTES && successfulExitQuotes < MIN_SUCCESSFUL_QUOTE_COUNT && candidate.mint !== SOL_MINT) riskFlags.push('insufficient_exit_quotes');
  if (impact5Usdc === null && candidate.mint !== SOL_MINT) riskFlags.push('missing_5usdc_quote');
  if (impact10Usdc === null && candidate.mint !== SOL_MINT) riskFlags.push('missing_10usdc_quote');
  if (REQUIRE_EXIT_ROUTES && exitImpact5Usdc === null && candidate.mint !== SOL_MINT) riskFlags.push('missing_exit_5usdc_quote');
  if (REQUIRE_EXIT_ROUTES && exitImpact10Usdc === null && candidate.mint !== SOL_MINT) riskFlags.push('missing_exit_10usdc_quote');
  if (impact5Usdc !== null && impact5Usdc > MAX_5_USDC_IMPACT_BPS) riskFlags.push('high_5usdc_impact');
  if (impact10Usdc !== null && impact10Usdc > MAX_10_USDC_IMPACT_BPS) riskFlags.push('high_10usdc_impact');
  if (REQUIRE_EXIT_ROUTES && exitImpact5Usdc !== null && exitImpact5Usdc > MAX_5_USDC_IMPACT_BPS) riskFlags.push('high_exit_5usdc_impact');
  if (REQUIRE_EXIT_ROUTES && exitImpact10Usdc !== null && exitImpact10Usdc > MAX_10_USDC_IMPACT_BPS) riskFlags.push('high_exit_10usdc_impact');

  // CoinGecko market-cap gate (always-admit/core seeds bypass via enabledByDefault below).
  const marketCapFlags = candidate.enabledByDefault === true ? [] : evaluateMarketCapGate(candidate.marketData ?? null);
  riskFlags.push(...marketCapFlags);

  const admitted = candidate.enabledByDefault === true
    || (!candidate.forceReject
      && marketCapFlags.length === 0
      && successfulQuotes >= MIN_SUCCESSFUL_QUOTE_COUNT
      && (!REQUIRE_EXIT_ROUTES || successfulExitQuotes >= MIN_SUCCESSFUL_QUOTE_COUNT)
      && impact5Usdc !== null
      && impact5Usdc <= MAX_5_USDC_IMPACT_BPS
      && impact10Usdc !== null
      && impact10Usdc <= MAX_10_USDC_IMPACT_BPS
      && (!REQUIRE_EXIT_ROUTES || (exitImpact5Usdc !== null && exitImpact5Usdc <= MAX_5_USDC_IMPACT_BPS))
      && (!REQUIRE_EXIT_ROUTES || (exitImpact10Usdc !== null && exitImpact10Usdc <= MAX_10_USDC_IMPACT_BPS)));

  return {
    ...candidate,
    status: admitted ? 'admitted' : 'rejected',
    riskFlags,
    marketData: candidate.marketData ?? null,
    quotes,
    exitQuotes,
    successfulQuotes,
    maxImpactBps: Math.max(
      0,
      ...Object.values(quotes)
        .map((quote) => quote.impactBps)
        .filter((value) => Number.isFinite(value)),
    ),
  };
};

const ensureTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.token_admission_candidates (
      mint TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      bucket TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      successful_quote_count INTEGER NOT NULL DEFAULT 0,
      max_impact_bps INTEGER,
      risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.rz_token_universe (
      mint TEXT PRIMARY KEY,
      symbol TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      priority INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    ALTER TABLE public.rz_token_universe
      ADD COLUMN IF NOT EXISTS notes TEXT
  `);

  // CoinGecko enrichment cache: slow-moving market context for the token universe.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.rz_token_marketdata (
      mint TEXT PRIMARY KEY,
      coingecko_id TEXT,
      symbol TEXT,
      name TEXT,
      market_cap_usd DOUBLE PRECISION,
      market_cap_rank INTEGER,
      fdv_usd DOUBLE PRECISION,
      volume_24h_usd DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
};

const persistResult = async (result) => {
  await pool.query(
    `INSERT INTO public.token_admission_candidates (
       mint, symbol, bucket, status, priority, successful_quote_count,
       max_impact_bps, risk_flags, evidence, observed_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, now(), now())
     ON CONFLICT (mint)
     DO UPDATE SET symbol = EXCLUDED.symbol,
                   bucket = EXCLUDED.bucket,
                   status = EXCLUDED.status,
                   priority = EXCLUDED.priority,
                   successful_quote_count = EXCLUDED.successful_quote_count,
                   max_impact_bps = EXCLUDED.max_impact_bps,
                   risk_flags = EXCLUDED.risk_flags,
                   evidence = EXCLUDED.evidence,
                   observed_at = now(),
                   updated_at = now()`,
    [
      result.mint,
      result.symbol,
      result.bucket,
      result.status,
      result.priority,
      result.successfulQuotes,
      Number.isFinite(result.maxImpactBps) ? result.maxImpactBps : null,
      JSON.stringify(result.riskFlags),
      JSON.stringify({ quotes: result.quotes, exitQuotes: result.exitQuotes ?? {}, tokenApi: result.tokenApi ?? null, marketData: result.marketData ?? null }),
    ],
  );

  // Cache CoinGecko market context for visibility/reuse (admin + future gates).
  if (result.marketData) {
    await pool.query(
      `INSERT INTO public.rz_token_marketdata (
         mint, coingecko_id, symbol, name, market_cap_usd, market_cap_rank, fdv_usd, volume_24h_usd, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (mint)
       DO UPDATE SET coingecko_id = EXCLUDED.coingecko_id,
                     symbol = EXCLUDED.symbol,
                     name = EXCLUDED.name,
                     market_cap_usd = EXCLUDED.market_cap_usd,
                     market_cap_rank = EXCLUDED.market_cap_rank,
                     fdv_usd = EXCLUDED.fdv_usd,
                     volume_24h_usd = EXCLUDED.volume_24h_usd,
                     updated_at = now()`,
      [
        result.mint,
        result.marketData.coingeckoId ?? null,
        result.marketData.symbol ?? result.symbol ?? null,
        result.marketData.name ?? null,
        Number.isFinite(Number(result.marketData.marketCapUsd)) ? Number(result.marketData.marketCapUsd) : null,
        Number.isFinite(Number(result.marketData.marketCapRank)) ? Number(result.marketData.marketCapRank) : null,
        Number.isFinite(Number(result.marketData.fdvUsd)) ? Number(result.marketData.fdvUsd) : null,
        Number.isFinite(Number(result.marketData.volume24hUsd)) ? Number(result.marketData.volume24hUsd) : null,
      ],
    );
  }

  if (!APPLY_TO_UNIVERSE) return;

  if (result.status === 'admitted') {
    const notes = result.enabledByDefault === true
      ? 'core-seed'
      : `admitted:${result.bucket};layer=route-qualified;safety=verified-audit-liquidity-entry-exit`;
    await pool.query(
      `INSERT INTO public.rz_token_universe (mint, symbol, enabled, priority, notes, updated_at)
       VALUES ($1, $2, true, $3, $4, now())
       ON CONFLICT (mint)
       DO UPDATE SET symbol = EXCLUDED.symbol,
                     enabled = true,
                     priority = GREATEST(public.rz_token_universe.priority, EXCLUDED.priority),
                     notes = EXCLUDED.notes,
                     updated_at = now()`,
      [result.mint, result.symbol, result.priority, notes],
    );
  } else if (!ADDITIVE_ONLY) {
    await pool.query(
      `UPDATE public.rz_token_universe
          SET enabled = false,
              notes = $2,
              updated_at = now()
        WHERE mint = $1`,
      [result.mint, `rejected:${result.riskFlags.slice(0, 4).join(',')}`],
    );
  }
};

const main = async () => {
  await ensureTables();

  console.error(`[admit] fetching candidates from Jupiter Token API v2 (base=${TOKEN_API_BASE_URL}, limit=${CANDIDATE_LIMIT})...`);
  console.error(`[admit] using ${jupiterApiKeys.length} Jupiter API key(s) via round-robin selector`);
  const candidates = await fetchCandidates();
  console.error(`[admit] testing ${candidates.length} candidates...`);

  // Enrich candidates with CoinGecko market context (best-effort; never blocks admission).
  if (COINGECKO_ENRICH_ENABLED) {
    const meta = coingeckoMeta();
    console.error(`[admit] coingecko enrichment: plan=${meta.plan} keyConfigured=${meta.keyConfigured} base=${meta.baseUrl}`);
    console.error(`[admit] coingecko gate: minMarketCapUsd=${TOKEN_SAFETY_MIN_MARKET_CAP_USD} maxRank=${TOKEN_SAFETY_MAX_MARKET_CAP_RANK} requireListing=${TOKEN_SAFETY_REQUIRE_COINGECKO_LISTING}`);
    const candidateMints = candidates.filter((c) => c.enabledByDefault !== true).map((c) => c.mint);
    const marketDataMap = await buildMintMarketDataMap(candidateMints);
    let enrichedCount = 0;
    for (const candidate of candidates) {
      const data = marketDataMap.get(candidate.mint);
      if (data) {
        candidate.marketData = data;
        enrichedCount++;
      }
    }
    console.error(`[admit] coingecko enrichment matched ${enrichedCount}/${candidateMints.length} candidates`);
  }

  const results = [];
  let done = 0;

  for (const candidate of candidates) {
    const result = await evaluateCandidate(candidate);
    results.push(result);
    await persistResult(result);
    done++;
    if (done % 25 === 0) {
      const admittedSoFar = results.filter((r) => r.status === 'admitted').length;
      console.error(`[admit] progress: ${done}/${candidates.length} tested, ${admittedSoFar} admitted so far`);
    }
  }

  const admitted = results.filter((result) => result.status === 'admitted');
  const rejected = results.filter((result) => result.status !== 'admitted');

  // In additive-only mode the per-token admit INSERTs in persistResult already wrote every
  // new token into the universe; we must NOT run the destructive global disable+re-enable.
  if (APPLY_TO_UNIVERSE && !ADDITIVE_ONLY) {
    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE public.rz_token_universe
            SET enabled = false,
                notes = CASE
                  WHEN notes LIKE 'rejected:%' THEN notes
                  ELSE 'disabled:not-admitted-current-run'
                END,
                updated_at = now()`,
      );

      for (const result of admitted) {
        const notes = result.enabledByDefault === true
          ? 'core-seed'
          : `admitted:${result.bucket};layer=route-qualified;safety=verified-audit-liquidity-entry-exit`;
        await pool.query(
          `INSERT INTO public.rz_token_universe (mint, symbol, enabled, priority, notes, updated_at)
           VALUES ($1, $2, true, $3, $4, now())
           ON CONFLICT (mint)
           DO UPDATE SET symbol = EXCLUDED.symbol,
                         enabled = true,
                         priority = EXCLUDED.priority,
                         notes = EXCLUDED.notes,
                         updated_at = now()`,
          [result.mint, result.symbol, result.priority, notes],
        );
      }

      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }

  const dbTotals = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled
       FROM public.rz_token_universe`,
  );

  console.log(JSON.stringify({
    applyToUniverse: APPLY_TO_UNIVERSE,
    additiveOnly: ADDITIVE_ONLY,
    thresholds: {
      max5UsdcImpactBps: MAX_5_USDC_IMPACT_BPS,
      max10UsdcImpactBps: MAX_10_USDC_IMPACT_BPS,
      minSuccessfulQuoteCount: MIN_SUCCESSFUL_QUOTE_COUNT,
      requireExitRoutes: REQUIRE_EXIT_ROUTES,
      requireVerified: TOKEN_SAFETY_REQUIRE_VERIFIED,
      minOrganicScore: TOKEN_SAFETY_MIN_ORGANIC_SCORE,
      minLiquidityUsd: TOKEN_SAFETY_MIN_LIQUIDITY_USD,
      minHolderCount: TOKEN_SAFETY_MIN_HOLDER_COUNT,
      min24hVolumeUsd: TOKEN_SAFETY_MIN_24H_VOLUME_USD,
      maxTopHoldersPct: TOKEN_SAFETY_MAX_TOP_HOLDERS_PCT,
      maxDevBalancePct: TOKEN_SAFETY_MAX_DEV_BALANCE_PCT,
      blockPumpMints: TOKEN_SAFETY_BLOCK_PUMP_MINTS,
      rejectUnknownDevBalance: TOKEN_SAFETY_REJECT_UNKNOWN_DEV_BALANCE,
      requireMintAuthDisabled: TOKEN_SAFETY_REQUIRE_MINT_AUTH_DISABLED,
      requireFreezeAuthDisabled: TOKEN_SAFETY_REQUIRE_FREEZE_AUTH_DISABLED,
      rejectSus: TOKEN_SAFETY_REJECT_SUS,
      coingeckoEnrichEnabled: COINGECKO_ENRICH_ENABLED,
      minMarketCapUsd: TOKEN_SAFETY_MIN_MARKET_CAP_USD,
      maxMarketCapRank: TOKEN_SAFETY_MAX_MARKET_CAP_RANK,
      requireCoingeckoListing: TOKEN_SAFETY_REQUIRE_COINGECKO_LISTING,
    },
    admitted: admitted.map((result) => ({
      symbol: result.symbol,
      mint: result.mint,
      bucket: result.bucket,
      maxImpactBps: result.maxImpactBps,
    })),
    rejected: rejected.map((result) => ({
      symbol: result.symbol,
      mint: result.mint,
      bucket: result.bucket,
      riskFlags: result.riskFlags,
      maxImpactBps: result.maxImpactBps,
    })),
    dbTotals: dbTotals.rows[0],
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
