import "dotenv/config";
import pg from "pg";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const wallet = "DFcBDWuR4jr8Z4LMH2j2UWs5axKpC3ja7WL4TrQMJxJb";
function tokenDelta(tx, mint, owner) {
  const byKey = new Map();
  for (const b of tx?.preTokenBalances ?? []) {
    if (b.mint === mint && (!owner || b.owner === owner)) {
      const key = `${b.accountIndex}:${b.mint}:${b.owner ?? ''}`;
      const v = byKey.get(key) ?? { pre: 0, post: 0, decimals: Number(b.uiTokenAmount?.decimals ?? 0) };
      v.pre += Number(b.uiTokenAmount?.amount ?? 0);
      v.decimals = Number(b.uiTokenAmount?.decimals ?? v.decimals);
      byKey.set(key, v);
    }
  }
  for (const b of tx?.postTokenBalances ?? []) {
    if (b.mint === mint && (!owner || b.owner === owner)) {
      const key = `${b.accountIndex}:${b.mint}:${b.owner ?? ''}`;
      const v = byKey.get(key) ?? { pre: 0, post: 0, decimals: Number(b.uiTokenAmount?.decimals ?? 0) };
      v.post += Number(b.uiTokenAmount?.amount ?? 0);
      v.decimals = Number(b.uiTokenAmount?.decimals ?? v.decimals);
      byKey.set(key, v);
    }
  }
  let delta = 0, decimals = null, matched = false;
  for (const v of byKey.values()) { delta += v.post - v.pre; decimals = v.decimals; matched = true; }
  return matched ? { delta, decimals } : null;
}
function solDelta(tx, owner) {
  const keys = tx?.accountKeys ?? [];
  const i = keys.indexOf(owner);
  if (i < 0) return null;
  const pre = Number(tx?.preBalances?.[i] ?? NaN);
  const post = Number(tx?.postBalances?.[i] ?? NaN);
  return Number.isFinite(pre) && Number.isFinite(post) ? post - pre : null;
}
const rows = (await pool.query(`select id,input_mint,output_mint,amount,signature,confirmation,created_at,metadata from swap_executions where taker=$1 and status='confirmed' order by created_at asc`, [wallet])).rows;
const lots = [];
let pnl = 0;
for (const r of rows) {
  const tx = r.confirmation;
  if (r.input_mint === SOL && r.output_mint !== SOL) {
    const sd = solDelta(tx, wallet);
    const td = tokenDelta(tx, r.output_mint, wallet);
    const solSpentLamports = sd !== null && sd < 0 ? Math.abs(sd) : Number(r.amount);
    const outAtomic = td?.delta > 0 ? td.delta : Number(r.build_response?.outAmount ?? 0);
    const solUsdApprox = 65; // conservative local audit; exact API patch now fetches live Pyth on future entries
    const costUsd = (solSpentLamports / 1e9) * solUsdApprox;
    lots.push({ mint:r.output_mint, qtyAtomic:outAtomic, decimals:td?.decimals ?? 6, costUsd, sig:r.signature, at:r.created_at });
    console.log('ENTRY', r.created_at.toISOString(), r.output_mint.slice(0,4), 'qty', outAtomic, 'dec', td?.decimals, 'costUsd~', costUsd.toFixed(6));
  } else if (r.output_mint === USDC && r.input_mint !== USDC) {
    const td = tokenDelta(tx, r.input_mint, wallet);
    const ud = tokenDelta(tx, USDC, wallet);
    const soldAtomic = td?.delta < 0 ? Math.abs(td.delta) : Number(r.amount);
    const usdcOut = ud?.delta > 0 ? ud.delta / 1e6 : Number(r.build_response?.outAmount ?? 0) / 1e6;
    let remaining = soldAtomic;
    let costSold = 0;
    for (const lot of lots) {
      if (remaining <= 0 || lot.mint !== r.input_mint || lot.qtyAtomic <= 0) continue;
      const sell = Math.min(remaining, lot.qtyAtomic);
      costSold += lot.costUsd * (sell / lot.qtyAtomic);
      lot.qtyAtomic -= sell;
      remaining -= sell;
    }
    const delta = usdcOut - costSold;
    pnl += delta;
    console.log('EXIT ', r.created_at.toISOString(), r.input_mint.slice(0,4), 'usdcOut', usdcOut.toFixed(6), 'costSold~', costSold.toFixed(6), 'pnl~', delta.toFixed(6), r.metadata?.exitReason);
  }
}
console.log('CONSERVATIVE_RECONSTRUCTED_PNL_USD~', pnl.toFixed(6));
await pool.end();
