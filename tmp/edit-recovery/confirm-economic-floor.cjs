// Confirms the cost-derived economic floor fired in production.
// Run after RogueCEO (or any sub-economic session) gets a buy signal.
// Looks for: (1) the live network-cost tracker producing a floor, (2) a clamp or
// skip event, (3) RogueCEO executions that no longer fail entry_leg_cost_too_high.
const { execSync } = require('child_process');

function db(sql) {
  const out = execSync(`node scripts/dbcli.mjs "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
  return JSON.parse(out.slice(out.indexOf('{')));
}

const CEO = 'ZfnpgA1mGBecTL3aCgriYe2oiEbSnofsjY9Fi73kgpD';
const CEO_SESSION = '299c83d6-fff0-4a2b-a46e-265b5fd8855e';

console.log('=== RogueCEO executions in last 30 min ===');
const ex = db(`select status, last_error->>'reason' as reason, amount, created_at from swap_executions where taker='${CEO}' and created_at > now() - interval '30 minutes' order by created_at desc limit 10`);
if (ex.rows.length === 0) {
  console.log('No new executions yet (RogueCEO has not signaled a buy in a non-flat regime).');
} else {
  for (const r of ex.rows) {
    const flag = r.reason === 'entry_leg_cost_too_high' ? ' <-- STILL CHURNING (bad)' : '';
    console.log(`${r.created_at} ${r.status} reason=${r.reason} amount=${r.amount}${flag}`);
  }
}

console.log('\n=== RogueCEO latest sizing/gate ===');
const s = db(`select service_control->'lastSizing'->>'reason' as sizing_reason, service_control->'lastSizing'->>'amountLamports' as amt, service_control->'lastTradeGate'->>'reason' as gate_reason from sessions where id='${CEO_SESSION}'`);
console.log(JSON.stringify(s.rows[0], null, 2));

console.log('\nIn the worker logs, a successful fire looks like:');
console.log('  "entry economic floor apply: SOL->TOKEN amount <small> -> <floor> floor=<n> (cost=<lamports> cap=120bps) sub-economic clamp"');
console.log('  or "entry blocked: economic floor <n> (cost=<lamports>, fees too high to trade economically) ..."');
console.log('Then the resulting execution should NOT carry reason=entry_leg_cost_too_high.');
