'use strict';
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'latin1');
const L = (...lines) => lines.join('\r\n');

const edits = [];

// Edit A: add metadata type + map right after the symbol map declaration
edits.push({
  name: 'A: metadata type + map',
  old: L('const tokenUniverseSymbolByMint = new Map<string, string>();'),
  neu: L(
    'const tokenUniverseSymbolByMint = new Map<string, string>();',
    'type TokenUniverseMeta = {',
    '  isVerified: boolean | null;',
    '  organicScore: number | null;',
    '  liquidityUsd: number | null;',
    '  volume24hUsd: number | null;',
    '  mcapUsd: number | null;',
    '  holderCount: number | null;',
    '  topHoldersPct: number | null;',
    '  priceChange1hPct: number | null;',
    '  priceChange24hPct: number | null;',
    '};',
    'const tokenUniverseMetaByMint = new Map<string, TokenUniverseMeta>();',
  ),
});

// Edit B: extend the row type with metadata fields
edits.push({
  name: 'B: TokenUniverseRow fields',
  old: L(
    'type TokenUniverseRow = {',
    '  mint: string | null;',
    '  symbol: string | null;',
    '  enabled: boolean;',
    '  notes: string | null;',
    '};',
  ),
  neu: L(
    'type TokenUniverseRow = {',
    '  mint: string | null;',
    '  symbol: string | null;',
    '  enabled: boolean;',
    '  notes: string | null;',
    '  is_verified: boolean | null;',
    '  organic_score: number | string | null;',
    '  liquidity_usd: number | string | null;',
    '  volume_24h_usd: number | string | null;',
    '  mcap_usd: number | string | null;',
    '  holder_count: number | string | null;',
    '  top_holders_pct: number | string | null;',
    '  price_change_1h_pct: number | string | null;',
    '  price_change_24h_pct: number | string | null;',
    '};',
  ),
});

// Edit C1: build the metadata SELECT clause + append it to the query
edits.push({
  name: 'C1: metadata select clause',
  old: L(
    '    const notesSelect = notesColumn && isSafeSqlIdentifier(notesColumn)',
    '      ? `, ${notesColumn}::text AS notes`',
    '      : `, NULL::text AS notes`;',
    '    const query = `SELECT ${mintColumn}::text AS mint${symbolSelect}${enabledSelect}${notesSelect}',
  ),
  neu: L(
    '    const notesSelect = notesColumn && isSafeSqlIdentifier(notesColumn)',
    '      ? `, ${notesColumn}::text AS notes`',
    '      : `, NULL::text AS notes`;',
    '    const metaSelect = (col: string, cast: string) =>',
    '      columns.has(col) && isSafeSqlIdentifier(col)',
    '        ? `, ${col}::${cast} AS ${col}`',
    '        : `, NULL::${cast} AS ${col}`;',
    '    const metadataSelect =',
    "      metaSelect('is_verified', 'boolean')",
    "      + metaSelect('organic_score', 'numeric')",
    "      + metaSelect('liquidity_usd', 'numeric')",
    "      + metaSelect('volume_24h_usd', 'numeric')",
    "      + metaSelect('mcap_usd', 'numeric')",
    "      + metaSelect('holder_count', 'numeric')",
    "      + metaSelect('top_holders_pct', 'numeric')",
    "      + metaSelect('price_change_1h_pct', 'numeric')",
    "      + metaSelect('price_change_24h_pct', 'numeric');",
    '    const query = `SELECT ${mintColumn}::text AS mint${symbolSelect}${enabledSelect}${notesSelect}${metadataSelect}',
  ),
});

// Edit C2: clear + populate the metadata map inside the existing row loop
edits.push({
  name: 'C2: populate metadata map',
  old: L(
    '    tokenUniverseSymbolByMint.clear();',
    '    for (const row of approvedRows) {',
    "      const mint = row.mint ?? '';",
    '      if (!solanaPublicKeyPattern.test(mint)) continue;',
    '      if (isHardBlockedUniverseToken({ mint, symbol: row.symbol })) continue;',
    '      const symbol = row.symbol?.trim();',
    '      if (symbol && symbol.length > 0) {',
    '        tokenUniverseSymbolByMint.set(mint, symbol.toUpperCase());',
    '      }',
    '    }',
  ),
  neu: L(
    '    tokenUniverseSymbolByMint.clear();',
    '    tokenUniverseMetaByMint.clear();',
    '    const parseUniverseNum = (v: unknown): number | null => {',
    '      if (v === null || v === undefined) return null;',
    '      const n = Number(v);',
    '      return Number.isFinite(n) ? n : null;',
    '    };',
    '    for (const row of approvedRows) {',
    "      const mint = row.mint ?? '';",
    '      if (!solanaPublicKeyPattern.test(mint)) continue;',
    '      if (isHardBlockedUniverseToken({ mint, symbol: row.symbol })) continue;',
    '      const symbol = row.symbol?.trim();',
    '      if (symbol && symbol.length > 0) {',
    '        tokenUniverseSymbolByMint.set(mint, symbol.toUpperCase());',
    '      }',
    '      tokenUniverseMetaByMint.set(mint, {',
    "        isVerified: typeof row.is_verified === 'boolean' ? row.is_verified : null,",
    '        organicScore: parseUniverseNum(row.organic_score),',
    '        liquidityUsd: parseUniverseNum(row.liquidity_usd),',
    '        volume24hUsd: parseUniverseNum(row.volume_24h_usd),',
    '        mcapUsd: parseUniverseNum(row.mcap_usd),',
    '        holderCount: parseUniverseNum(row.holder_count),',
    '        topHoldersPct: parseUniverseNum(row.top_holders_pct),',
    '        priceChange1hPct: parseUniverseNum(row.price_change_1h_pct),',
    '        priceChange24hPct: parseUniverseNum(row.price_change_24h_pct),',
    '      });',
    '    }',
  ),
});

for (const e of edits) {
  const count = src.split(e.old).length - 1;
  if (count !== 1) {
    console.error(`FAIL [${e.name}]: expected exactly 1 occurrence, found ${count}`);
    process.exit(1);
  }
  src = src.replace(e.old, e.neu);
  console.log(`OK [${e.name}]`);
}

fs.writeFileSync(path, src, 'latin1');
console.log('WROTE', path);
