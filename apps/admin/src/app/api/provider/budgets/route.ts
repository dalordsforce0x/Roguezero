import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

type ProviderBudgetRow = {
  budget_key: string;
  period_start: Date | string;
  period_end: Date | string;
  used_units: number | string;
  monthly_limit_units: number | string;
  pressure: 'normal' | 'watch' | 'throttle' | 'halt' | string;
  updated_at: Date | string;
};

type ProviderBudgetSnapshot = {
  key: string;
  pressure: string;
  usedUnits: number;
  monthlyLimitUnits: number;
  remainingUnits: number;
  usageRatio: number;
  elapsedRatio: number;
  projectedUsageRatio: number;
  periodStart: string | null;
  periodEnd: string | null;
  updatedAt: string | null;
};

const toIso = (value: Date | string) => (
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()
);

const toNumber = (value: number | string | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const buildFallbackBudget = (key: string, monthlyLimitUnits: number): ProviderBudgetSnapshot => ({
  key,
  pressure: 'unknown' as const,
  usedUnits: 0,
  monthlyLimitUnits,
  remainingUnits: monthlyLimitUnits,
  usageRatio: 0,
  elapsedRatio: 0,
  projectedUsageRatio: 0,
  periodStart: null,
  periodEnd: null,
  updatedAt: null,
});

export async function GET() {
  try {
    const pool = getPool();
    const result = await pool.query<ProviderBudgetRow>(
      `SELECT budget_key, period_start, period_end, used_units, monthly_limit_units, pressure, updated_at
         FROM provider_monthly_budgets
        WHERE period_start = date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        ORDER BY budget_key ASC`,
    ).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : null;
      if (code === '42P01') {
        return { rows: [] as ProviderBudgetRow[] };
      }
      throw error;
    });

    const budgets = new Map<string, ProviderBudgetSnapshot>([
      ['helius-credits', buildFallbackBudget('helius-credits', Number(process.env.HELIUS_MONTHLY_CREDIT_LIMIT ?? 100_000_000))],
      ['jupiter-requests', buildFallbackBudget('jupiter-requests', Number(process.env.JUPITER_MONTHLY_REQUEST_LIMIT ?? 500_000_000))],
    ]);

    const nowMs = Date.now();

    for (const row of result.rows) {
      const usedUnits = toNumber(row.used_units);
      const monthlyLimitUnits = toNumber(row.monthly_limit_units);
      const periodStartMs = new Date(row.period_start).getTime();
      const periodEndMs = new Date(row.period_end).getTime();
      const periodMs = Math.max(1, periodEndMs - periodStartMs);
      const elapsedRatio = Math.max(0, Math.min(1, (nowMs - periodStartMs) / periodMs));
      const usageRatio = monthlyLimitUnits > 0 ? usedUnits / monthlyLimitUnits : 1;
      const projectedUsageRatio = elapsedRatio > 0 ? usageRatio / Math.max(elapsedRatio, 0.01) : usageRatio;

      budgets.set(row.budget_key, {
        key: row.budget_key,
        pressure: row.pressure,
        usedUnits,
        monthlyLimitUnits,
        remainingUnits: Math.max(0, monthlyLimitUnits - usedUnits),
        usageRatio,
        elapsedRatio,
        projectedUsageRatio,
        periodStart: toIso(row.period_start),
        periodEnd: toIso(row.period_end),
        updatedAt: toIso(row.updated_at),
      });
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      budgets: Object.fromEntries(budgets.entries()),
    });
  } catch (error) {
    console.error('[GET /api/provider/budgets]', error);
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      budgets: {
        'helius-credits': buildFallbackBudget('helius-credits', Number(process.env.HELIUS_MONTHLY_CREDIT_LIMIT ?? 100_000_000)),
        'jupiter-requests': buildFallbackBudget('jupiter-requests', Number(process.env.JUPITER_MONTHLY_REQUEST_LIMIT ?? 500_000_000)),
      },
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
