import "dotenv/config";
import pg from "pg";
const SOL = "So11111111111111111111111111111111111111112";
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const sid = "3951496c-5459-4298-8369-fb873e2ef613";
const wallet = "DFcBDWuR4jr8Z4LMH2j2UWs5axKpC3ja7WL4TrQMJxJb";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const ex = await pool.query(`select amount, confirmation from swap_executions where taker=$1 and input_mint=$2 and output_mint=$3 and status='confirmed' order by created_at desc limit 1`, [wallet, SOL, JITO]);
const row = ex.rows[0];
function tokenDelta(tx, mint, owner) {
  const map = new Map();
  for (const b of tx?.preTokenBalances ?? []) if (b.mint===mint && b.owner===owner) map.set(b.accountIndex, {pre:Number(b.uiTokenAmount?.amount??0), post:0, dec:Number(b.uiTokenAmount?.decimals??6)});
  for (const b of tx?.postTokenBalances ?? []) if (b.mint===mint && b.owner===owner) {
    const v = map.get(b.accountIndex) ?? {pre:0, post:0, dec:Number(b.uiTokenAmount?.decimals??6)};
    v.post = Number(b.uiTokenAmount?.amount??0); v.dec = Number(b.uiTokenAmount?.decimals??v.dec); map.set(b.accountIndex,v);
  }
  let delta=0, dec=6; for (const v of map.values()) { delta += v.post-v.pre; dec=v.dec; }
  return {delta, dec};
}
const d = tokenDelta(row.confirmation, JITO, wallet);
const qtyUi = d.delta / (10 ** d.dec);
const solUsd = 64.3;
const costUsd = (Number(row.amount) / 1e9) * solUsd;
const entryPrice = costUsd / qtyUi;
console.log({amount: row.amount, tokenDelta: d.delta, decimals: d.dec, qtyUi, costUsd, entryPrice});
await pool.query(`update sessions
set service_control = jsonb_set(
  jsonb_set(
    jsonb_set(service_control, '{positionsState,positions,${JITO},entryPriceUsd}', to_jsonb($2::numeric), true),
    '{positionsState,positions,${JITO},highWaterPriceUsd}', to_jsonb($2::numeric), true
  ),
  '{positionState,entryPriceUsd}', to_jsonb($2::numeric), true
)
where id=$1`, [sid, entryPrice]);
const s = await pool.query(`select service_control->'positionsState'->'positions'->$2 as pos from sessions where id=$1`, [sid, JITO]);
console.log(JSON.stringify(s.rows[0].pos, null, 2));
await pool.end();
