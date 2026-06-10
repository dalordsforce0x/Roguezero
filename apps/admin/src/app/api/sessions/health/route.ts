import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

type SessionHealthRow = {
  id: string;
  user_id: string;
  username: string;
  status: string;
  requested_at: Date | string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  stop_reason: string | null;
  last_trade_attempted_at: string | null;
  last_trade_submitted_at: string | null;
  last_decision_at: string | null;
  last_decision_outcome: 'attempted' | 'blocked' | 'submitted' | 'stopped' | 'error' | null;
  last_decision_reason: string | null;
  last_blocked_at: string | null;
  last_blocked_reason: string | null;
  blocked_reason_counts: Record<string, number> | null;
  last_sizing_at: string | null;
  last_sizing_decision: 'traded' | 'skipped' | null;
  last_sizing_reason: string | null;
  last_sizing_balance_lamports: string | null;
  last_sizing_reserve_lamports: string | null;
  last_sizing_tradable_lamports: string | null;
  last_sizing_fraction_bps: number | null;
  last_sizing_target_lamports: string | null;
  last_sizing_min_trade_lamports: string | null;
  last_sizing_max_trade_lamports: string | null;
  last_sizing_amount_lamports: string | null;
  last_sizing_remaining_risk_budget_usd: number | null;
  last_sizing_quoted_out_amount_atomic: string | null;
  last_sizing_minimum_output_atomic: string | null;
  last_sizing_price_impact_pct: string | null;
  last_sizing_estimated_network_cost_lamports: string | null;
  last_sizing_estimated_network_cost_output_atomic: string | null;
  last_sizing_worst_case_slippage_output_atomic: string | null;
  last_sizing_total_worst_case_cost_output_atomic: string | null;
  last_sizing_risk_adjusted_amount_lamports: string | null;
  realized_pnl_usd: number | null;
  unrealized_pnl_usd: number | null;
  total_portfolio_value_usd: number | null;
  starting_value_usd: number | null;
  starting_balance_atomic: string | null;
  funding_mint: string | null;
  last_sizing_trade_context: {
    inputMint: string;
    inputSymbol: 'SOL' | 'USDC' | 'USDT';
    outputMint: string;
    outputSymbol: 'SOL' | 'USDC' | 'USDT';
    balanceAtomic: string;
    reserveAtomic: string;
    tradableAtomic: string;
    targetAtomic: string;
    minTradeAtomic: string;
    maxTradeAtomic: string;
    amountAtomic: string | null;
    riskAdjustedAmountAtomic: string | null;
  } | null;
  risk_state: {
    dayKey: string;
    dailyRealizedPnlUsd: number;
    consecutiveLosses: number;
    badFillStreak: number;
    lastLossAt: string | null;
    lastBadFillAt: string | null;
  } | null;
  last_execution_audit: {
    at: string;
    executionId: string;
    direction: 'enter_long' | 'exit_long' | 'other';
    inputMint: string;
    outputMint: string;
    inputAmountAtomic: string;
    expectedOutputAtomic: string | null;
    actualOutputAtomic: string | null;
    outputDeltaBps: number | null;
    priceImpactBps: number | null;
    badFill: boolean;
  } | null;
};

type SessionHealthIssue = {
  sessionId: string;
  username: string;
  status: string;
  ageMinutes: number;
  reason: string;
  stopReason: string | null;
  lastTradeSubmittedAt: string | null;
  lastBlockedReason: string | null;
};

