'use strict';
// Canary confirmation: did Noah enter any 12-45bps "demote band" token AFTER the
// demote-and-size deploy? Under the OLD code the sell-impact gate hard-blocked every
// entry whose 7-day exit cost was > 12bps, so ANY such NEW buy proves the new gate
// threshold + demote sizing is live in production.
//
// Usage: node tmp/edit-recovery/confirm-noah-canary.cjs [deployIso]
//   deployIso defaults to 2026-06-09T23:00:00Z (push time).

const { execFileSync } = require('child_process');

const NOAH_WALLET = 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const deployIso = process.argv[2] || '2026-06-09T23:00:00Z';

function q(sql) {
  const out = execFileSync('node', ['scripts/dbcli.mjs', sql], { encoding: 'utf8' });
  return JSON.parse(out).rows;
}

// All Noah BUYS (USDC/SOL -> token) since deploy, joined to each token's measured 7-day
// sell-side exit cost, with the band/full/no-history classification.
const sql = `
WITH si AS (
  SELECT input_mint AS mint,
         avg((build_response->>'priceImpactPct')::numeric*10000) AS exit_bps
    FROM swap_executions
   WHERE status='confirmed'
     AND created_at > now() - interval '7 days'
     AND build_response->>'priceImpactPct' IS NOT NULL
     AND output_mint IN ('${USDC}','${SOL}')
   GROUP BY input_mint
)
SELECT e.output_mint AS token_mint,
       round(si.exit_bps,1) AS exit_bps,
       e.status,
       e.created_at,
       CASE
         WHEN si.exit_bps IS NULL THEN 'no-history'
         WHEN si.exit_bps <= 12 THEN 'full'
         WHEN si.exit_bps < 45 THEN 'DEMOTE-BAND (new!)'
         ELSE 'wall'
       END AS band
  FROM swap_executions e
  LEFT JOIN si ON si.mint = e.output_mint
 WHERE e.taker='${NOAH_WALLET}'
   AND e.input_mint IN ('${USDC}','${SOL}')
   AND e.output_mint NOT IN ('${USDC}','${SOL}')
   AND e.created_at > '${deployIso}'
 ORDER BY e.created_at DESC
 LIMIT 40`;

const rows = q(sql);
console.log(`Noah BUYS since ${deployIso}: ${rows.length}`);
for (const r of rows) {
  console.log(`${(r.created_at||'').slice(11,19)}  ${String(r.exit_bps).padStart(6)}bps  ${String(r.band).padEnd(18)} ${r.status}  ${r.token_mint}`);
}
const bandHits = rows.filter((r) => r.band === 'DEMOTE-BAND (new!)');
console.log('');
if (bandHits.length > 0) {
  console.log(`CANARY CONFIRMED: ${bandHits.length} entr${bandHits.length === 1 ? 'y' : 'ies'} into the 12-45bps band that the old code would have hard-blocked.`);
} else {
  console.log('No band entries yet. Either Railway is still building, or no band token has thrown a buy signal yet. Re-run later.');
}
