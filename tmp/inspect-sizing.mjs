import 'dotenv/config';
import pg from 'pg';
import { Connection, PublicKey } from '@solana/web3.js';

const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const sid = '3951496c-5459-4298-8369-fb873e2ef613';
const r = await pool.query(
  `select id, status, session_wallet,
     funding->>'fundingMint' as funding_mint,
     funding->>'startingBalanceAtomic' as starting_atomic,
     funding->>'currentBalanceAtomic' as current_atomic,
     funding->>'realizedPnlUsd' as realized_pnl,
     risk_limits->>'maxPositionSizeUsd' as max_pos_usd,
     risk_limits->>'tradeFractionBps' as trade_fraction_bps,
     risk_limits->>'maxSlippageBps' as max_slippage_bps,
     risk_limits->>'maxOpenPositions' as max_open,
     service_control->'lastSizing' as last_sizing,
     service_control->'positionsState' as positions
   from sessions where id = $1`, [sid]);
const s = r.rows[0];
console.log('STATUS:', s.status, '| fundingMint:', s.funding_mint);
console.log('wallet:', s.session_wallet);
console.log('starting_atomic:', s.starting_atomic, '| current_atomic:', s.current_atomic);
console.log('realizedPnlUsd:', s.realized_pnl);
console.log('maxPositionSizeUsd:', s.max_pos_usd, '| tradeFractionBps:', s.trade_fraction_bps, '| maxOpen:', s.max_open, '| maxSlippageBps:', s.max_slippage_bps);
console.log('positionsState:', JSON.stringify(s.positions));
console.log('lastSizing:', JSON.stringify(s.last_sizing, null, 2));

// On-chain balances
const rpc = process.env.HELIUS_RPC_URL;
const conn = new Connection(rpc, 'confirmed');
const owner = new PublicKey(s.session_wallet);
const lamports = await conn.getBalance(owner);
console.log('--- on-chain ---');
console.log('SOL lamports:', lamports, '=', (lamports / 1e9).toFixed(6), 'SOL  (~$' + (lamports/1e9*65).toFixed(2) + ')');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
try {
  const ta = await conn.getParsedTokenAccountsByOwner(owner, { mint: USDC });
  const amt = ta.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
  console.log('USDC balance:', amt);
} catch (e) { console.log('USDC lookup err:', e.message); }

await pool.end();
