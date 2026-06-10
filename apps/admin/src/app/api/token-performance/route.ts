import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * E3: Per-token performance tracking.
 * Aggregates exit_shadow_decisions by mint to show per-token realized PnL.
 * Returns top tokens by trade count with win/loss/PnL stats.
 */
export async function GET() {
  try {
    const { rows } = await getPool().query<{
      mint: string;
      symbol: string;
      token_class: string;
      total_exits: number;
      wins: number;
      losses: number;
      avg_pnl_bps: number;
      total_pnl_bps: number;
      max_favorable_bps_avg: number;
      max_adverse_bps_avg: number;
      avg_hold_minutes: number;
      last_exit_at: string;
    }>(`
      SELECT
        mint,
        COALESCE(symbol, mint) AS symbol,
        COALESCE(token_class, 'unknown') AS token_class,
        COUNT(*)::int AS total_exits,
        COUNT(*) FILTER (WHERE pnl_bps > 0)::int AS wins,
        COUNT(*) FILTER (WHERE pnl_bps <= 0)::int AS losses,
        ROUND(AVG(pnl_bps))::int AS avg_pnl_bps,
        SUM(pnl_bps)::int AS total_pnl_bps,
        ROUND(AVG(max_favorable_bps))::int AS max_favorable_bps_avg,
        ROUND(AVG(COALESCE(max_adverse_bps, 0)))::int AS max_adverse_bps_avg,
        ROUND(AVG(EXTRACT(EPOCH FROM (decided_at - entry_at)) / 60.0))::int AS avg_hold_minutes,
        MAX(decided_at)::text AS last_exit_at
      FROM exit_shadow_decisions
      WHERE current_should_exit = true
        AND decided_at > NOW() - INTERVAL '30 days'
      GROUP BY mint, symbol, token_class
      HAVING COUNT(*) >= 2
      ORDER BY total_pnl_bps ASC
    `);

    return NextResponse.json({
      success: true,
      tokens: rows,
      queriedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[GET /api/token-performance]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
