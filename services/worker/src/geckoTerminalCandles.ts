// ── GeckoTerminal shared 1-minute candle feed ────────────────────────────────
//
// WHY THIS EXISTS
// The live entry scorer, the honest-cost ATR gate, and the ATR exit stops all
// call computeAtrFromTape(getMomentumTapeForMint(mint)). For most candidate
// tokens that live tape is a thin 3s/60s Jupiter price tape — too short to build
// an ATR (needs ~120 samples), so ATR comes back null and every cost/shape check
// fails OPEN. The result is the Problem-B churn: we buy thin tokens we cannot
// price the round-trip cost of, then force-sell them at a loss.
//
// This module maintains a SHARED, fleet-wide cache of real 1-minute OHLCV candles
// for the active token universe, pulled from GeckoTerminal (free, no API key, on-
// chain DEX data). One feed serves every session — never one fetch per bot. All
// network calls are routed through the provider-governor rate bucket the caller
// injects, so the fleet-wide GeckoTerminal call rate stays well under the free
// ~30 req/min ceiling.
//
// Attribution: data via GeckoTerminal (https://www.geckoterminal.com).
//
// The module is dependency-injected (fetchJson / acquire / sleep / now / log) so
// it is fully unit-testable without network or a database.

export type GeckoCandlePoint = {
  /** Candle close price in USD. */
  usdPrice: number;
  /** ISO timestamp of the candle close (PriceSample-compatible). */
  sampledAt: string;
  /** Unix seconds of the candle open, as returned by GeckoTerminal. */
  ts: number;
};

export type GeckoCandleFeedDeps = {
  /** Fetch + parse JSON for a URL. Must resolve null on any non-OK / error. */
  fetchJson: (url: string) => Promise<unknown | null>;
  /** Reserve one GeckoTerminal request token from the shared governor bucket. */
  acquire: () => Promise<void>;
  /** Sleep helper (injected for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock (injected for tests). */
  now?: () => number;
  /** Structured logger. */
  log?: (entry: Record<string, unknown>) => void;
  /** Override the GeckoTerminal Solana base URL (tests). */
  baseUrl?: string;
  /** Pool-address cache TTL in ms (default 24h). */
  poolTtlMs?: number;
  nullPoolTtlMs?: number;
  /** Max candle points retained per mint (default 240 = 4h of 1-min candles). */
  maxCandlesPerMint?: number;
  /** Inter-call spacing in ms applied in addition to the governor (default 1200). */
  callSpacingMs?: number;
};

export type GeckoCandleCoverage = {
  mints: number;
  freshMints: number;
  oldestFreshAgeMs: number | null;
};

export type GeckoCandleRefreshResult = {
  refreshed: number;
  failed: number;
  skipped: number;
};

const GT_DEFAULT_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';
const DEFAULT_POOL_TTL_MS = 24 * 60 * 60 * 1000;
// A NULL pool result (lookup failed, usually a 429 on the cloud egress IP) must
// NOT be cached for the full 24h pool TTL -- that poisons a token's candles for a
// whole day after one transient failure, forcing it onto the blind 60s fallback
// tape. Retry null lookups soon so a token recovers on the next refresh tick.
const DEFAULT_NULL_POOL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CANDLES = 240;
const DEFAULT_CALL_SPACING_MS = 1200;
const DEFAULT_FRESH_TTL_MS = 15 * 60 * 1000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Extract the top pool address from a GeckoTerminal /tokens/{mint}/pools response.
 * The first pool is the highest-liquidity pool for the token. Returns null when
 * the response has no usable pool address.
 */
export const selectTopPoolAddress = (json: unknown): string | null => {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const top = data[0] as { attributes?: { address?: unknown }; id?: unknown };
  const address = top?.attributes?.address;
  if (typeof address === 'string' && address.length > 0) return address;
  // Fallback to the prefixed id form ("solana_<addr>").
  if (typeof top?.id === 'string' && top.id.length > 0) {
    return top.id.replace(/^solana_/, '');
  }
  return null;
};

/**
 * Convert a GeckoTerminal ohlcv_list ([[t,o,h,l,c,v], ...], newest-first) into an
 * ascending array of candle close points. Rows with non-finite timestamp or close
 * are dropped.
 */
export const parseOhlcvList = (json: unknown): GeckoCandlePoint[] => {
  const list = (json as { data?: { attributes?: { ohlcv_list?: unknown } } })
    ?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const points: GeckoCandlePoint[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const ts = Number(row[0]);
    const close = Number(row[4]);
    if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) continue;
    points.push({ ts, usdPrice: close, sampledAt: new Date(ts * 1000).toISOString() });
  }
  points.sort((a, b) => a.ts - b.ts);
  return points;
};

type PoolCacheEntry = { poolAddress: string | null; fetchedAtMs: number };
type CandleCacheEntry = { points: GeckoCandlePoint[]; fetchedAtMs: number; poolAddress: string };

