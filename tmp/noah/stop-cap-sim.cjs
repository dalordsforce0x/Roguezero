require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  const r = await p.query(
    `select pnl_bps, max_favorable_bps mfe, max_adverse_bps mae, current_reason
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = $2
       and pnl_bps is not null`,
    [DAY, NOAH]);
  const rows = r.rows.map(x => ({ pnl: Number(x.pnl_bps), mfe: x.mfe==null?null:Number(x.mfe), mae: x.mae==null?null:Number(x.mae), reason: x.current_reason }));
  const actual = rows.reduce((s, x) => s + x.pnl, 0);
  console.log(`Noah closed positions today: ${rows.length}`);
  console.log(`ACTUAL total realized: ${actual.toFixed(0)} bps  (avg ${(actual/rows.length).toFixed(1)}/trade)\n`);

  // Simulate a hard stop cap S. Two bounds for MFE/MAE ordering ambiguity:
  //  conservative: if MAE <= -S, the stop hit (assume adverse came first) -> -S
  //  optimistic:   a winner that finished >0 with MFE>=S is assumed to have hit its target
  //                before the deep dip, so it keeps its actual pnl; only finishers that
  //                ended <=0 (or never ran up past S) get stopped at -S.
  for (const S of [40,50,60,70,80,90,100,120,150]) {
    let cons = 0, opt = 0, stoppedC = 0, stoppedO = 0;
    for (const x of rows) {
      const hitAdverse = x.mae !== null && x.mae <= -S;
      // conservative
      if (hitAdverse) { cons += -S; stoppedC++; } else { cons += x.pnl; }
      // optimistic: a real winner (final pnl>0 and ran up >= S) likely tagged target first
      const probablyWonFirst = x.pnl > 0 && x.mfe !== null && x.mfe >= S;
      if (hitAdverse && !probablyWonFirst) { opt += -S; stoppedO++; } else { opt += x.pnl; }
    }
    console.log(`stop cap ${String(S).padStart(3)}bps:  conservative=${cons.toFixed(0).padStart(6)} (${stoppedC} stopped)   optimistic=${opt.toFixed(0).padStart(6)} (${stoppedO} stopped)`);
  }
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