type SessionSizingSnapshot = {
  sessionId: string;
  username: string;
  status: string;
  at: string;
  decision: 'traded' | 'skipped';
  reason: string | null;
  balanceLamports: string;
  reserveLamports: string;
  tradableLamports: string;
  fractionBps: number;
  targetLamports: string;
  minTradeLamports: string;
  maxTradeLamports: string;
  amountLamports: string | null;
  remainingRiskBudgetUsd: number | null;
  quotedOutAmountAtomic: string | null;
  minimumOutputAtomic: string | null;
  priceImpactPct: string | null;
  estimatedNetworkCostLamports: string | null;
  estimatedNetworkCostOutputAtomic: string | null;
  worstCaseSlippageOutputAtomic: string | null;
  totalWorstCaseCostOutputAtomic: string | null;
  riskAdjustedAmountLamports: string | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  totalPnlUsd: number | null;
  portfolioPnlUsd: number | null;
  tradeContext: SessionHealthRow['last_sizing_trade_context'];
};

type LiveNoTradeSession = {
  sessionId: string;
  username: string;
  status: string;
  blocker: string;
  lastDecisionOutcome: SessionHealthRow['last_decision_outcome'];
  lastDecisionReason: string | null;
  lastDecisionAgeMinutes: number | null;
  lastSubmitAgeMinutes: number | null;
};

type ExecutionQueueSummaryRow = {
  total: string | number;
  queued: string | number;
  running: string | number;
  claimable: string | number;
  stale_running: string | number;
  oldest_queued_age_seconds: string | number | null;
  newest_updated_at: Date | string | null;
};

type ExecutionQueueReasonRow = {
  reason: string;
  status: string;
  count: string | number;
};

type ExecutionQueueHealth = {
  total: number;
  queued: number;
  running: number;
  claimable: number;
  staleRunning: number;
  oldestQueuedAgeSeconds: number | null;
  newestUpdatedAt: string | null;
  topReasons: Array<{ reason: string; status: string; count: number }>;
};

type RiskProofAudit = {
  sessionId: string;
  username: string;
  status: string;
  at: string;
  direction: 'enter_long' | 'exit_long' | 'other';
  outputDeltaBps: number | null;
  priceImpactBps: number | null;
  badFill: boolean;
  expectedOutputAtomic: string | null;
  actualOutputAtomic: string | null;
};

type RiskProofHealth = {
  dailyLossSessions: number;
  consecutiveLossSessions: number;
  badFillStreakSessions: number;
  recentBadFills: number;
  maxDailyLossUsd: number;
  maxConsecutiveLosses: number;
  maxBadFillStreak: number;
  recentAudits: RiskProofAudit[];
};

type RecentTradeRow = {
  session_id: string;
  username: string;
  session_status: string;
  execution_id: string;
  execution_status: string;
  swap_path: string;
  input_mint: string;
  output_mint: string;
  amount: string;
  signature: string | null;
  confirmation_status: string | null;
  last_error: unknown;
  prepared_at: Date | string | null;
  submitted_at: Date | string | null;
  confirmed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  metadata: Record<string, unknown> | null;
};

const ACTIVE_STALE_MINUTES = 5;
const STOPPING_STALE_MINUTES = 3;
const AWAITING_FUNDING_WARN_MINUTES = 15;
const ISSUE_LIMIT = 8;
const SIZING_LIMIT = 10;
const LIVE_NO_TRADE_LIMIT = 25;
const RISK_AUDIT_LIMIT = 10;
const RECENT_TRADE_LIMIT = 25;

const emptyExecutionQueueHealth = (): ExecutionQueueHealth => ({
  total: 0,
  queued: 0,
  running: 0,
  claimable: 0,
  staleRunning: 0,
  oldestQueuedAgeSeconds: null,
  newestUpdatedAt: null,
  topReasons: [],
});

