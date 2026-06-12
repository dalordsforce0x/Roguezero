// Safe, additive backfill: populate the new rz_token_universe metadata columns
// for mints ALREADY in the table. Does NOT change enabled flags, does NOT insert
// new rows, does NOT disable anything. Pure UPDATE of metadata for existing mints.
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env' });

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');

const TOKEN_API_BASE_URL = (process.env.JUPITER_TOKEN_API_BASE_URL || 'https://api.jup.ag/tokens/v2').replace(/\/$/, '');
const key = process.env.JUPITER_API_KEY;
if (!key) throw new Error('JUPITER_API_KEY required');

const asNum = (...vals) => {
  for (const v of vals) { const n = Number(v); if (Number.isFinite(n)) return n; }
  return null;
};
const asBool = (v) => (typeof v === 'boolean' ? v : null);
const hasVerifiedTag = (t) => Array.isArray(t?.tags) && t.tags.some((x) => String(x).toLowerCase() === 'verified');
const vol24 = (t) => asNum(t?.stats24h?.volume, t?.daily_volume, t?.volume24h)
  ?? ((Number(t?.stats24h?.buyVolume) || 0) + (Number(t?.stats24h?.sellVolume) || 0) || null);

const snapshot = (t) => {
  const a = t?.audit && typeof t.audit === 'object' ? t.audit : {};
  return {
    isVerified: asBool(t?.isVerified ?? t?.verified) ?? hasVerifiedTag(t),
    organicScore: asNum(t?.organicScore, t?.organic_score),
    organicScoreLabel: typeof t?.organicScoreLabel === 'string' ? t.organicScoreLabel : null,
    liquidityUsd: asNum(t?.liquidity, t?.liquidityUsd, t?.stats24h?.liquidity),
    volume24hUsd: vol24(t),
    mcapUsd: asNum(t?.mcap, t?.marketCap, t?.fdv),
    holderCount: asNum(t?.holderCount, t?.holder_count, t?.holders),
    topHoldersPct: asNum(a.topHoldersPercentage, a.top_holders_percentage),
    devBalancePct: asNum(a.devBalancePercentage, a.dev_balance_percentage),
    priceChange1hPct: asNum(t?.stats1h?.priceChange),
    priceChange24hPct: asNum(t?.stats24h?.priceChange),
    mintAuthDisabled: asBool(a.mintAuthorityDisabled ?? a.mint_authority_disabled),
    freezeAuthDisabled: asBool(a.freezeAuthorityDisabled ?? a.freeze_authority_disabled),
    isSus: asBool(a.isSus ?? a.sus ?? a.is_sus),
  };
};

const sources = [
  'toporganicscore/24h?limit=400',
  'toptrending/24h?limit=400',
  'toptraded/24h?limit=400',
  'tag?query=verified',
];

const main = async () => {
  const byMint = new Map();
  for (const path of sources) {
    const res = await fetch(`${TOKEN_API_BASE_URL}/${path}`, { headers: { 'x-api-key': key, Accept: 'application/json' } });
    if (!res.ok) { console.error(`[backfill] ${path} -> ${res.status}`); continue; }
    const arr = await res.json();
    if (!Array.isArray(arr)) continue;
    for (const t of arr) {
      const mint = t?.id ?? t?.address ?? t?.mint;
      if (typeof mint === 'string' && !byMint.has(mint)) byMint.set(mint, snapshot(t));
    }
    console.error(`[backfill] ${path}: ${arr.length} tokens`);
  }

  const parsed = new URL(databaseUrl);
  parsed.searchParams.delete('sslmode');
  const client = new pg.Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const existing = await client.query('SELECT mint FROM public.rz_token_universe');
    let updated = 0;
    for (const row of existing.rows) {
      const s = byMint.get(row.mint);
      if (!s) continue;
      await client.query(
        `UPDATE public.rz_token_universe SET
           is_verified=$2, organic_score=$3, organic_score_label=$4,
           liquidity_usd=$5, volume_24h_usd=$6, mcap_usd=$7,
           holder_count=$8, top_holders_pct=$9, dev_balance_pct=$10,
           price_change_1h_pct=$11, price_change_24h_pct=$12,
           mint_auth_disabled=$13, freeze_auth_disabled=$14, is_sus=$15,
           synced_at=now()
         WHERE mint=$1`,
        [
          row.mint, s.isVerified, s.organicScore, s.organicScoreLabel,
          s.liquidityUsd, s.volume24hUsd, s.mcapUsd,
          s.holderCount, s.topHoldersPct, s.devBalancePct,
          s.priceChange1hPct, s.priceChange24hPct,
          s.mintAuthDisabled, s.freezeAuthDisabled, s.isSus,
        ],
      );
      updated++;
    }
    console.log(JSON.stringify({ tableMints: existing.rows.length, jupiterMints: byMint.size, updated }, null, 2));
  } finally {
    await client.end();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