export type GeckoTerminalCandleFeed = {
  refreshMints: (mints: readonly string[]) => Promise<GeckoCandleRefreshResult>;
  getTape: (mint: string) => readonly GeckoCandlePoint[];
  getCloses: (mint: string) => number[];
  hasFreshCandles: (mint: string, freshTtlMs?: number) => boolean;
  getCoverage: (freshTtlMs?: number) => GeckoCandleCoverage;
};

/**
 * Create a shared GeckoTerminal candle feed. The returned feed keeps an in-memory
 * cache (pool addresses + 1-min candles) shared across all sessions in this
 * worker. refreshMints() is meant to be driven by a single fleet-wide poll loop.
 */
export const createGeckoTerminalCandleFeed = (
  deps: GeckoCandleFeedDeps,
): GeckoTerminalCandleFeed => {
  const baseUrl = (deps.baseUrl ?? GT_DEFAULT_BASE).replace(/\/+$/, '');
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const poolTtlMs = deps.poolTtlMs ?? DEFAULT_POOL_TTL_MS;
  const nullPoolTtlMs = deps.nullPoolTtlMs ?? DEFAULT_NULL_POOL_TTL_MS;
  const maxCandles = Math.max(1, deps.maxCandlesPerMint ?? DEFAULT_MAX_CANDLES);
  const callSpacingMs = Math.max(0, deps.callSpacingMs ?? DEFAULT_CALL_SPACING_MS);

  const poolCache = new Map<string, PoolCacheEntry>();
  const candleCache = new Map<string, CandleCacheEntry>();

  const resolvePoolAddress = async (mint: string): Promise<string | null> => {
    const cached = poolCache.get(mint);
    if (cached) {
      const effectiveTtlMs = cached.poolAddress === null ? nullPoolTtlMs : poolTtlMs;
      if (now() - cached.fetchedAtMs < effectiveTtlMs) {
        return cached.poolAddress;
      }
    }
    await deps.acquire();
    if (callSpacingMs > 0) await sleep(callSpacingMs);
    const json = await deps.fetchJson(`${baseUrl}/tokens/${mint}/pools?page=1`);
    const poolAddress = selectTopPoolAddress(json);
    // Cache the result. A null (failed/no-pool) result uses nullPoolTtlMs so a
    // transient 429 recovers within minutes instead of being stuck for 24h.
    poolCache.set(mint, { poolAddress, fetchedAtMs: now() });
    return poolAddress;
  };

  const refreshMint = async (mint: string): Promise<'refreshed' | 'failed'> => {
    const poolAddress = await resolvePoolAddress(mint);
    if (!poolAddress) {
      log({ kind: 'gecko_candle_no_pool', mint });
      return 'failed';
    }
    await deps.acquire();
    if (callSpacingMs > 0) await sleep(callSpacingMs);
    const beforeTs = Math.floor(now() / 1000) + 60;
    const url = `${baseUrl}/pools/${poolAddress}/ohlcv/minute`
      + `?aggregate=1&before_timestamp=${beforeTs}&limit=1000&currency=usd`;
    const json = await deps.fetchJson(url);
    const points = parseOhlcvList(json);
    if (points.length === 0) {
      log({ kind: 'gecko_candle_empty', mint, poolAddress });
      return 'failed';
    }
    const trimmed = points.length > maxCandles ? points.slice(points.length - maxCandles) : points;
    candleCache.set(mint, { points: trimmed, fetchedAtMs: now(), poolAddress });
    return 'refreshed';
  };

  const refreshMints = async (mints: readonly string[]): Promise<GeckoCandleRefreshResult> => {
    let refreshed = 0;
    let failed = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (const mint of mints) {
      if (!mint || seen.has(mint)) {
        skipped += 1;
        continue;
      }
      seen.add(mint);
      try {
        const outcome = await refreshMint(mint);
        if (outcome === 'refreshed') refreshed += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        log({
          kind: 'gecko_candle_refresh_error',
          mint,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { refreshed, failed, skipped };
  };

  const getTape = (mint: string): readonly GeckoCandlePoint[] =>
    candleCache.get(mint)?.points ?? [];

  const getCloses = (mint: string): number[] =>
    (candleCache.get(mint)?.points ?? []).map((p) => p.usdPrice);

  const hasFreshCandles = (mint: string, freshTtlMs = DEFAULT_FRESH_TTL_MS): boolean => {
    const entry = candleCache.get(mint);
    if (!entry || entry.points.length === 0) return false;
    return now() - entry.fetchedAtMs < freshTtlMs;
  };

  const getCoverage = (freshTtlMs = DEFAULT_FRESH_TTL_MS): GeckoCandleCoverage => {
    let freshMints = 0;
    let oldestFreshAgeMs: number | null = null;
    const nowMs = now();
    for (const entry of candleCache.values()) {
      const ageMs = nowMs - entry.fetchedAtMs;
      if (entry.points.length > 0 && ageMs < freshTtlMs) {
        freshMints += 1;
        if (oldestFreshAgeMs === null || ageMs > oldestFreshAgeMs) {
          oldestFreshAgeMs = ageMs;
        }
      }
    }
    return { mints: candleCache.size, freshMints, oldestFreshAgeMs };
  };

  return { refreshMints, getTape, getCloses, hasFreshCandles, getCoverage };
};