const parseTimestamp = (value: Date | string | null | undefined) => {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const minutesSince = (value: Date | string | null | undefined) => {
  const timestamp = parseTimestamp(value);
  if (timestamp === null) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
};

const getMostRecentTimestamp = (...values: Array<Date | string | null | undefined>) => {
  const timestamps = values
    .map((value) => parseTimestamp(value))
    .filter((value): value is number => value !== null);

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
};

const toCount = (value: string | number | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toIsoOrNull = (value: Date | string | null | undefined) => {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const sortIssues = (issues: SessionHealthIssue[]) =>
  [...issues].sort((a, b) => b.ageMinutes - a.ageMinutes).slice(0, ISSUE_LIMIT);

const classifyLiveNoTradeBlocker = (row: SessionHealthRow): string | null => {
  if (row.status !== 'active' && row.status !== 'starting') {
    return null;
  }

  if (row.last_decision_outcome === 'submitted') {
    return null;
  }

  if (row.last_decision_outcome === 'blocked') {
    return row.last_decision_reason ?? row.last_blocked_reason ?? 'blocked_unknown';
  }

  if (row.last_decision_outcome === 'error') {
    return row.last_decision_reason ?? 'worker_error';
  }

  if (row.last_decision_outcome === 'stopped') {
    return row.last_decision_reason ?? row.stop_reason ?? 'stopped';
  }

  if (row.last_decision_outcome === 'attempted') {
    return 'attempting_no_submit';
  }

  return row.last_trade_submitted_at ? 'no_recent_submit' : 'no_submit_yet';
};

export async function GET() {
  try {
    const pool = getPool();
    const executionQueuePromise = Promise.all([
      pool.query<ExecutionQueueSummaryRow>(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'queued') AS queued,
           COUNT(*) FILTER (WHERE status = 'running') AS running,
           COUNT(*) FILTER (WHERE status = 'queued' AND available_at <= NOW()) AS claimable,
           COUNT(*) FILTER (WHERE status = 'running' AND locked_until IS NOT NULL AND locked_until < NOW()) AS stale_running,
           MAX(EXTRACT(EPOCH FROM (NOW() - created_at))) FILTER (WHERE status = 'queued') AS oldest_queued_age_seconds,
           MAX(updated_at) AS newest_updated_at
         FROM execution_queue`,
      ),
      pool.query<ExecutionQueueReasonRow>(
        `SELECT reason, status, COUNT(*) AS count
           FROM execution_queue
          GROUP BY reason, status
          ORDER BY COUNT(*) DESC, reason ASC
          LIMIT 8`,
      ),
    ]).then(([summaryResult, reasonResult]) => {
      const summary = summaryResult.rows[0] ?? null;
      return {
        total: toCount(summary?.total),
        queued: toCount(summary?.queued),
        running: toCount(summary?.running),
        claimable: toCount(summary?.claimable),
        staleRunning: toCount(summary?.stale_running),
        oldestQueuedAgeSeconds: summary?.oldest_queued_age_seconds == null ? null : toCount(summary.oldest_queued_age_seconds),
        newestUpdatedAt: toIsoOrNull(summary?.newest_updated_at),
        topReasons: reasonResult.rows.map((row) => ({
          reason: row.reason,
          status: row.status,
          count: toCount(row.count),
        })),
      } satisfies ExecutionQueueHealth;
    }).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : null;
      if (code === '42P01') {
        return emptyExecutionQueueHealth();
      }
      throw error;
    });

    const recentTradesPromise = pool.query<RecentTradeRow>(
      `SELECT
         s.id AS session_id,
         COALESCE(u.username, s.user_id) AS username,
         s.status AS session_status,
         e.id AS execution_id,
         CASE
           WHEN e.status = 'failed' AND e.last_error->>'stage' = 'worker_cancel' THEN 'skipped'
           ELSE e.status
         END AS execution_status,
         e.swap_path,
         e.input_mint,
         e.output_mint,
         e.amount,
         e.signature,
         e.confirmation_status,
         e.last_error,
         e.prepared_at,
         e.submitted_at,
         e.confirmed_at,
         e.created_at,
         e.updated_at,
         e.metadata
       FROM swap_executions e
       JOIN sessions s ON s.session_wallet = e.taker
       LEFT JOIN rz_users u ON u.id::text = s.user_id
       ORDER BY e.created_at DESC
       LIMIT $1`,
      [RECENT_TRADE_LIMIT],
    ).then((tradeResult) => tradeResult.rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      return {
        sessionId: row.session_id,
        username: row.username,
        sessionStatus: row.session_status,
        executionId: row.execution_id,
        status: row.execution_status,
        swapPath: row.swap_path,
        inputMint: row.input_mint,
        outputMint: row.output_mint,
        amount: row.amount,
        signature: row.signature,
        confirmationStatus: row.confirmation_status,
        lastError: row.last_error,
        preparedAt: toIsoOrNull(row.prepared_at),
        submittedAt: toIsoOrNull(row.submitted_at),
        confirmedAt: toIsoOrNull(row.confirmed_at),
        createdAt: toIsoOrNull(row.created_at) ?? new Date().toISOString(),
        updatedAt: toIsoOrNull(row.updated_at) ?? new Date().toISOString(),
        entryStrategy: typeof metadata.entryStrategy === 'string' ? metadata.entryStrategy : null,
        exitStrategy: typeof metadata.exitStrategy === 'string' ? metadata.exitStrategy : null,
        exitReason: typeof metadata.exitReason === 'string' ? metadata.exitReason : null,
        scannerStrategy: typeof metadata.scannerStrategy === 'string' ? metadata.scannerStrategy : null,
      };
    })).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : null;
      if (code === '42P01' || code === '42703') {
        return [];
      }
      throw error;
    });

    const result = await pool.query<SessionHealthRow>(
      `SELECT
         s.id,
         s.user_id,
         COALESCE(u.username, s.user_id) AS username,
         s.status,
         s.requested_at,
         s.started_at,
         s.ended_at,
         s.stop_reason,
         s.service_control -> 'schedulingState' ->> 'lastTradeAttemptedAt' AS last_trade_attempted_at,
         s.service_control -> 'schedulingState' ->> 'lastTradeSubmittedAt' AS last_trade_submitted_at,
         s.service_control -> 'schedulingState' ->> 'lastDecisionAt' AS last_decision_at,
         s.service_control -> 'schedulingState' ->> 'lastDecisionOutcome' AS last_decision_outcome,
         s.service_control -> 'schedulingState' ->> 'lastDecisionReason' AS last_decision_reason,
         s.service_control -> 'schedulingState' ->> 'lastBlockedAt' AS last_blocked_at,
         s.service_control -> 'schedulingState' ->> 'lastBlockedReason' AS last_blocked_reason,
         s.service_control -> 'schedulingState' -> 'blockedReasonCounts' AS blocked_reason_counts,
         s.service_control -> 'lastSizing' ->> 'at' AS last_sizing_at,
         s.service_control -> 'lastSizing' ->> 'decision' AS last_sizing_decision,
         s.service_control -> 'lastSizing' ->> 'reason' AS last_sizing_reason,
         s.service_control -> 'lastSizing' ->> 'balanceLamports' AS last_sizing_balance_lamports,
         s.service_control -> 'lastSizing' ->> 'reserveLamports' AS last_sizing_reserve_lamports,
         s.service_control -> 'lastSizing' ->> 'tradableLamports' AS last_sizing_tradable_lamports,
         (s.service_control -> 'lastSizing' ->> 'fractionBps')::integer AS last_sizing_fraction_bps,
         s.service_control -> 'lastSizing' ->> 'targetLamports' AS last_sizing_target_lamports,
         s.service_control -> 'lastSizing' ->> 'minTradeLamports' AS last_sizing_min_trade_lamports,
         s.service_control -> 'lastSizing' ->> 'maxTradeLamports' AS last_sizing_max_trade_lamports,
         s.service_control -> 'lastSizing' ->> 'amountLamports' AS last_sizing_amount_lamports,
         (s.service_control -> 'lastSizing' ->> 'remainingRiskBudgetUsd')::double precision AS last_sizing_remaining_risk_budget_usd,
         s.service_control -> 'lastSizing' ->> 'quotedOutAmountAtomic' AS last_sizing_quoted_out_amount_atomic,
         s.service_control -> 'lastSizing' ->> 'minimumOutputAtomic' AS last_sizing_minimum_output_atomic,
         s.service_control -> 'lastSizing' ->> 'priceImpactPct' AS last_sizing_price_impact_pct,
         s.service_control -> 'lastSizing' ->> 'estimatedNetworkCostLamports' AS last_sizing_estimated_network_cost_lamports,
         s.service_control -> 'lastSizing' ->> 'estimatedNetworkCostOutputAtomic' AS last_sizing_estimated_network_cost_output_atomic,
         s.service_control -> 'lastSizing' ->> 'worstCaseSlippageOutputAtomic' AS last_sizing_worst_case_slippage_output_atomic,
         s.service_control -> 'lastSizing' ->> 'totalWorstCaseCostOutputAtomic' AS last_sizing_total_worst_case_cost_output_atomic,
         s.service_control -> 'lastSizing' ->> 'riskAdjustedAmountLamports' AS last_sizing_risk_adjusted_amount_lamports,
         (s.funding ->> 'realizedPnlUsd')::double precision AS realized_pnl_usd,
         (s.funding ->> 'unrealizedPnlUsd')::double precision AS unrealized_pnl_usd,
         (s.funding ->> 'totalPortfolioValueUsd')::double precision AS total_portfolio_value_usd,
         (s.funding ->> 'startingValueUsd')::double precision AS starting_value_usd,
         (s.funding ->> 'startingBalanceAtomic') AS starting_balance_atomic,
         s.funding ->> 'fundingMint' AS funding_mint,
         s.service_control -> 'lastSizing' -> 'tradeContext' AS last_sizing_trade_context,
         s.service_control -> 'riskState' AS risk_state,
         s.service_control -> 'lastExecutionAudit' AS last_execution_audit
       FROM sessions s
       LEFT JOIN rz_users u ON u.id::text = s.user_id
       ORDER BY s.requested_at DESC
       LIMIT 500`,
    );
    const [executionQueue, recentTrades] = await Promise.all([executionQueuePromise, recentTradesPromise]);

    const countsByStatus: Record<string, number> = {
      awaiting_funding: 0,
      ready: 0,
      starting: 0,
      active: 0,
      paused: 0,
      stopping: 0,
      stopped: 0,
      settling: 0,
      error: 0,
    };

    const staleActive: SessionHealthIssue[] = [];
    const staleStopping: SessionHealthIssue[] = [];
    const awaitingFunding: SessionHealthIssue[] = [];
    const errors: SessionHealthIssue[] = [];
    const recentSizing: SessionSizingSnapshot[] = [];
    const liveNoTradeSessions: LiveNoTradeSession[] = [];
    const recentAudits: RiskProofAudit[] = [];
    const liveUserIds = new Set<string>();
    const decisionOutcomes: Record<string, number> = {
      attempted: 0,
      blocked: 0,
      submitted: 0,
      stopped: 0,
      error: 0,
      unknown: 0,
    };
    const blockedReasonTotals = new Map<string, number>();
    const liveNoTradeBlockerCounts = new Map<string, number>();
    let dailyLossSessions = 0;
    let consecutiveLossSessions = 0;
    let badFillStreakSessions = 0;
    let recentBadFills = 0;
    let maxDailyLossUsd = 0;
    let maxConsecutiveLosses = 0;
    let maxBadFillStreak = 0;

    for (const row of result.rows) {
      countsByStatus[row.status] = (countsByStatus[row.status] ?? 0) + 1;

      if (row.status === 'active' || row.status === 'starting') {
        liveUserIds.add(row.user_id);
      }

      if (row.status === 'active') {
        const ageMinutes = minutesSince(getMostRecentTimestamp(
          row.last_trade_submitted_at,
          row.last_trade_attempted_at,
          row.last_sizing_at,
          row.started_at,
          row.requested_at,
        ));

        if (ageMinutes !== null && ageMinutes >= ACTIVE_STALE_MINUTES) {
          staleActive.push({
            sessionId: row.id,
            username: row.username,
            status: row.status,
            ageMinutes,
            reason: 'No worker activity recorded recently',
            stopReason: row.stop_reason,
            lastTradeSubmittedAt: row.last_trade_submitted_at,
            lastBlockedReason: row.last_blocked_reason,
          });
        }
      }

      if (row.status === 'active' || row.status === 'starting') {
        const outcome = row.last_decision_outcome ?? 'unknown';
        decisionOutcomes[outcome] = (decisionOutcomes[outcome] ?? 0) + 1;

        if (row.blocked_reason_counts && typeof row.blocked_reason_counts === 'object') {
          for (const [reason, count] of Object.entries(row.blocked_reason_counts)) {
            if (!reason) continue;
            const numericCount = Number(count);
            if (!Number.isFinite(numericCount) || numericCount <= 0) continue;
            blockedReasonTotals.set(reason, (blockedReasonTotals.get(reason) ?? 0) + numericCount);
          }
        }

        const blocker = classifyLiveNoTradeBlocker(row);
        if (blocker) {
          liveNoTradeSessions.push({
            sessionId: row.id,
            username: row.username,
            status: row.status,
            blocker,
            lastDecisionOutcome: row.last_decision_outcome,
            lastDecisionReason: row.last_decision_reason,
            lastDecisionAgeMinutes: minutesSince(row.last_decision_at),
            lastSubmitAgeMinutes: minutesSince(row.last_trade_submitted_at),
          });
          liveNoTradeBlockerCounts.set(blocker, (liveNoTradeBlockerCounts.get(blocker) ?? 0) + 1);
        }
      }

      if (row.status === 'stopping') {
        const ageMinutes = minutesSince(
          row.ended_at
          ?? row.last_trade_submitted_at
          ?? row.started_at
          ?? row.requested_at,
        );

        if (ageMinutes !== null && ageMinutes >= STOPPING_STALE_MINUTES) {
          staleStopping.push({
            sessionId: row.id,
            username: row.username,
            status: row.status,
            ageMinutes,
            reason: 'Stop/return flow has been pending too long',
            stopReason: row.stop_reason,
            lastTradeSubmittedAt: row.last_trade_submitted_at,
            lastBlockedReason: row.last_blocked_reason,
          });
        }
      }

      if (row.status === 'awaiting_funding') {
        const ageMinutes = minutesSince(row.requested_at);
        if (ageMinutes !== null && ageMinutes >= AWAITING_FUNDING_WARN_MINUTES) {
          awaitingFunding.push({
            sessionId: row.id,
            username: row.username,
            status: row.status,
            ageMinutes,
            reason: 'Session has been waiting on user funding for a while',
            stopReason: row.stop_reason,
            lastTradeSubmittedAt: row.last_trade_submitted_at,
            lastBlockedReason: row.last_blocked_reason,
          });
        }
      }

      if (row.status === 'error') {
        const ageMinutes = minutesSince(row.ended_at ?? row.started_at ?? row.requested_at) ?? 0;
        errors.push({
          sessionId: row.id,
          username: row.username,
          status: row.status,
          ageMinutes,
          reason: 'Session is in error state',
          stopReason: row.stop_reason,
          lastTradeSubmittedAt: row.last_trade_submitted_at,
          lastBlockedReason: row.last_blocked_reason,
        });
      }

      if (
        row.last_sizing_at
        && row.last_sizing_decision
        && row.last_sizing_balance_lamports
        && row.last_sizing_reserve_lamports
        && row.last_sizing_tradable_lamports
        && row.last_sizing_fraction_bps !== null
        && row.last_sizing_target_lamports
        && row.last_sizing_min_trade_lamports
        && row.last_sizing_max_trade_lamports
      ) {
        recentSizing.push({
          sessionId: row.id,
          username: row.username,
          status: row.status,
          at: row.last_sizing_at,
          decision: row.last_sizing_decision,
          reason: row.last_sizing_reason,
          balanceLamports: row.last_sizing_balance_lamports,
          reserveLamports: row.last_sizing_reserve_lamports,
          tradableLamports: row.last_sizing_tradable_lamports,
          fractionBps: row.last_sizing_fraction_bps,
          targetLamports: row.last_sizing_target_lamports,
          minTradeLamports: row.last_sizing_min_trade_lamports,
          maxTradeLamports: row.last_sizing_max_trade_lamports,
          amountLamports: row.last_sizing_amount_lamports,
          remainingRiskBudgetUsd: row.last_sizing_remaining_risk_budget_usd,
          quotedOutAmountAtomic: row.last_sizing_quoted_out_amount_atomic,
          minimumOutputAtomic: row.last_sizing_minimum_output_atomic,
          priceImpactPct: row.last_sizing_price_impact_pct,
          estimatedNetworkCostLamports: row.last_sizing_estimated_network_cost_lamports,
          estimatedNetworkCostOutputAtomic: row.last_sizing_estimated_network_cost_output_atomic,
          worstCaseSlippageOutputAtomic: row.last_sizing_worst_case_slippage_output_atomic,
          totalWorstCaseCostOutputAtomic: row.last_sizing_total_worst_case_cost_output_atomic,
          riskAdjustedAmountLamports: row.last_sizing_risk_adjusted_amount_lamports,
          realizedPnlUsd: row.realized_pnl_usd,
          unrealizedPnlUsd: row.unrealized_pnl_usd,
          totalPnlUsd: (row.realized_pnl_usd ?? 0) + (row.unrealized_pnl_usd ?? 0),
          portfolioPnlUsd: row.total_portfolio_value_usd != null && row.starting_value_usd != null
            ? Number((row.total_portfolio_value_usd - row.starting_value_usd).toFixed(2))
            : null,
          tradeContext: row.last_sizing_trade_context,
        });
      }

      if (row.risk_state) {
        const dailyLossUsd = Math.abs(Math.min(0, Number(row.risk_state.dailyRealizedPnlUsd ?? 0)));
        const consecutiveLosses = Number(row.risk_state.consecutiveLosses ?? 0);
        const badFillStreak = Number(row.risk_state.badFillStreak ?? 0);

        if (dailyLossUsd > 0) dailyLossSessions += 1;
        if (consecutiveLosses > 0) consecutiveLossSessions += 1;
        if (badFillStreak > 0) badFillStreakSessions += 1;

        maxDailyLossUsd = Math.max(maxDailyLossUsd, dailyLossUsd);
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
        maxBadFillStreak = Math.max(maxBadFillStreak, badFillStreak);
      }

      if (row.last_execution_audit) {
        if (row.last_execution_audit.badFill) recentBadFills += 1;
        recentAudits.push({
          sessionId: row.id,
          username: row.username,
          status: row.status,
          at: row.last_execution_audit.at,
          direction: row.last_execution_audit.direction,
          outputDeltaBps: row.last_execution_audit.outputDeltaBps,
          priceImpactBps: row.last_execution_audit.priceImpactBps,
          badFill: row.last_execution_audit.badFill,
          expectedOutputAtomic: row.last_execution_audit.expectedOutputAtomic,
          actualOutputAtomic: row.last_execution_audit.actualOutputAtomic,
        });
      }
    }

    const staleActiveIssues = sortIssues(staleActive);
    const staleStoppingIssues = sortIssues(staleStopping);
    const awaitingFundingIssues = sortIssues(awaitingFunding);
    const errorIssues = sortIssues(errors);
    const recentSizingSnapshots = [...recentSizing]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, SIZING_LIMIT);
    const topBlockedReasons = [...blockedReasonTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));
    const topLiveNoTradeBlockers = [...liveNoTradeBlockerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));
    const liveNoTradeSnapshot = [...liveNoTradeSessions]
      .sort((a, b) => {
        const aAge = a.lastDecisionAgeMinutes ?? Number.MAX_SAFE_INTEGER;
        const bAge = b.lastDecisionAgeMinutes ?? Number.MAX_SAFE_INTEGER;
        return bAge - aAge;
      })
      .slice(0, LIVE_NO_TRADE_LIMIT);
    const riskProof: RiskProofHealth = {
      dailyLossSessions,
      consecutiveLossSessions,
      badFillStreakSessions,
      recentBadFills,
      maxDailyLossUsd,
      maxConsecutiveLosses,
      maxBadFillStreak,
      recentAudits: [...recentAudits]
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, RISK_AUDIT_LIMIT),
    };

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      thresholds: {
        activeStaleMinutes: ACTIVE_STALE_MINUTES,
        stoppingStaleMinutes: STOPPING_STALE_MINUTES,
        awaitingFundingWarnMinutes: AWAITING_FUNDING_WARN_MINUTES,
      },
      summary: {
        totalSessions: result.rows.length,
        liveUsers: liveUserIds.size,
        activeSessions: countsByStatus.active,
        readyOrStartingSessions: (countsByStatus.ready ?? 0) + (countsByStatus.starting ?? 0),
        stoppingSessions: countsByStatus.stopping,
        attentionCount: staleActive.length + staleStopping.length + errors.length,
      },
      executionQueue,
      tradeDecisions: {
        outcomes: decisionOutcomes,
        topBlockedReasons,
      },
      liveNoTrade: {
        sessions: liveNoTradeSnapshot,
        topBlockers: topLiveNoTradeBlockers,
      },
      riskProof,
      recentTrades,
      countsByStatus,
      issues: {
        staleActive: staleActiveIssues,
        stopping: staleStoppingIssues,
        errors: errorIssues,
        awaitingFunding: awaitingFundingIssues,
      },
      recentSizing: recentSizingSnapshots,
    });
  } catch {
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      thresholds: {
        activeStaleMinutes: ACTIVE_STALE_MINUTES,
        stoppingStaleMinutes: STOPPING_STALE_MINUTES,
        awaitingFundingWarnMinutes: AWAITING_FUNDING_WARN_MINUTES,
      },
      summary: {
        totalSessions: 0,
        liveUsers: 0,
        activeSessions: 0,
        readyOrStartingSessions: 0,
        stoppingSessions: 0,
        attentionCount: 0,
      },
      executionQueue: emptyExecutionQueueHealth(),
      tradeDecisions: {
        outcomes: {
          attempted: 0,
          blocked: 0,
          submitted: 0,
          stopped: 0,
          error: 0,
          unknown: 0,
        },
        topBlockedReasons: [],
      },
      liveNoTrade: {
        sessions: [],
        topBlockers: [],
      },
      riskProof: {
        dailyLossSessions: 0,
        consecutiveLossSessions: 0,
        badFillStreakSessions: 0,
        recentBadFills: 0,
        maxDailyLossUsd: 0,
        maxConsecutiveLosses: 0,
        maxBadFillStreak: 0,
        recentAudits: [],
      },
      recentTrades: [],
      countsByStatus: {
        awaiting_funding: 0,
        ready: 0,
        starting: 0,
        active: 0,
        paused: 0,
        stopping: 0,
        stopped: 0,
        settling: 0,
        error: 0,
      },
      issues: {
        staleActive: [],
        stopping: [],
        errors: [],
        awaitingFunding: [],
      },
      recentSizing: [],
    });
  }
}