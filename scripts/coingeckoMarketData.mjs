// Shared CoinGecko market-data helper for the token-universe admission/enrichment path.
//
// PURPOSE
// -------
// CoinGecko is NOT in the hot trading path. It is used only at *admission* time to enrich
// the token universe with slow-moving context (market cap + market-cap rank) so the feeder
// can refuse genuinely micro-cap / illiquid tokens before they ever become tradeable.
//
// SAFETY POSTURE
// --------------
// - All fetches are best-effort. On any failure this module returns an EMPTY map and never
//   throws, so a CoinGecko outage can never block token admission or break the feeder.
// - The contract list (/coins/list?include_platform=true) is cached to a tmp file with a TTL
//   to avoid re-pulling the multi-MB list on every feeder run.
//
// API TIERS
// ---------
// - Pro:     base https://pro-api.coingecko.com/api/v3, header `x-cg-pro-api-key`
// - Demo:    base https://api.coingecko.com/api/v3,     header `x-cg-demo-api-key`
// - Keyless: base https://api.coingecko.com/api/v3,     no auth header (heavily rate-limited)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COINGECKO_API_KEY = (process.env.COINGECKO_API_KEY ?? '').trim();
const COINGECKO_API_PLAN = (process.env.COINGECKO_API_PLAN ?? (COINGECKO_API_KEY ? 'demo' : 'none')).trim().toLowerCase();
const COINGECKO_BASE_URL = (
  process.env.COINGECKO_BASE_URL
  || (COINGECKO_API_PLAN === 'pro' ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3')
).replace(/\/$/, '');

const LIST_CACHE_TTL_MS = Number(process.env.COINGECKO_LIST_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000); // 6h
const LIST_CACHE_PATH = path.join(os.tmpdir(), 'rz-coingecko-solana-contract-map.json');
const MARKETS_PAGE_SIZE = 250; // CoinGecko hard cap for /coins/markets per_page
const MARKETS_SLEEP_MS = Number(process.env.COINGECKO_MARKETS_SLEEP_MS ?? 1500);
const REQUEST_TIMEOUT_MS = Number(process.env.COINGECKO_REQUEST_TIMEOUT_MS ?? 20_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const coingeckoConfigured = () => COINGECKO_API_PLAN !== 'none' || true; // keyless still works

const coingeckoHeaders = () => {
  const headers = { accept: 'application/json' };
  if (COINGECKO_API_KEY) {
    headers[COINGECKO_API_PLAN === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = COINGECKO_API_KEY;
  }
  return headers;
};

const fetchJson = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: coingeckoHeaders(), signal: controller.signal });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`CoinGecko ${res.status} ${url}: ${body}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const readListCache = () => {
  try {
    const stat = fs.statSync(LIST_CACHE_PATH);
    if (Date.now() - stat.mtimeMs > LIST_CACHE_TTL_MS) return null;
    const parsed = JSON.parse(fs.readFileSync(LIST_CACHE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.map) return new Map(Object.entries(parsed.map));
    return null;
  } catch {
    return null;
  }
};

const writeListCache = (map) => {
  try {
    fs.writeFileSync(LIST_CACHE_PATH, JSON.stringify({ savedAt: Date.now(), map: Object.fromEntries(map) }));
  } catch {
    // cache is best-effort
  }
};

// Build Map(solanaMint -> coingeckoId) from /coins/list?include_platform=true.
// Cached on disk with a TTL because the raw list is large and changes slowly.
export const fetchSolanaContractMap = async () => {
  const cached = readListCache();
  if (cached) return cached;

  const url = `${COINGECKO_BASE_URL}/coins/list?include_platform=true`;
  const list = await fetchJson(url);
  if (!Array.isArray(list)) throw new Error('CoinGecko /coins/list returned unexpected shape');

  const map = new Map();
  for (const coin of list) {
    const solanaMint = coin?.platforms?.solana;
    if (typeof solanaMint === 'string' && solanaMint.length >= 32 && typeof coin?.id === 'string') {
      map.set(solanaMint, coin.id);
    }
  }
  writeListCache(map);
  return map;
};

// Fetch market data for a set of CoinGecko ids via paginated /coins/markets.
// Returns Map(coingeckoId -> { marketCapUsd, marketCapRank, name, symbol, fdvUsd, volume24hUsd }).
const fetchMarketDataByIds = async (ids) => {
  const result = new Map();
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];

  for (let i = 0; i < unique.length; i += MARKETS_PAGE_SIZE) {
    const chunk = unique.slice(i, i + MARKETS_PAGE_SIZE);
    const url = new URL(`${COINGECKO_BASE_URL}/coins/markets`);
    url.searchParams.set('vs_currency', 'usd');
    url.searchParams.set('ids', chunk.join(','));
    url.searchParams.set('per_page', String(MARKETS_PAGE_SIZE));
    url.searchParams.set('page', '1');
    url.searchParams.set('sparkline', 'false');

    const page = await fetchJson(url.toString());
    if (Array.isArray(page)) {
      for (const row of page) {
        if (typeof row?.id !== 'string') continue;
        result.set(row.id, {
          marketCapUsd: Number.isFinite(Number(row.market_cap)) ? Number(row.market_cap) : null,
          marketCapRank: Number.isFinite(Number(row.market_cap_rank)) ? Number(row.market_cap_rank) : null,
          fdvUsd: Number.isFinite(Number(row.fully_diluted_valuation)) ? Number(row.fully_diluted_valuation) : null,
          volume24hUsd: Number.isFinite(Number(row.total_volume)) ? Number(row.total_volume) : null,
          name: typeof row.name === 'string' ? row.name : null,
          symbol: typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null,
        });
      }
    }
    if (i + MARKETS_PAGE_SIZE < unique.length) await sleep(MARKETS_SLEEP_MS);
  }

  return result;
};

// Top-level helper: given a list of Solana mints, return Map(mint -> marketData) for the
// subset that CoinGecko knows about. Mints not on CoinGecko are simply absent from the map.
//
// Best-effort: on any error this resolves to an empty Map and logs a warning, so callers can
// treat "no CoinGecko opinion" as "do not reject on market-cap grounds".
export const buildMintMarketDataMap = async (mints) => {
  const out = new Map();
  try {
    const wanted = new Set((mints ?? []).filter((m) => typeof m === 'string' && m.length >= 32));
    if (wanted.size === 0) return out;

    const contractMap = await fetchSolanaContractMap();
    const idToMint = new Map();
    for (const mint of wanted) {
      const id = contractMap.get(mint);
      if (id) idToMint.set(id, mint);
    }
    if (idToMint.size === 0) return out;

    const marketData = await fetchMarketDataByIds([...idToMint.keys()]);
    for (const [id, data] of marketData) {
      const mint = idToMint.get(id);
      if (mint) out.set(mint, { coingeckoId: id, ...data });
    }
    return out;
  } catch (err) {
    console.error('[coingecko] enrichment failed (best-effort, continuing without it):', String(err?.message ?? err));
    return out;
  }
};

export const coingeckoMeta = () => ({
  plan: COINGECKO_API_PLAN,
  baseUrl: COINGECKO_BASE_URL,
  keyConfigured: COINGECKO_API_KEY.length > 0,
});
