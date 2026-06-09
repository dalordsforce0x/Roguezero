require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  // Inspect the SOL major losers: strategy, entry/mark prices, shape metrics from evaluation jsonb
  const r = await p.query(
    `select symbol, current_reason, pnl_bps, max_favorable_bps mfe, max_adverse_bps mae,
            entry_quality_score, entry_quality_band,
            evaluation->>'strategy' strat,
            evaluation->>'entryPriceUsd' entry,
            evaluation->>'markPriceUsd' mark,
            thresholds->>'mode' tmode,
            thresholds->>'stopLossBps' stop,
            thresholds->>'atrBps' atr,
            created_at
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = $2
       and token_class='major' and entry_quality_band is null and pnl_bps is not null
     order by pnl_bps asc limit 25`,
    [DAY, NOAH]);
  console.log(`null-band major rows: ${r.rows.length}`);
  for (const x of r.rows) {
    console.log(`  ${String(x.symbol).padEnd(5)} ${String(x.current_reason).padEnd(14)} pnl=${String(x.pnl_bps).padStart(6)} mfe=${String(x.mfe).padStart(5)} mae=${String(x.mae).padStart(6)} strat=${x.strat} stop=${x.stop} atr=${x.atr} mode=${x.tmode} entry=${x.entry} mark=${x.mark}`);
  }

  // Also: are these distinct positions or the same SOL position re-evaluated many times?
  const d = await p.query(
    `select count(*) total_rows, count(distinct evaluation->>'entryPriceUsd') distinct_entries,
            count(distinct date_trunc('minute', created_at)) distinct_minutes
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = $2
       and token_class='major' and entry_quality_band is null and pnl_bps is not null`,
    [DAY, NOAH]);
  console.log('\nDistinctness:', JSON.stringify(d.rows[0]));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
