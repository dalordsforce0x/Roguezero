require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';

// ---- AI confidence grade: built from signals proven to correlate with profit ----
// Inputs per closed position (final state):
//   strat        : supertrend (confirmed trend, good) vs mean_reversion (knife-catch, bad)
//   tokenClass   : sol_beta / fair-scored = profitable; major SOL mean_rev = bad
//   eqScore      : entry_quality_score 0-100 (when present)
//   tpReachable  : did the realistic TP target clear the cost floor? (the gate)
//   peakUp(mfe)  : how far the trade actually ran in our favor (bps)
// Output: 0-100 confidence -> letter grade.
function gradeTrade(t) {
  let score = 50; // neutral base
  const notes = [];

  // 1. Strategy quality (proven: supertrend +, mean_reversion - on majors)
  if (t.strat === 'supertrend') { score += 12; notes.push('trend-confirmed'); }
  else if (t.strat === 'mean_reversion') { score -= 12; notes.push('dip-buy(risky)'); }

  // 2. Token class (proven: sol_beta profitable; major SOL bleeds)
  if (t.tokenClass === 'sol_beta') { score += 10; notes.push('sol_beta'); }
  else if (t.tokenClass === 'major') { score -= 8; notes.push('major(low-move)'); }
  else if (t.tokenClass === 'long_tail') { score -= 4; notes.push('long_tail'); }

  // 3. Entry quality score (the shadow scorer)
  if (t.eqScore != null) {
    score += Math.round((t.eqScore - 55) * 0.4); // >55 helps, <55 hurts
    notes.push(`eq${t.eqScore}`);
  }

  // 4. TP reachability vs cost floor (the cost-floor gate logic)
  if (t.tpReachable === true) { score += 14; notes.push('TP-reachable'); }
  else if (t.tpReachable === false) { score -= 18; notes.push('TP-UNREACHABLE'); }

  // 5. Actual room the move had (MFE) — proxy for whether there was real edge
  if (t.mfe != null) {
    if (t.mfe >= 80) { score += 8; }
    else if (t.mfe >= 40) { score += 3; }
    else if (t.mfe < 20) { score -= 6; notes.push('thin-move'); }
  }

  score = Math.max(0, Math.min(100, score));
  let grade = 'F';
  if (score >= 85) grade = 'A';
  else if (score >= 72) grade = 'B';
  else if (score >= 58) grade = 'C';
  else if (score >= 45) grade = 'D';
  return { score, grade, notes };
}

(async () => {
  // Pull final state per closed Noah position today
  const r = await p.query(
    `with pos as (
       select evaluation->>'entryPriceUsd' entry,
              evaluation->>'strategy' strat,
              token_class,
              (array_agg(symbol order by created_at desc))[1] sym,
              (array_agg(entry_quality_score order by created_at desc))[1] eq,
              (array_agg(pnl_bps order by created_at desc))[1] final_pnl,
              max(max_favorable_bps) mfe,
              (array_agg(current_reason order by created_at desc))[1] reason,
              (array_agg((thresholds->>'takeProfitBps')::numeric order by created_at desc))[1] tp,
              (array_agg((thresholds->>'costFloorBps')::numeric order by created_at desc))[1] floor,
              (array_agg((thresholds->>'atrBps')::numeric order by created_at desc))[1] atr,
              min(created_at) opened
       from exit_shadow_decisions
       where created_at >= $1 and session_id=$2 and current_should_exit=true
         and evaluation->>'entryPriceUsd' is not null and pnl_bps is not null
       group by entry, strat, token_class)
     select * from pos order by opened`,
    [DAY, NOAH]);

  const graded = r.rows.map(x => {
    // tpReachable: did the realistic ATR target clear the cost floor?
    const tpMult = x.token_class === 'major' ? 1.4 : x.token_class === 'sol_beta' ? 1.6 : x.token_class === 'trend_liquid' ? 0.8 : 2.6;
    const reachableTp = x.atr != null ? Math.round(Number(x.atr) * tpMult) : null;
    const tpReachable = (reachableTp != null && x.floor != null) ? reachableTp >= Number(x.floor) : null;
    const g = gradeTrade({
      strat: x.strat, tokenClass: x.token_class,
      eqScore: x.eq != null ? Number(x.eq) : null,
      tpReachable, mfe: x.mfe != null ? Number(x.mfe) : null,
    });
    return { ...x, ...g, final_pnl: Number(x.final_pnl) };
  });

  console.log('=== AI CONFIDENCE GRADE — Noah trades today ===\n');
  console.log('grade  conf  sym    class         strat           finalPnL   signals');
  for (const t of graded) {
    const bar = '#'.repeat(Math.round(t.score/10)).padEnd(10);
    console.log(`  ${t.grade}   ${String(t.score).padStart(3)}  ${String(t.sym).padEnd(5)} ${String(t.token_class).padEnd(12)} ${String(t.strat).padEnd(14)} ${String(t.final_pnl).padStart(6)}   ${t.notes.join(',')}`);
  }

  // VALIDATION: does the grade predict actual PnL?
  console.log('\n=== VALIDATION: avg actual PnL by grade (does the grade work?) ===');
  const byGrade = {};
  for (const t of graded) {
    (byGrade[t.grade] ??= []).push(t.final_pnl);
  }
  for (const g of ['A','B','C','D','F']) {
    const arr = byGrade[g]; if (!arr) continue;
    const avg = arr.reduce((s,v)=>s+v,0)/arr.length;
    const wins = arr.filter(v=>v>0).length;
    const bar = (avg>=0?'+':'').padStart(1);
    console.log(`  ${g}: n=${String(arr.length).padStart(2)}  avgPnL=${avg.toFixed(0).padStart(5)}bps  wins=${wins}/${arr.length}  ${avg>=0?'PROFITABLE':'losing'}`);
  }
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
