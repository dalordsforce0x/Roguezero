'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const DEFAULT_ROTATION_INTERVAL_MINUTES = 15;
const DEFAULT_ENABLED_STRATEGIES: StrategyKey[] = ['momentum', 'mean_reversion', 'supertrend'];

// ─── Types ───────────────────────────────────────────────────────────────────

interface User {
  id: string;
  username: string;
  wallet_address: string;
  group_id: string | null;
  group_name: string | null;
  group_bot_limit: number | null;
  license_key: string | null;
  expiry_date: string | null;
  access_enabled: boolean;
  max_wallet_usd: number;
  duration: string | null;
  gated_access_enrolled_at: string | null;
  license_key_revealed_at: string | null;
  created_at: string;
}

interface UserGroup {
  id: string;
  name: string;
  bot_limit: number;
  member_count: number;
  active_member_count: number;
  manager_id: string | null;
  manager_name: string | null;
  created_at: string;
  updated_at: string;
}

interface Manager {
  id: string;
  name: string;
  management_key: string | null;
  duration: string | null;
  expiry_date: string | null;
  access_enabled: boolean;
  key_revealed_at: string | null;
  group_count: number;
  created_at: string;
  updated_at: string;
}

interface SessionHealthIssue {
  sessionId: string;
  username: string;
  status: string;
  ageMinutes: number;
  reason: string;
  stopReason: string | null;
  lastTradeSubmittedAt: string | null;
}

interface SessionSizingSnapshot {
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
  tradeContext: {
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
}

interface SessionHealthData {
  generatedAt: string;
  thresholds: {
    activeStaleMinutes: number;
    stoppingStaleMinutes: number;
    awaitingFundingWarnMinutes: number;
  };
  summary: {
    totalSessions: number;
    liveUsers: number;
    activeSessions: number;
    readyOrStartingSessions: number;
    stoppingSessions: number;
    attentionCount: number;
  };
  executionQueue: {
    total: number;
    queued: number;
    running: number;
    claimable: number;
    staleRunning: number;
    oldestQueuedAgeSeconds: number | null;
    newestUpdatedAt: string | null;
    topReasons: Array<{ reason: string; status: string; count: number }>;
  };
  tradeDecisions: {
    outcomes: Record<string, number>;
    topBlockedReasons: Array<{ reason: string; count: number }>;
  };
  liveNoTrade: {
    sessions: Array<{
      sessionId: string;
      username: string;
      status: string;
      blocker: string;
      lastDecisionOutcome: 'attempted' | 'blocked' | 'submitted' | 'stopped' | 'error' | null;
      lastDecisionReason: string | null;
      lastDecisionAgeMinutes: number | null;
      lastSubmitAgeMinutes: number | null;
    }>;
    topBlockers: Array<{ reason: string; count: number }>;
  };
  countsByStatus: Record<string, number>;
  issues: {
    staleActive: SessionHealthIssue[];
    stopping: SessionHealthIssue[];
    errors: SessionHealthIssue[];
    awaitingFunding: SessionHealthIssue[];
  };
  riskProof: {
    dailyLossSessions: number;
    consecutiveLossSessions: number;
    badFillStreakSessions: number;
    recentBadFills: number;
    maxDailyLossUsd: number;
    maxConsecutiveLosses: number;
    maxBadFillStreak: number;
    recentAudits: Array<{
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
    }>;
  };
  recentTrades: Array<{
    sessionId: string;
    username: string;
    sessionStatus: string;
    executionId: string;
    status: string;
    swapPath: string;
    inputMint: string;
    outputMint: string;
    amount: string;
    signature: string | null;
    confirmationStatus: string | null;
    lastError: unknown;
    preparedAt: string | null;
    submittedAt: string | null;
    confirmedAt: string | null;
    createdAt: string;
    updatedAt: string;
    entryStrategy: string | null;
    exitStrategy: string | null;
    exitReason: string | null;
    scannerStrategy: string | null;
  }>;
  recentSizing: SessionSizingSnapshot[];
}

interface AdminSession {
  id: string;
  user_id: string;
  username: string;
  owner_wallet: string;
  session_wallet: string;
  requested_at: string;
  status: string;
  started_at: string | null;
  stop_reason: string | null;
  funding: Record<string, unknown>;
  service_control: Record<string, unknown>;
}

type StrategyKey = 'momentum' | 'mean_reversion' | 'supertrend';

type SessionStrategyForm = {
  enabledStrategies: StrategyKey[];
  activeStrategy: StrategyKey;
  queuedStrategy: StrategyKey;
  rotationIntervalMinutes: number;
  autoRotationEnabled: boolean;
  momentumLookbackSamples: number;
  momentumThresholdBps: number;
  momentumEdgeSafetyBufferBps: number;
};

interface HeliusRateLimitData {
  connected?: boolean;
  latencyMs?: number;
  blockHeight?: number;
  error?: string;
  plan?: {
    name?: string;
    providerCap?: {
      rpcRps?: number;
      dasRps?: number;
      sendTransactionTps?: number;
    };
    fleetTarget?: {
      rpcRps?: number;
      rpcBurst?: number;
      dasRps?: number;
      senderTps?: number;
    };
    monthlyCredits?: number;
    monthlyBudgetEnforced?: boolean;
  };
}

interface JupiterRateLimitData {
  connected?: boolean;
  latencyMs?: number;
  outUsdc?: string;
  priceImpactPct?: string;
  router?: string;
  error?: string;
  plan?: {
    name?: string;
    providerCap?: {
      generalRps?: number;
      executeRps?: number;
      txSubmitRps?: number;
    };
    fleetTarget?: {
      generalRps?: number;
      generalBurst?: number;
    };
    includedCreditsPerYear?: number;
    monthlyRequestsBudget?: number;
    monthlyBudgetEnforced?: boolean;
  };
}

interface TigerDataRateLimitData {
  connected?: boolean;
  latencyMs?: number;
  activeConnections?: number;
  maxConnections?: number;
  dbSize?: string;
  error?: string;
  pool?: {
    idle?: number;
    total?: number;
  };
  tables?: { name: string; rows: number }[];
}

interface ProviderBudgetSnapshot {
  key: string;
  pressure: 'normal' | 'watch' | 'throttle' | 'halt' | 'unknown' | string;
  usedUnits: number;
  monthlyLimitUnits: number;
  remainingUnits: number;
  usageRatio: number;
  elapsedRatio: number;
  projectedUsageRatio: number;
  periodStart: string | null;
  periodEnd: string | null;
  updatedAt: string | null;
}

interface ProviderBudgetData {
  generatedAt: string;
  budgets: Record<string, ProviderBudgetSnapshot>;
  error?: string;
}

interface RateLimitData {
  helius: HeliusRateLimitData;
  jupiter: JupiterRateLimitData;
  tigerdata: TigerDataRateLimitData;
  providerBudgets: ProviderBudgetData;
}

interface RuntimeControlData {
  speedProfile: 'glide' | 'pulse' | 'surge';
  label: string;
  concurrentCapacity: number;
  maxOpenPositions: number | null;
  modeSource: 'auto' | 'manual';
  recommendedProfile: 'glide' | 'pulse' | 'surge';
  recommendedLabel: string;
  transitionReason: string | null;
  lastTransitionAt: string | null;
  entriesEnabled: boolean;
  maintenanceReason: string | null;
  pressure: {
    heliusBudget?: string;
    heliusUsageRatio?: number;
    jupiterBudget?: string;
    jupiterUsageRatio?: number;
    queueDepth?: number;
    queueOldestMs?: number;
    worstLane?: string;
  } | null;
  cadenceMs: {
    readyStarting: number;
    activeInPosition: number;
    activeFlat: number;
    activeGuarded: number;
    stopping: number;
    postSubmitFast: number;
  };
  liveSessions: number;
  reservedSessions: number;
  updatedAt: string;
}

const DURATIONS = [
  { value: '1month',  label: '1 Month' },
  { value: '6months', label: '6 Months' },
  { value: '1year',   label: '1 Year' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortWallet(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
function lamportsToSolString(lamports: string | null) {
  if (!lamports) return '—';
  const numeric = Number(lamports);
  if (!Number.isFinite(numeric)) return '—';
  return `${(numeric / 1_000_000_000).toFixed(4)} SOL`;
}
function atomicUsdcToString(amount: string | null) {
  if (!amount) return '—';
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return '—';
  return `$${(numeric / 1_000_000).toFixed(4)}`;
}
function formatSignedUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}$${value.toFixed(4)}`;
}
function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}
function formatCompactNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
function formatAtomicAmount(amount: string | null, symbol: 'SOL' | 'USDC' | 'USDT') {
  if (!amount) return '—';
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return '—';
  if (symbol === 'SOL') {
    return `${(numeric / 1_000_000_000).toFixed(4)} SOL`;
  }
  return symbol === 'USDC' || symbol === 'USDT'
    ? `$${(numeric / 1_000_000).toFixed(4)} ${symbol}`
    : amount;
}
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

function symbolForMint(mint: string) {
  if (mint === SOL_MINT) return 'SOL' as const;
  if (mint === USDC_MINT) return 'USDC' as const;
  if (mint === USDT_MINT) return 'USDT' as const;
  return 'TOKEN';
}

function formatMintAmount(amount: string | null, mint: string) {
  const symbol = symbolForMint(mint);
  if (symbol === 'SOL' || symbol === 'USDC' || symbol === 'USDT') return formatAtomicAmount(amount, symbol);
  if (!amount) return '—';
  return `${amount} raw`;
}

function formatReasonLabel(value: string | null | undefined) {
  return value ? value.replace(/_/g, ' ') : '—';
}

function formatErrorSummary(value: unknown) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = value as { reason?: unknown; stage?: unknown };
    const reason = typeof record.reason === 'string' ? record.reason : null;
    const stage = typeof record.stage === 'string' ? record.stage : null;
    if (stage || reason) return [stage, reason].filter(Boolean).join(': ');
  }
  try {
    return JSON.stringify(value).slice(0, 180);
  } catch {
    return 'unreadable error';
  }
}
function isExpired(iso: string | null) {
  return !!iso && new Date(iso) < new Date();
}

type TokenUniverseOverview = {
  generatedAt: string;
  summary: {
    configuredTokens: number;
    enabledTokens: number;
    activelyHeldTokens: number;
    tradedTokens7d: number;
  };
  bestToken: {
    mint: string;
    symbol: string;
    tradeCount7d: number;
    confirmedTradeCount7d: number;
    currentlyActive: boolean;
  } | null;
  activeTokens: Array<{
    mint: string;
    symbol: string;
    activeSessionCount: number;
  }>;
  autoSort: {
    status: 'applied' | 'skipped' | 'unknown';
    reason: string | null;
    sourceTable: string | null;
    candidateCount: number;
    enabledCount: number;
    lastRunAt: string | null;
    top: Array<{
      rank: number;
      mint: string;
      symbol: string;
      score: number;
      momentumBps: number;
      priceImpactBps: number | null;
      routeFound: boolean;
    }>;
  };
  scanner: {
    latestRun: {
      id: string;
      status: string;
      reason: string | null;
      candidateCount: number;
      acceptedCount: number;
      rejectedCount: number;
      providerCostEstimate: number;
      finishedAt: string;
    } | null;
    activeCandidates: Array<{
      mint: string;
      symbol: string;
      status: string;
      signalScore: number | null;
      routeQuality: number | null;
      slippageBps: number | null;
      validUntil: string;
      riskFlags: string[];
    }>;
  };
  admission: {
    summary: {
      total: number;
      admitted: number;
      rejected: number;
      latestObservedAt: string | null;
    };
    candidates: Array<{
      mint: string;
      symbol: string;
      bucket: string;
      status: string;
      priority: number;
      successfulQuoteCount: number;
      maxImpactBps: number;
      riskFlags: string[];
      observedAt: string;
    }>;
  };
  health: {
    trackedMints: number;
    activeDeadCandidates: number;
    topDead: Array<{
      mint: string;
      symbol: string;
      deadRuns: number;
      lastReason: string | null;
      lastSeenAt: string;
    }>;
  };
  deadletter: {
    openCount: number;
    recoveredCount: number;
    recent: Array<{
      mint: string;
      symbol: string;
      reason: string;
      deadRuns: number;
      dumpedAt: string;
      recoveredAt: string | null;
      score: number | null;
      momentumBps: number | null;
      priceImpactBps: number | null;
    }>;
  };
  tokens: Array<{
    mint: string;
    symbol: string;
    enabled: boolean;
    priority: number;
    notes: string | null;
    tradeCount7d: number;
    confirmedTradeCount7d: number;
    lastTradedAt: string | null;
    currentlyActive: boolean;
  }>;
};

type Tab = 'users' | 'user-groups' | 'managers' | 'overview' | 'rate-limits' | 'session-health' | 'token-universe';

type GateProps = {
  storageKey: string;
  onUnlock: () => void;
};

const GATE_PASSWORD = 'RogueZero2020!';
const GATE_VIDEO_SRC = '/media/rz-gated-access-intro.mp4';
const ADMIN_GATE_STORAGE_KEY = 'rz-admin-gate-unlocked';

// ─── Rate-limit metric row ──────────────────────────────────────────────────

function RlRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-gray-600">{label}</span>
      <span className={['text-[10px] font-mono font-medium', warn ? 'text-yellow-400' : 'text-gray-300'].join(' ')}>{value}</span>
    </div>
  );
}

function BudgetPressureCard({ title, budget }: { title: string; budget: ProviderBudgetSnapshot | undefined }) {
  const pressure = budget?.pressure ?? 'unknown';
  const color =
    pressure === 'halt' ? 'text-red-300 border-red-900/50 bg-red-950/30' :
    pressure === 'throttle' ? 'text-orange-300 border-orange-900/50 bg-orange-950/25' :
    pressure === 'watch' ? 'text-yellow-300 border-yellow-900/50 bg-yellow-950/20' :
    pressure === 'normal' ? 'text-emerald-300 border-emerald-900/40 bg-emerald-950/15' :
    'text-gray-400 border-gray-800 bg-gray-950/60';

  return (
    <div className={["rounded-xl border p-4", color].join(' ')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">{title}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">{budget?.key ?? 'budget not initialized'}</p>
        </div>
        <span className="rounded-full border border-current/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em]">
          {pressure}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <SizingMetric label="used" value={`${formatCompactNumber(budget?.usedUnits)} / ${formatCompactNumber(budget?.monthlyLimitUnits)}`} />
        <SizingMetric label="remaining" value={formatCompactNumber(budget?.remainingUnits)} />
        <SizingMetric label="usage" value={formatPercent(budget?.usageRatio)} />
        <SizingMetric label="projected" value={formatPercent(budget?.projectedUsageRatio)} />
      </div>
      <div className="mt-3 h-1 rounded-full bg-gray-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-current transition-all duration-700"
          style={{ width: `${Math.min(Math.max((budget?.usageRatio ?? 0) * 100, 0), 100)}%` }}
        />
      </div>
      <p className="mt-2 text-[10px] text-gray-600">
        updated {budget?.updatedAt ? formatDateTime(budget.updatedAt) : '—'}
      </p>
    </div>
  );
}

// ─── Speed gauge (flight RPM style) ───────────────────────────────────────────

function SpeedGauge({
  value, max, centerLabel, limitLabel, ok,
}: {
  value: number | null;
  max: number;
  centerLabel: string;
  limitLabel: string;
  ok: boolean | null;
}) {
  const r = 44, cx = 56, cy = 60, sweepDeg = 240, startDeg = 150;
  const circ = 2 * Math.PI * r;
  const arcLen = (sweepDeg / 360) * circ;
  const pct = value == null ? 0 : Math.min(value / max, 1);
  const fillLen = pct * arcLen;
  const fillColor =
    ok === null  ? '#374151' :
    pct < 0.45   ? '#10b981' :
    pct < 0.75   ? '#f59e0b' :
                   '#ef4444';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const a = ((startDeg + t * sweepDeg) * Math.PI) / 180;
    return { x1: cx + (r - 9) * Math.cos(a), y1: cy + (r - 9) * Math.sin(a),
             x2: cx + (r + 1) * Math.cos(a), y2: cy + (r + 1) * Math.sin(a) };
  });
  return (
    <svg viewBox="0 0 112 84" style={{ width: '100%' }}>
      {/* Track */}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#111827" strokeWidth={12}
        strokeDasharray={`${arcLen} ${circ}`} strokeLinecap="round"
        transform={`rotate(${startDeg} ${cx} ${cy})`} />
      {/* Fill */}
      {value != null && (
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={fillColor} strokeWidth={12}
          strokeDasharray={`${fillLen} ${circ}`} strokeLinecap="round"
          transform={`rotate(${startDeg} ${cx} ${cy})`}
          style={{ filter: `drop-shadow(0 0 7px ${fillColor}66)` }} />
      )}
      {/* Tick marks */}
      {ticks.map((t, i) => (
        <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
          stroke="#374151" strokeWidth="1.5" strokeLinecap="round" />
      ))}
      {/* Value */}
      <text x={cx} y={cy - 3} textAnchor="middle" fill="white"
        fontSize="15" fontWeight="700" fontFamily="'Courier New',monospace">
        {value == null ? '—' : centerLabel}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fill="#6b7280"
        fontSize="7" fontFamily="system-ui,sans-serif">
        {limitLabel}
      </text>
    </svg>
  );
}

// ─── Capacity Panel ───────────────────────────────────────────────────────────

function CapacityPanel({
  active,
  capacity,
  reserved,
  traders,
}: {
  active: number;
  capacity: number;
  reserved: number;
  traders: { id: string; username: string }[];
}) {
  const pct = capacity > 0 ? active / capacity : 0;
  const fillColor =
    pct === 0  ? '#10b981' :
    pct < 0.5  ? '#10b981' :
    pct < 0.8  ? '#f59e0b' :
                 '#ef4444';
  const glowColor =
    pct === 0  ? 'rgba(16,185,129,0.15)' :
    pct < 0.5  ? 'rgba(16,185,129,0.15)' :
    pct < 0.8  ? 'rgba(245,158,11,0.15)' :
                 'rgba(239,68,68,0.2)';

  return (
    <div
      className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4"
      style={{ boxShadow: `0 0 0 1px rgba(255,255,255,0.03), inset 0 1px 0 rgba(255,255,255,0.04)` }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Bot Capacity</span>
        <span
          className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{
            color: fillColor,
            background: glowColor,
            border: `1px solid ${fillColor}33`,
          }}
        >
          {active === 0 ? 'IDLE' : pct >= 0.8 ? 'NEAR FULL' : 'ACTIVE'}
        </span>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 text-[11px]">
        <SizingMetric label="active sessions" value={String(active)} />
        <SizingMetric label="bot capacity" value={String(capacity)} />
        <SizingMetric label="reserved slots" value={String(reserved)} />
        <SizingMetric label="available slots" value={String(Math.max(capacity - reserved, 0))} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: Math.max(capacity, 1) }).map((_, i) => (
          <span
            key={i}
            className="block w-2.5 h-2.5 rounded-full transition-all duration-500"
            style={
              i < active
                ? { background: fillColor, boxShadow: `0 0 6px ${fillColor}99` }
                : { background: '#1f2937', border: '1px solid #374151' }
            }
          />
        ))}
      </div>

      <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${Math.max(pct * 100, capacity === 0 ? 0 : 2)}%`,
            background: `linear-gradient(90deg, ${fillColor}99, ${fillColor})`,
            boxShadow: active > 0 ? `0 0 8px ${fillColor}66` : 'none',
          }}
        />
      </div>

      <div className="space-y-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Currently Trading</span>
        {traders.length === 0 ? (
          <p className="text-xs text-gray-600">No bots running</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {traders.slice(0, 8).map((t) => (
              <span key={t.id} className="rounded-full border border-gray-700 bg-gray-800/60 px-2.5 py-1 text-[11px] text-gray-200">
                {t.username}
              </span>
            ))}
            {traders.length > 8 && (
              <span className="rounded-full border border-gray-700 bg-gray-800/60 px-2.5 py-1 text-[11px] text-gray-400">
                +{traders.length - 8} more
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RuntimeControlPanel({
  control,
  updating,
  onSelect,
  onAuto,
  onToggleEntries,
}: {
  control: RuntimeControlData | null;
  updating: boolean;
  onSelect: (profile: 'glide' | 'pulse' | 'surge') => void;
  onAuto: () => void;
  onToggleEntries: (enabled: boolean) => void;
}) {
  const profiles = [
    { id: 'glide', label: 'Glide', detail: 'most conservative cadence · full fleet capacity preserved' },
    { id: 'pulse', label: 'Pulse', detail: 'balanced cadence · full fleet capacity preserved' },
    { id: 'surge', label: 'Surge', detail: 'fastest cadence · full fleet capacity preserved' },
  ] as const;

  const isManual = control?.modeSource === 'manual';
  const pressure = control?.pressure ?? null;
  const fmtAge = (ms?: number) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
  const fmtRatio = (r?: number) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  const pressureTone = (level?: string) =>
    level === 'halt' || level === 'throttle'
      ? 'text-rose-300'
      : level === 'watch'
        ? 'text-amber-300'
        : 'text-emerald-300';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">Global Flow Control</p>
          <p className="text-xs text-gray-600 mt-0.5">Fleet-wide Surge/Pulse/Glide throttle — keeps all bots under 90% of every provider lane.</p>
        </div>
        {control && (
          <div className="text-right text-[10px] uppercase tracking-[0.18em] text-cyan-200">
            {control.label}
            <div className="mt-1 normal-case tracking-normal text-gray-500">updated {formatDateTime(control.updatedAt)}</div>
          </div>
        )}
      </div>

      {control && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className={[
              'rounded-full px-2.5 py-1 font-semibold uppercase tracking-[0.16em]',
              isManual ? 'bg-amber-500/15 text-amber-200' : 'bg-emerald-500/15 text-emerald-200',
            ].join(' ')}
          >
            {isManual ? 'Manual pin' : 'Auto'}
          </span>
          <span className="text-gray-500">
            recommended <span className="text-cyan-200">{control.recommendedLabel}</span>
          </span>
          {isManual && control.recommendedProfile !== control.speedProfile && (
            <span className="text-amber-300/80">· auto would switch to {control.recommendedLabel}</span>
          )}
          {isManual && (
            <button
              type="button"
              disabled={updating}
              onClick={onAuto}
              className={[
                'ml-auto rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20',
                updating ? 'opacity-60 cursor-not-allowed' : '',
              ].join(' ')}
            >
              Return to Auto
            </button>
          )}
        </div>
      )}

      {control && (
        <div className={[
          'rounded-xl border p-4',
          control.entriesEnabled
            ? 'border-emerald-500/25 bg-emerald-500/5'
            : 'border-amber-400/35 bg-amber-500/10',
        ].join(' ')}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold text-white">Deployment entry lock</p>
              <p className="mt-1 text-xs text-gray-500">
                {control.entriesEnabled
                  ? 'New entries are allowed. Exits, stops, and reconciliation always stay enabled.'
                  : `New entries are blocked${control.maintenanceReason ? `: ${control.maintenanceReason}` : ''}. Exits, stops, and reconciliation still run.`}
              </p>
            </div>
            <button
              type="button"
              disabled={updating}
              onClick={() => onToggleEntries(!control.entriesEnabled)}
              className={[
                'rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
                control.entriesEnabled
                  ? 'border-amber-400/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                  : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20',
                updating ? 'opacity-60 cursor-not-allowed' : '',
              ].join(' ')}
            >
              {control.entriesEnabled ? 'Block New Entries' : 'Allow New Entries'}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {profiles.map((profile) => {
          const active = control?.speedProfile === profile.id;
          const recommended = control?.recommendedProfile === profile.id;
          return (
            <button
              key={profile.id}
              type="button"
              disabled={updating}
              onClick={() => onSelect(profile.id)}
              className={[
                'rounded-xl border px-4 py-4 text-left transition-colors',
                active
                  ? 'border-cyan-300/35 bg-cyan-500/10 text-white'
                  : 'border-gray-800 bg-gray-950/60 text-gray-300 hover:border-cyan-400/20 hover:bg-cyan-500/5',
                updating ? 'opacity-60 cursor-not-allowed' : '',
              ].join(' ')}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{profile.label}</span>
                {active && <span className="text-[10px] uppercase tracking-[0.18em] text-cyan-200">active</span>}
                {!active && recommended && <span className="text-[10px] uppercase tracking-[0.18em] text-emerald-300/80">rec</span>}
              </div>
              <div className="mt-2 text-xs text-gray-500">{profile.detail}</div>
            </button>
          );
        })}
      </div>

      {control && (
        <div className="grid grid-cols-2 xl:grid-cols-6 gap-3 text-[11px]">
          <SizingMetric label="bot capacity" value={String(control.concurrentCapacity)} />
          <SizingMetric label="max positions / bot" value={control.maxOpenPositions == null ? 'bot-decided' : String(control.maxOpenPositions)} />
          <SizingMetric label="ready / starting" value={`${control.cadenceMs.readyStarting} ms`} />
          <SizingMetric label="active in position" value={`${control.cadenceMs.activeInPosition} ms`} />
          <SizingMetric label="active flat" value={`${control.cadenceMs.activeFlat} ms`} />
          <SizingMetric label="guarded / post-submit" value={`${control.cadenceMs.activeGuarded} / ${control.cadenceMs.postSubmitFast} ms`} />
        </div>
      )}

      {control && pressure && (
        <div className="rounded-xl border border-gray-800 bg-gray-950/60 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-[0.18em] text-gray-500">Provider pressure (worst lane wins)</p>
            {pressure.worstLane && <p className="text-[11px] text-gray-400">binding: {pressure.worstLane}</p>}
          </div>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 text-[11px]">
            <SizingMetric label={`helius budget · ${fmtRatio(pressure.heliusUsageRatio)}`} value={<span className={pressureTone(pressure.heliusBudget)}>{pressure.heliusBudget ?? '—'}</span>} />
            <SizingMetric label={`jupiter budget · ${fmtRatio(pressure.jupiterUsageRatio)}`} value={<span className={pressureTone(pressure.jupiterBudget)}>{pressure.jupiterBudget ?? '—'}</span>} />
            <SizingMetric label="exec queue depth" value={String(pressure.queueDepth ?? 0)} />
            <SizingMetric label="queue oldest" value={fmtAge(pressure.queueOldestMs)} />
          </div>
          {control.transitionReason && (
            <p className="text-[11px] text-gray-500">
              last shift: {control.transitionReason}
              {control.lastTransitionAt ? ` · ${formatDateTime(control.lastTransitionAt)}` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Overview stat card ───────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-5">
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-3xl font-semibold text-white">{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
    </div>
  );
}

function SizingMetric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-gray-800 bg-gray-900/60 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-gray-600">{label}</p>
      <p className="text-sm font-medium text-gray-100 mt-1">{value}</p>
    </div>
  );
}

function SizingTable({ snapshots }: { snapshots: SessionSizingSnapshot[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">Recent Sizing Decisions</p>
          <p className="text-xs text-gray-600 mt-0.5">{snapshots.length} snapshots</p>
        </div>
      </div>

      {snapshots.length === 0 ? (
        <div className="text-sm text-gray-500 py-4">No sizing snapshots recorded yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-gray-600 border-b border-gray-800">
                <th className="py-2 pr-3">User</th>
                <th className="py-2 pr-3">Decision</th>
                <th className="py-2 pr-3">Amount</th>
                <th className="py-2 pr-3">PnL</th>
                <th className="py-2 pr-3">Time</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => {
                const rowKey = `${s.sessionId}-${s.at}`;
                const isOpen = expandedId === rowKey;
                const ctx = s.tradeContext;
                const amountLabel = ctx?.amountAtomic
                  ? formatAtomicAmount(ctx.amountAtomic, ctx.inputSymbol)
                  : lamportsToSolString(s.amountLamports);

                return (
                  <tr
                    key={rowKey}
                    onClick={() => setExpandedId(isOpen ? null : rowKey)}
                    className={[
                      'border-b border-gray-800/50 cursor-pointer transition-colors',
                      isOpen ? 'bg-gray-800/30' : 'hover:bg-gray-800/20',
                    ].join(' ')}
                  >
                    <td className="py-2 pr-3">
                      <span className="text-white font-medium">{s.username}</span>
                      {isOpen && (
                        <div className="mt-2 grid grid-cols-2 gap-1.5 pb-1">
                          {getSizingDisplay(s).primaryMetrics.slice(0, 6).map((m) => (
                            <div key={m.label} className="text-[10px]">
                              <span className="text-gray-600">{m.label}: </span>
                              <span className="text-gray-300">{m.value}</span>
                            </div>
                          ))}
                          {s.reason && <div className="col-span-2 text-yellow-300 text-[10px]">{s.reason}</div>}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={s.decision === 'traded' ? 'text-emerald-300' : 'text-yellow-300'}>
                        {s.decision}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-300 font-mono">{amountLabel}</td>
                    <td className="py-2 pr-3 font-mono">
                      <span className={s.totalPnlUsd !== null && s.totalPnlUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                        {formatSignedUsd(s.totalPnlUsd)}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-500">{formatDateTime(s.at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TradeDecisionPanel({ health }: { health: SessionHealthData }) {
  const outcomes = Object.entries(health.tradeDecisions.outcomes ?? {}).filter(([, count]) => count > 0);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold text-white">Live Trade Decisions</p>
          <p className="text-xs text-gray-600 mt-0.5">What active/starting sessions are deciding right now: submitted, blocked, attempted, or errored.</p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {(outcomes.length > 0 ? outcomes : [['unknown', 0] as [string, number]]).map(([outcome, count]) => (
            <SizingMetric key={outcome} label={outcome.replace(/_/g, ' ')} value={count} />
          ))}
        </div>
        {health.tradeDecisions.topBlockedReasons.length > 0 ? (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-gray-600">Top blocked reasons</p>
            {health.tradeDecisions.topBlockedReasons.slice(0, 8).map((item) => (
              <div key={item.reason} className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2">
                <span className="truncate text-xs text-gray-300">{formatReasonLabel(item.reason)}</span>
                <span className="font-mono text-sm text-white">{item.count}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-900/30 bg-emerald-950/20 px-3 py-3 text-xs text-emerald-300">
            No live blockers currently recorded.
          </div>
        )}
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold text-white">Live No-Trade Reasons</p>
          <p className="text-xs text-gray-600 mt-0.5">Sessions that are alive but did not submit because the worker intentionally blocked or deferred.</p>
        </div>
        {health.liveNoTrade.sessions.length === 0 ? (
          <div className="rounded-lg border border-emerald-900/30 bg-emerald-950/20 px-3 py-3 text-xs text-emerald-300">
            No live no-trade sessions in the current snapshot.
          </div>
        ) : (
          <div className="max-h-80 overflow-auto space-y-2 pr-1">
            {health.liveNoTrade.sessions.map((session) => (
              <div key={session.sessionId} className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">{session.username}</p>
                    <p className="font-mono text-[10px] text-gray-600">{session.sessionId.slice(0, 8)}… · {session.status.replace(/_/g, ' ')}</p>
                  </div>
                  <span className="rounded-full border border-yellow-900/50 bg-yellow-950/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-yellow-300">
                    {session.lastDecisionOutcome ?? 'unknown'}
                  </span>
                </div>
                <p className="mt-2 text-xs text-gray-300">{formatReasonLabel(session.blocker)}</p>
                <p className="mt-1 text-[10px] text-gray-600">
                  decision age {session.lastDecisionAgeMinutes === null ? '—' : formatAgeMinutes(session.lastDecisionAgeMinutes)} · last submit {session.lastSubmitAgeMinutes === null ? '—' : formatAgeMinutes(session.lastSubmitAgeMinutes)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecentTradesTable({ trades }: { trades: SessionHealthData['recentTrades'] }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">Recent Trade Ledger</p>
          <p className="text-xs text-gray-600 mt-0.5">Confirmed, submitted, failed, and canceled swaps joined by session wallet. This is the live trading receipt tape.</p>
        </div>
        <span className="rounded-full border border-cyan-900/40 bg-cyan-950/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-200">
          {trades.length} rows
        </span>
      </div>

      {trades.length === 0 ? (
        <div className="rounded-lg border border-gray-800 bg-gray-950/70 px-4 py-4 text-xs text-gray-500">
          No swap executions found yet.
        </div>
      ) : (
        <div className="max-h-120 overflow-auto rounded-lg border border-gray-800">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 z-10 bg-gray-950">
              <tr className="border-b border-gray-800 text-left text-[10px] uppercase tracking-wider text-gray-600">
                <th className="py-2 pr-3">User</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Route</th>
                <th className="py-2 pr-3">Amount</th>
                <th className="py-2 pr-3">Strategy / Exit</th>
                <th className="py-2 pr-3">Signature</th>
                <th className="py-2 pr-3">Error</th>
                <th className="py-2 pr-3">Time</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => {
                const errorSummary = formatErrorSummary(trade.lastError);
                const statusTone = trade.status === 'confirmed'
                  ? 'text-emerald-300'
                  : trade.status === 'failed'
                    ? 'text-rose-300'
                    : trade.status === 'submitted'
                      ? 'text-cyan-300'
                      : 'text-yellow-300';

                return (
                  <tr key={trade.executionId} className="border-b border-gray-800/50 align-top">
                    <td className="py-2 pr-3">
                      <p className="font-medium text-white">{trade.username}</p>
                      <p className="font-mono text-[10px] text-gray-600">{trade.sessionId.slice(0, 8)} · {trade.sessionStatus.replace(/_/g, ' ')}</p>
                    </td>
                    <td className={`py-2 pr-3 font-semibold ${statusTone}`}>
                      {trade.status}
                      {trade.confirmationStatus && <p className="font-normal text-[10px] text-gray-600">{trade.confirmationStatus}</p>}
                    </td>
                    <td className="py-2 pr-3 text-gray-300">
                      {symbolForMint(trade.inputMint)} → {symbolForMint(trade.outputMint)}
                      <p className="font-mono text-[10px] text-gray-600">{trade.swapPath}</p>
                    </td>
                    <td className="py-2 pr-3 font-mono text-gray-300">{formatMintAmount(trade.amount, trade.inputMint)}</td>
                    <td className="py-2 pr-3 text-gray-300">
                      <p>{trade.exitReason ? `exit · ${formatReasonLabel(trade.exitReason)}` : trade.entryStrategy ? `entry · ${formatReasonLabel(trade.entryStrategy)}` : 'wallet / reconcile'}</p>
                      <p className="text-[10px] text-gray-600">scan {formatReasonLabel(trade.scannerStrategy)}{trade.exitStrategy ? ` · exit ${formatReasonLabel(trade.exitStrategy)}` : ''}</p>
                    </td>
                    <td className="py-2 pr-3 font-mono text-gray-400">
                      {trade.signature ? `${trade.signature.slice(0, 8)}…${trade.signature.slice(-6)}` : '—'}
                    </td>
                    <td className="py-2 pr-3 text-rose-300 max-w-xs">
                      {errorSummary ? <span title={errorSummary}>{errorSummary}</span> : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-gray-500">{formatDateTime(trade.confirmedAt ?? trade.submittedAt ?? trade.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function getSizingDisplay(snapshot: SessionSizingSnapshot) {
  const ctx = snapshot.tradeContext;
  if (!ctx) {
    return {
      primaryMetrics: [
        { label: 'Balance', value: lamportsToSolString(snapshot.balanceLamports) },
        { label: 'Reserve', value: lamportsToSolString(snapshot.reserveLamports) },
        { label: 'Tradable', value: lamportsToSolString(snapshot.tradableLamports) },
        { label: 'Target', value: lamportsToSolString(snapshot.targetLamports) },
        { label: 'Trade Amount', value: lamportsToSolString(snapshot.amountLamports) },
        { label: 'Fraction', value: `${(snapshot.fractionBps / 100).toFixed(2)}%` },
        { label: 'Min Output', value: atomicUsdcToString(snapshot.minimumOutputAtomic) },
        { label: 'Net Cost', value: atomicUsdcToString(snapshot.totalWorstCaseCostOutputAtomic) },
        { label: 'Risk Budget', value: snapshot.remainingRiskBudgetUsd !== null ? `$${snapshot.remainingRiskBudgetUsd.toFixed(4)}` : '—' },
        { label: 'Realized PnL', value: formatSignedUsd(snapshot.realizedPnlUsd) },
        { label: 'Unrealized PnL', value: formatSignedUsd(snapshot.unrealizedPnlUsd) },
        { label: 'Total PnL', value: formatSignedUsd(snapshot.totalPnlUsd) },
      ],
      detailChips: [
        `min ${lamportsToSolString(snapshot.minTradeLamports)}`,
        `max ${lamportsToSolString(snapshot.maxTradeLamports)}`,
        `network ${lamportsToSolString(snapshot.estimatedNetworkCostLamports)}`,
        ...(snapshot.priceImpactPct ? [`impact ${snapshot.priceImpactPct}%`] : []),
        ...(snapshot.riskAdjustedAmountLamports ? [`adjusted ${lamportsToSolString(snapshot.riskAdjustedAmountLamports)}`] : []),
      ],
    };
  }

  return {
    primaryMetrics: [
      { label: `${ctx.inputSymbol} Inventory`, value: formatAtomicAmount(ctx.balanceAtomic, ctx.inputSymbol) },
      { label: 'SOL Fee Buffer', value: lamportsToSolString(snapshot.balanceLamports) },
      { label: 'Tradable Input', value: formatAtomicAmount(ctx.tradableAtomic, ctx.inputSymbol) },
      { label: 'Target Input', value: formatAtomicAmount(ctx.targetAtomic, ctx.inputSymbol) },
      { label: 'Trade Amount', value: formatAtomicAmount(ctx.amountAtomic, ctx.inputSymbol) },
      { label: 'Fraction', value: `${(snapshot.fractionBps / 100).toFixed(2)}%` },
      { label: 'Min Output', value: formatAtomicAmount(snapshot.minimumOutputAtomic, ctx.outputSymbol) },
      { label: 'Net Cost', value: formatAtomicAmount(snapshot.totalWorstCaseCostOutputAtomic, ctx.outputSymbol) },
      { label: 'Risk Budget', value: snapshot.remainingRiskBudgetUsd !== null ? `$${snapshot.remainingRiskBudgetUsd.toFixed(4)}` : '—' },
      { label: 'Realized PnL', value: formatSignedUsd(snapshot.realizedPnlUsd) },
      { label: 'Unrealized PnL', value: formatSignedUsd(snapshot.unrealizedPnlUsd) },
      { label: 'Total PnL', value: formatSignedUsd(snapshot.totalPnlUsd) },
    ],
    detailChips: [
      `input ${ctx.inputSymbol} → ${ctx.outputSymbol}`,
      `min ${formatAtomicAmount(ctx.minTradeAtomic, ctx.inputSymbol)}`,
      `max ${formatAtomicAmount(ctx.maxTradeAtomic, ctx.inputSymbol)}`,
      `sol reserve ${lamportsToSolString(snapshot.reserveLamports)}`,
      `network ${lamportsToSolString(snapshot.estimatedNetworkCostLamports)}`,
      ...(snapshot.priceImpactPct ? [`impact ${snapshot.priceImpactPct}%`] : []),
      ...(ctx.riskAdjustedAmountAtomic ? [`adjusted ${formatAtomicAmount(ctx.riskAdjustedAmountAtomic, ctx.inputSymbol)}`] : []),
    ],
  };
}

function formatAgeMinutes(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function getAdminSessionBalanceLamports(session: AdminSession) {
  const balance = session.funding?.currentBalanceAtomic;
  if (typeof balance === 'string') return balance;
  if (typeof balance === 'number' && Number.isFinite(balance)) return String(balance);
  return '0';
}

function getAdminSessionRealizedPnl(session: AdminSession) {
  const pnl = session.funding?.realizedPnlUsd;
  if (typeof pnl === 'number' && Number.isFinite(pnl)) return pnl;
  return 0;
}

function getAdminSessionPositionLabel(session: AdminSession) {
  const serviceControl = (session.service_control as {
    positionsState?: {
      positions?: Record<string, { status?: unknown; positionSymbol?: unknown; pendingExitReason?: unknown; exitReason?: unknown }>;
    };
    positionState?: { status?: unknown; exitReason?: unknown; positionSymbol?: unknown };
  }) ?? {};
  const positions = Object.values(serviceControl.positionsState?.positions ?? {}).filter((position) => position?.status === 'long' || position?.status === 'long_sol');

  if (positions.length > 0) {
    const symbols = positions
      .map((position) => typeof position.positionSymbol === 'string' ? position.positionSymbol : null)
      .filter((symbol): symbol is string => Boolean(symbol))
      .slice(0, 2);
    const pendingReasons = positions
      .map((position) => typeof position.pendingExitReason === 'string' ? position.pendingExitReason : null)
      .filter((reason): reason is string => Boolean(reason));
    const suffix = symbols.length > 0 ? ` · ${symbols.join(', ')}` : '';
    const pending = pendingReasons.length > 0 ? ` · EXIT ${pendingReasons[0].replace(/_/g, ' ')}` : '';
    return `${positions.length} OPEN${suffix}${pending}`;
  }

  const positionState = serviceControl.positionState;
  const status = positionState?.status;
  const exitReason = typeof positionState?.exitReason === 'string' ? positionState.exitReason : null;

  if (status === 'long_sol' || status === 'long') {
    const symbol = typeof positionState?.positionSymbol === 'string' ? positionState.positionSymbol : 'POSITION';
    return `1 OPEN · ${symbol}`;
  }
  if (exitReason) return `FLAT · ${exitReason.replace(/_/g, ' ')}`;
  return 'FLAT';
}

function getAdminSessionHealthLabel(session: AdminSession) {
  const serviceControl = (session.service_control as {
    healthState?: { state?: unknown; severity?: unknown; reason?: unknown; blockerCount?: unknown };
    schedulingState?: { lastBlockedReason?: unknown; blockedReasonCounts?: unknown };
    residualRecovery?: unknown;
  }) ?? {};
  const health = serviceControl.healthState;
  const state = typeof health?.state === 'string' ? health.state : null;
  const reason = typeof health?.reason === 'string'
    ? health.reason
    : typeof serviceControl.schedulingState?.lastBlockedReason === 'string'
      ? serviceControl.schedulingState.lastBlockedReason
      : null;
  const count = typeof health?.blockerCount === 'number' && health.blockerCount > 0 ? ` ×${health.blockerCount}` : '';

  if (state) return `${state.replace(/_/g, ' ')}${reason ? ` · ${reason.replace(/_/g, ' ')}${count}` : ''}`;
  if (serviceControl.residualRecovery) return 'recovery required · residual tokens';
  if (reason) return `blocked · ${reason.replace(/_/g, ' ')}`;
  return '—';
}

const strategyLabel = (strategy: StrategyKey) => (
  strategy === 'mean_reversion'
    ? 'mean reversion'
    : strategy === 'supertrend'
      ? 'supertrend'
      : 'momentum'
);

function getSessionStrategyForm(session: AdminSession): SessionStrategyForm {
  const sc = session.service_control as {
    strategyUniverse?: Array<{ key?: unknown; enabled?: unknown }>;
    rotationState?: {
      activeStrategy?: unknown;
      queuedStrategy?: unknown;
      rotationIntervalMinutes?: unknown;
    };
    strategyConfig?: {
      autoRotationEnabled?: unknown;
      momentum?: {
        lookbackSamples?: unknown;
        thresholdBps?: unknown;
        edgeSafetyBufferBps?: unknown;
      };
    };
  };

  const enabledStrategies = (sc.strategyUniverse ?? [])
    .filter((entry) => entry?.enabled === true)
    .map((entry) => entry.key)
    .filter((key): key is StrategyKey => key === 'momentum' || key === 'mean_reversion' || key === 'supertrend');

  const activeStrategy = (sc.rotationState?.activeStrategy === 'momentum'
    || sc.rotationState?.activeStrategy === 'mean_reversion'
    || sc.rotationState?.activeStrategy === 'supertrend')
    ? sc.rotationState.activeStrategy
    : 'momentum';

  const queuedStrategy = (sc.rotationState?.queuedStrategy === 'momentum'
    || sc.rotationState?.queuedStrategy === 'mean_reversion'
    || sc.rotationState?.queuedStrategy === 'supertrend')
    ? sc.rotationState.queuedStrategy
    : activeStrategy;

  return {
    enabledStrategies: enabledStrategies.length > 0 ? enabledStrategies : DEFAULT_ENABLED_STRATEGIES,
    activeStrategy,
    queuedStrategy,
    rotationIntervalMinutes: Number(sc.rotationState?.rotationIntervalMinutes ?? DEFAULT_ROTATION_INTERVAL_MINUTES),
    autoRotationEnabled: sc.strategyConfig?.autoRotationEnabled !== false,
    momentumLookbackSamples: Number(sc.strategyConfig?.momentum?.lookbackSamples ?? 5),
    momentumThresholdBps: Number(sc.strategyConfig?.momentum?.thresholdBps ?? 8),
    momentumEdgeSafetyBufferBps: Number(sc.strategyConfig?.momentum?.edgeSafetyBufferBps ?? 5),
  };
}

function SessionIssuePanel({
  title,
  subtitle,
  issues,
  emptyLabel,
}: {
  title: string;
  subtitle: string;
  issues: SessionHealthIssue[];
  emptyLabel: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="text-xs text-gray-600 mt-0.5">{subtitle}</p>
      </div>

      {issues.length === 0 ? (
        <div className="rounded-lg border border-emerald-900/30 bg-emerald-950/20 px-3 py-3 text-xs text-emerald-300">
          {emptyLabel}
        </div>
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => (
            <div key={`${issue.status}-${issue.sessionId}`} className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white truncate">{issue.username}</p>
                  <p className="text-[10px] text-gray-600 font-mono">{issue.sessionId.slice(0, 8)}…</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-yellow-400 font-medium">{formatAgeMinutes(issue.ageMinutes)}</p>
                  <p className="text-[10px] text-gray-600 uppercase tracking-wider">{issue.status.replace(/_/g, ' ')}</p>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-2">{issue.reason}</p>
              {issue.stopReason && (
                <p className="text-[10px] text-gray-500 mt-1">Stop reason: {issue.stopReason.replace(/_/g, ' ')}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IntroGate({ storageKey, onUnlock }: GateProps) {
  const [phase, setPhase] = useState<'checking' | 'video' | 'password'>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlocked = typeof window !== 'undefined' && window.sessionStorage.getItem(storageKey) === 'true';
    if (unlocked) {
      onUnlock();
      return;
    }

    const timer = window.setTimeout(() => setPhase('video'), 0);
    return () => window.clearTimeout(timer);
  }, [onUnlock, storageKey]);

  const submitPassword = useCallback(() => {
    if (password !== GATE_PASSWORD) {
      setError('wrong password');
      return;
    }

    window.sessionStorage.setItem(storageKey, 'true');
    onUnlock();
  }, [onUnlock, password, storageKey]);

  return (
    <div className="relative min-h-screen bg-black text-white overflow-hidden">
      <div className="absolute inset-0">
        <video
          autoPlay
          muted
          playsInline
          onEnded={() => setPhase('password')}
          className="h-screen w-screen object-contain bg-black"
        >
          <source src={GATE_VIDEO_SRC} type="video/mp4" />
        </video>
      </div>

        {phase === 'checking' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/75 text-sm uppercase tracking-[0.25em] text-cyan-200">
            loading
          </div>
        )}

        {phase === 'password' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/62 backdrop-blur-sm p-6">
            <div className="w-full max-w-sm rounded-2xl border border-cyan-200/20 bg-slate-950/88 p-5 shadow-[0_0_35px_rgba(34,211,238,0.08)]">
              <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-300">admin gate</div>
              <div className="mt-2 text-lg text-white">enter password</div>
              <input
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    submitPassword();
                  }
                }}
                className="mt-4 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/40"
                placeholder="temporary password"
                autoFocus
              />
              {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
              <button
                type="button"
                onClick={submitPassword}
                className="mt-4 w-full rounded-lg border border-cyan-300/25 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100 transition hover:bg-cyan-500/18"
              >
                unlock admin
              </button>
            </div>
          </div>
        )}
    </div>
  );
}

// ─── Per-user license key gradient colors ───────────────────────────────────

function getUserKeyColors(id: string): [string, string, string] {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  const u32 = h >>> 0;
  const hue  =  u32        % 360;
  const hue2 = (hue + 137) % 360;
  const hue3 = (hue + 274) % 360;
  return [
    `hsl(${hue}, 90%, 68%)`,
    `hsl(${hue2}, 90%, 68%)`,
    `hsl(${hue3}, 90%, 68%)`,
  ];
}

// ─── User Card ────────────────────────────────────────────────────────────────

interface UserCardProps {
  user: User;
  isLive: boolean;
  onToggle: (id: string, current: boolean) => void;
  onAssign: (id: string) => void;
  onEdit: (user: User) => void;
  onDelete: (id: string) => void;
  assigning: string | null;
  toggling:  string | null;
}

function UserCard({ user: u, isLive, onToggle, onAssign, onEdit, onDelete, assigning, toggling }: UserCardProps) {
  const [copiedKey,    setCopiedKey]    = useState(false);
  const [copiedWallet, setCopiedWallet] = useState(false);

  const isActive = u.access_enabled && !isExpired(u.expiry_date);
  const isGated = Boolean(u.gated_access_enrolled_at);

  const [kc1, kc2, kc3] = getUserKeyColors(u.id);
  const licenseKeyStyle: React.CSSProperties = {
    backgroundImage: `linear-gradient(90deg, ${kc1}, ${kc2}, ${kc3}, ${kc1})`,
    backgroundSize: isActive ? '300% 100%' : '100% 100%',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
    ...(isActive ? { animation: 'tradingFlow 3s linear infinite' } : { opacity: 0.35 }),
  };

  function copyKey() {
    if (!u.license_key) return;
    void navigator.clipboard.writeText(u.license_key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 1500);
  }

  function copyWallet() {
    void navigator.clipboard.writeText(u.wallet_address);
    setCopiedWallet(true);
    setTimeout(() => setCopiedWallet(false), 1500);
  }

  return (
    <div className={[
      'relative bg-gray-900 rounded-lg border overflow-hidden transition-all duration-300',
      isActive ? 'border-blue-500/25 shadow-md shadow-blue-950/20' : 'border-gray-800/80',
    ].join(' ')}>
      <div className={['absolute left-0 top-0 bottom-0 w-0.5', isActive ? 'trading-accent-bar' : 'bg-gray-800'].join(' ')} />

      <div className="pl-3.5 pr-3 py-3 flex flex-col gap-2">

        {/* Row 1: username + LIVE/IDLE + toggle */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={['text-sm font-semibold truncate', isActive ? 'text-white' : 'trading-inactive-text'].join(' ')}>
              {u.username}
            </span>
            {u.access_enabled && !isExpired(u.expiry_date) && isLive && (
              <span className="trading-live-badge shrink-0">● LIVE</span>
            )}
            {!u.access_enabled && (
              <span className="trading-idle-badge shrink-0">● IDLE</span>
            )}
            {u.access_enabled && isExpired(u.expiry_date) && (
              <span className="text-[9px] text-red-500 font-medium shrink-0">● EXP</span>
            )}
            {u.group_name && (
              <span className="text-[9px] text-violet-300 bg-violet-500/10 border border-violet-400/20 px-1.5 py-0.5 rounded-full shrink-0">
                {u.group_name}
              </span>
            )}
          </div>
          <button
            onClick={() => void onToggle(u.id, u.access_enabled)}
            disabled={toggling === u.id}
            title={u.access_enabled ? 'Disable trading' : 'Enable trading'}
            className={[
              'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200',
              u.access_enabled ? 'bg-emerald-600' : 'bg-gray-700',
              toggling === u.id ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
            ].join(' ')}
          >
            <span className={[
              'inline-block h-3.5 w-3.5 mt-0.75 rounded-full bg-white shadow transition-transform duration-200',
              u.access_enabled ? 'translate-x-4.5' : 'translate-x-0.5',
            ].join(' ')} />
          </button>
        </div>

        {/* Row 2: License Key */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-gray-700 shrink-0 uppercase tracking-wider">Key</span>
          {u.license_key ? (
            <>
              <span className="font-mono text-[10px] flex-1 min-w-0" style={licenseKeyStyle}>{u.license_key}</span>
              <button onClick={copyKey} className="shrink-0 text-[9px] text-gray-700 hover:text-emerald-400 transition-colors">
                {copiedKey ? '✓' : 'copy'}
              </button>
            </>
          ) : (
            <span className="text-[10px] text-gray-700 italic">not assigned</span>
          )}
        </div>

        {/* Row 3: Wallet + expiry */}
        <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] text-gray-600">{shortWallet(u.wallet_address)}</span>
                {isGated && (
                  <span
                    title={u.gated_access_enrolled_at ? `Trusted-device enrolled ${formatDateTime(u.gated_access_enrolled_at)}` : 'Trusted-device enrolled'}
                    className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-200"
                  >
                    <span className="text-cyan-300">✓</span>
                    gated
                  </span>
                )}
            <button onClick={copyWallet} className="text-[9px] text-gray-700 hover:text-gray-400 transition-colors">
              {copiedWallet ? '✓' : '·copy'}
            </button>
          </div>
          <span className={`text-[9px] shrink-0 ${isExpired(u.expiry_date) ? 'text-red-500' : 'text-gray-600'}`}>
            {u.expiry_date ? formatDate(u.expiry_date) : '—'}{isExpired(u.expiry_date) ? ' · exp' : ''}
          </span>
        </div>

        {/* Row 4: Actions */}
        <div className="flex gap-1.5 pt-2 border-t border-gray-800/40">
          {!u.license_key && (
            <button
              onClick={() => void onAssign(u.id)}
              disabled={assigning === u.id}
              className="flex-1 bg-blue-700/70 hover:bg-blue-600 disabled:opacity-40 text-white text-[10px] font-medium px-2 py-1.5 rounded transition-colors"
            >
              {assigning === u.id ? 'Generating…' : 'Assign License'}
            </button>
          )}
          <button
            onClick={() => onEdit(u)}
            className="text-gray-500 hover:text-emerald-300 text-[10px] px-2 py-1.5 rounded hover:bg-emerald-900/20 transition-colors"
          >
            Edit
          </button>
          <button
            onClick={() => void onDelete(u.id)}
            className="text-gray-700 hover:text-red-400 text-[10px] px-2 py-1.5 rounded hover:bg-red-900/20 transition-colors"
          >
            Remove
          </button>
        </div>

      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [tab, setTab]             = useState<Tab>('users');
  const [users, setUsers]         = useState<User[]>([]);
  const [groups, setGroups]       = useState<UserGroup[]>([]);
  const [managers, setManagers]   = useState<Manager[]>([]);
  const [loading, setLoading]     = useState(true);
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  const [adminSessions, setAdminSessions] = useState<AdminSession[]>([]);
  const [adminSessionsLoading, setAdminSessionsLoading] = useState(false);
  const [forceStoppingSessionId, setForceStoppingSessionId] = useState<string | null>(null);
  const [strategyFormBySession, setStrategyFormBySession] = useState<Record<string, SessionStrategyForm>>({});
  const [savingStrategySessionId, setSavingStrategySessionId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editingGroup, setEditingGroup] = useState<UserGroup | null>(null);
  const [form, setForm]           = useState({ username: '', walletAddress: '', duration: '1month', maxWalletUsd: '10000', groupId: '' });
  const [groupForm, setGroupForm] = useState({ name: '', botLimit: '1', existingUserId: '', newUsername: '', newWalletAddress: '', newDuration: '1month', newMaxWalletUsd: '10000' });
  const [formBusy, setFormBusy]   = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [toggling, setToggling]   = useState<string | null>(null);
  const [showManagerModal, setShowManagerModal] = useState(false);
  const [managerForm, setManagerForm] = useState({ name: '', duration: '1month' });
  const [managerBusy, setManagerBusy] = useState(false);
  const [managerAssigning, setManagerAssigning] = useState<string | null>(null);
  const [managerToggling, setManagerToggling] = useState<string | null>(null);
  const [bgImage, setBgImage]     = useState<string | null>(null);
  const fileRef                   = useRef<HTMLInputElement>(null);

  // ─ Rate Limits state ─────────────────────────────────────────────────────
  const [rlData,    setRlData]    = useState<RateLimitData | null>(null);
  const [rlLoading, setRlLoading] = useState(false);
  const [sessionHealth, setSessionHealth] = useState<SessionHealthData | null>(null);
  const [sessionHealthLoading, setSessionHealthLoading] = useState(false);
  const [tokenUniverse, setTokenUniverse] = useState<TokenUniverseOverview | null>(null);
  const [tokenUniverseLoading, setTokenUniverseLoading] = useState(false);
  const [runtimeControl, setRuntimeControl] = useState<RuntimeControlData | null>(null);
  const [runtimeControlLoading, setRuntimeControlLoading] = useState(false);
  const [runtimeControlUpdating, setRuntimeControlUpdating] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [gateUnlocked, setGateUnlocked] = useState(false);
  const handleGateUnlock = useCallback(() => setGateUnlocked(true), []);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const [res, groupsRes, managersRes] = await Promise.all([
        fetch('/api/users'),
        fetch('/api/user-groups'),
        fetch('/api/managers'),
      ]);
      const data = await res.json() as { success: boolean; users: User[] };
      const groupsData = await groupsRes.json() as { success: boolean; groups: UserGroup[] };
      const managersData = await managersRes.json() as { success: boolean; managers: Manager[] };
      setUsers(data.users ?? []);
      setGroups(groupsData.groups ?? []);
      setManagers(managersData.managers ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchActiveSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions/active');
      if (!res.ok) return;
      const data = await res.json() as { activeUserIds: string[] };
      setActiveSessions(new Set(data.activeUserIds));
    } catch {
      // sessions table may not exist yet
    }
  }, []);

  const fetchRuntimeControl = useCallback(async () => {
    setRuntimeControlLoading(true);
    try {
      const res = await fetch('/api/runtime-control');
      if (!res.ok) return;
      const data = await res.json() as RuntimeControlData;
      setRuntimeControl(data);
    } finally {
      setRuntimeControlLoading(false);
    }
  }, []);

  useEffect(() => {
    const boot = setTimeout(() => {
      void loadUsers();
      void fetchActiveSessions();
      void fetchRuntimeControl();
      setNowMs(Date.now());
    }, 0);
    const t = setInterval(() => {
      void fetchActiveSessions();
      void fetchRuntimeControl();
    }, 8000);
    return () => {
      clearTimeout(boot);
      clearInterval(t);
    };
  }, [loadUsers, fetchActiveSessions, fetchRuntimeControl]);

  const updateRuntimeControl = useCallback(async (speedProfile: 'glide' | 'pulse' | 'surge') => {
    setRuntimeControlUpdating(true);
    try {
      const res = await fetch('/api/runtime-control', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speedProfile }),
      });
      if (!res.ok) return;
      const data = await res.json() as RuntimeControlData;
      setRuntimeControl(data);
    } finally {
      setRuntimeControlUpdating(false);
    }
  }, []);

  const resumeRuntimeAuto = useCallback(async () => {
    setRuntimeControlUpdating(true);
    try {
      const res = await fetch('/api/runtime-control', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modeSource: 'auto' }),
      });
      if (!res.ok) return;
      const data = await res.json() as RuntimeControlData;
      setRuntimeControl(data);
    } finally {
      setRuntimeControlUpdating(false);
    }
  }, []);

  const toggleRuntimeEntries = useCallback(async (entriesEnabled: boolean) => {
    setRuntimeControlUpdating(true);
    try {
      const res = await fetch('/api/runtime-control', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entriesEnabled,
          maintenanceReason: entriesEnabled ? null : 'deployment',
        }),
      });
      if (!res.ok) return;
      const data = await res.json() as RuntimeControlData;
      setRuntimeControl(data);
    } finally {
      setRuntimeControlUpdating(false);
    }
  }, []);

  const fetchRateLimits = useCallback(async () => {
    setRlLoading(true);
    try {
      const [h, j, t, b] = await Promise.all([
        fetch('/api/rate-limits/helius').then(r   => r.json()),
        fetch('/api/rate-limits/jupiter').then(r   => r.json()),
        fetch('/api/rate-limits/tigerdata').then(r => r.json()),
        fetch('/api/provider/budgets').then(r => r.json()),
      ]);
      setRlData({ helius: h, jupiter: j, tigerdata: t, providerBudgets: b });
    } finally {
      setRlLoading(false);
    }
  }, []);

  const fetchSessionHealth = useCallback(async () => {
    setSessionHealthLoading(true);
    try {
      const res = await fetch('/api/sessions/health');
      if (!res.ok) return;
      const data = await res.json() as SessionHealthData;
      setSessionHealth(data);
    } finally {
      setSessionHealthLoading(false);
    }
  }, []);

  const fetchTokenUniverse = useCallback(async () => {
    setTokenUniverseLoading(true);
    try {
      const res = await fetch('/api/token-universe');
      if (!res.ok) return;
      const data = await res.json() as TokenUniverseOverview;
      setTokenUniverse(data);
    } finally {
      setTokenUniverseLoading(false);
    }
  }, []);

  const loadAdminSessions = useCallback(async () => {
    setAdminSessionsLoading(true);
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) return;
      const data = await res.json() as { sessions: AdminSession[] };
      const sessions = data.sessions ?? [];
      setAdminSessions(sessions);
      setStrategyFormBySession((prev) => {
        const next = { ...prev };
        for (const session of sessions) {
          if (!next[session.id]) {
            next[session.id] = getSessionStrategyForm(session);
          }
        }
        return next;
      });
    } finally {
      setAdminSessionsLoading(false);
    }
  }, []);

  const updateSessionStrategyForm = useCallback((sessionId: string, updater: (current: SessionStrategyForm) => SessionStrategyForm) => {
    setStrategyFormBySession((prev) => {
      const fallbackSession = adminSessions.find((session) => session.id === sessionId);
      const current = prev[sessionId]
        ?? (fallbackSession ? getSessionStrategyForm(fallbackSession) : {
          enabledStrategies: DEFAULT_ENABLED_STRATEGIES,
          activeStrategy: 'momentum',
          queuedStrategy: 'momentum',
          rotationIntervalMinutes: DEFAULT_ROTATION_INTERVAL_MINUTES,
          autoRotationEnabled: true,
          momentumLookbackSamples: 5,
          momentumThresholdBps: 8,
          momentumEdgeSafetyBufferBps: 5,
        });
      return {
        ...prev,
        [sessionId]: updater(current),
      };
    });
  }, [adminSessions]);

  const saveSessionStrategyControls = useCallback(async (sessionId: string) => {
    const form = strategyFormBySession[sessionId];
    if (!form) return;

    setSavingStrategySessionId(sessionId);
    try {
      await fetch(`/api/sessions/${sessionId}/strategy-controls`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabledStrategies: form.enabledStrategies,
          activeStrategy: form.activeStrategy,
          queuedStrategy: form.queuedStrategy,
          rotationIntervalMinutes: form.rotationIntervalMinutes,
          autoRotationEnabled: form.autoRotationEnabled,
          momentum: {
            lookbackSamples: form.momentumLookbackSamples,
            thresholdBps: form.momentumThresholdBps,
            edgeSafetyBufferBps: form.momentumEdgeSafetyBufferBps,
          },
        }),
      });

      await Promise.all([
        loadAdminSessions(),
        fetchSessionHealth(),
      ]);
    } finally {
      setSavingStrategySessionId(null);
    }
  }, [fetchSessionHealth, loadAdminSessions, strategyFormBySession]);

  useEffect(() => {
    if (tab !== 'rate-limits') return;
    const refresh = setTimeout(() => {
      void fetchRateLimits();
    }, 0);
    return () => clearTimeout(refresh);
  }, [tab, fetchRateLimits]);

  useEffect(() => {
    if (tab !== 'session-health') return;
    const refresh = setTimeout(() => {
      void fetchSessionHealth();
      void loadAdminSessions();
    }, 0);
    const t = setInterval(() => {
      void fetchSessionHealth();
      void loadAdminSessions();
    }, 10000);
    return () => {
      clearTimeout(refresh);
      clearInterval(t);
    };
  }, [tab, fetchSessionHealth, loadAdminSessions]);

  useEffect(() => {
    if (!gateUnlocked) return;
    const refresh = setTimeout(() => {
      void fetchTokenUniverse();
    }, 0);
    const t = setInterval(() => {
      void fetchTokenUniverse();
    }, 10000);
    return () => {
      clearTimeout(refresh);
      clearInterval(t);
    };
  }, [gateUnlocked, fetchTokenUniverse]);

  const handleForceStopSession = useCallback(async (sessionId: string) => {
    setForceStoppingSessionId(sessionId);
    try {
      await fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
      await Promise.all([
        loadAdminSessions(),
        fetchSessionHealth(),
        fetchActiveSessions(),
      ]);
    } finally {
      setForceStoppingSessionId(null);
    }
  }, [fetchActiveSessions, fetchSessionHealth, loadAdminSessions]);

  const expiringSoonUsers = users.filter((u) => {
    if (!u.expiry_date) return false;
    const days = (new Date(u.expiry_date).getTime() - nowMs) / 86400000;
    return days >= 0 && days <= 30;
  });
  const licensedUsersCount = users.filter(u => u.access_enabled && !isExpired(u.expiry_date)).length;
  const activelyTradingCount = activeSessions.size;
  const idleUsersCount = Math.max(0, users.length - activelyTradingCount);

  const heliusFleetRps = rlData?.helius?.plan?.fleetTarget?.rpcRps ?? 180;
  const heliusFleetDas = rlData?.helius?.plan?.fleetTarget?.dasRps ?? 45;
  const heliusProviderRps = rlData?.helius?.plan?.providerCap?.rpcRps ?? 200;
  const heliusProviderDas = rlData?.helius?.plan?.providerCap?.dasRps ?? 50;
  const heliusSenderTps = rlData?.helius?.plan?.fleetTarget?.senderTps ?? 45;
  const heliusMonthlyCredits = rlData?.helius?.plan?.monthlyCredits ?? 100_000_000;

  const jupiterFleetRps = rlData?.jupiter?.plan?.fleetTarget?.generalRps ?? 135;
  const jupiterProviderRps = rlData?.jupiter?.plan?.providerCap?.generalRps ?? 150;
  const jupiterExecuteRps = rlData?.jupiter?.plan?.providerCap?.executeRps ?? 100;
  const jupiterMonthlyBudget = rlData?.jupiter?.plan?.monthlyRequestsBudget ?? 500_000_000;

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setFormBusy(true);
    const editing = editingUser !== null;
    await fetch(editing ? `/api/users/${editingUser.id}` : '/api/users', {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        maxWalletUsd: Number(form.maxWalletUsd),
        groupId: form.groupId || null,
        refreshExpiry: editing,
      }),
    });
    setShowModal(false);
    setEditingUser(null);
    setForm({ username: '', walletAddress: '', duration: '1month', maxWalletUsd: '10000', groupId: '' });
    setFormBusy(false);
    void loadUsers();
  }

  async function handleCreateOrUpdateGroup(e: React.FormEvent) {
    e.preventDefault();
    setFormBusy(true);
    const existingUserIds = groupForm.existingUserId ? [groupForm.existingUserId] : [];
    const newUsers = groupForm.newUsername && groupForm.newWalletAddress ? [{
      username: groupForm.newUsername,
      walletAddress: groupForm.newWalletAddress,
      duration: groupForm.newDuration,
      maxWalletUsd: Number(groupForm.newMaxWalletUsd),
    }] : [];
    await fetch(editingGroup ? `/api/user-groups/${editingGroup.id}` : '/api/user-groups', {
      method: editingGroup ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingGroup ? {
        name: groupForm.name,
        botLimit: Number(groupForm.botLimit),
        addUserIds: existingUserIds,
      } : {
        name: groupForm.name,
        botLimit: Number(groupForm.botLimit),
        existingUserIds,
        newUsers,
      }),
    });
    setShowGroupModal(false);
    setEditingGroup(null);
    setGroupForm({ name: '', botLimit: '1', existingUserId: '', newUsername: '', newWalletAddress: '', newDuration: '1month', newMaxWalletUsd: '10000' });
    setFormBusy(false);
    void loadUsers();
  }

  function openEditUser(user: User) {
    setEditingUser(user);
    setForm({
      username: user.username,
      walletAddress: user.wallet_address,
      duration: user.duration ?? '1month',
      maxWalletUsd: String(user.max_wallet_usd ?? 10000),
      groupId: user.group_id ?? '',
    });
    setShowModal(true);
  }

  function openGroupModal(group?: UserGroup) {
    setEditingGroup(group ?? null);
    setGroupForm({
      name: group?.name ?? '',
      botLimit: String(group?.bot_limit ?? 1),
      existingUserId: '',
      newUsername: '',
      newWalletAddress: '',
      newDuration: '1month',
      newMaxWalletUsd: '10000',
    });
    setShowGroupModal(true);
  }

  async function handleAssignLicense(id: string) {
    setAssigning(id);
    await fetch(`/api/users/${id}/assign-license`, { method: 'POST' });
    setAssigning(null);
    void loadUsers();
  }

  async function handleCreateManager(e: React.FormEvent) {
    e.preventDefault();
    if (!managerForm.name.trim()) return;
    setManagerBusy(true);
    await fetch('/api/managers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: managerForm.name.trim(), duration: managerForm.duration }),
    });
    setShowManagerModal(false);
    setManagerForm({ name: '', duration: '1month' });
    setManagerBusy(false);
    void loadUsers();
  }

  async function handleAssignManagerLicense(id: string) {
    setManagerAssigning(id);
    await fetch(`/api/managers/${id}/assign-license`, { method: 'POST' });
    setManagerAssigning(null);
    void loadUsers();
  }

  async function handleToggleManagerAccess(id: string, current: boolean) {
    setManagerToggling(id);
    await fetch(`/api/managers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessEnabled: !current }),
    });
    setManagerToggling(null);
    void loadUsers();
  }

  async function handleDeleteManager(id: string) {
    if (!confirm('Remove this manager? Their groups will be unbound. This cannot be undone.')) return;
    await fetch(`/api/managers/${id}`, { method: 'DELETE' });
    void loadUsers();
  }

  async function handleBindGroupToManager(groupId: string, managerId: string) {
    if (managerId) {
      await fetch(`/api/managers/${managerId}/assign-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupIds: [groupId] }),
      });
    } else {
      await fetch('/api/managers/unassign-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupIds: [groupId] }),
      });
    }
    void loadUsers();
  }

  async function handleToggleAccess(id: string, current: boolean) {
    setToggling(id);
    await fetch(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessEnabled: !current }),
    });
    setToggling(null);
    void loadUsers();
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this user? This cannot be undone.')) return;
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    void loadUsers();
  }

  function handleBgUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBgImage(URL.createObjectURL(file));
  }

  if (!gateUnlocked) {
    return <IntroGate storageKey={ADMIN_GATE_STORAGE_KEY} onUnlock={handleGateUnlock} />;
  }

  return (
    <div
      className="min-h-screen bg-gray-950 text-gray-100"
      style={bgImage ? { backgroundImage: `url(${bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}}
    >
      {/* ── Header ── */}
      <header className="backdrop-blur-sm bg-gray-950/80 border-b border-gray-800 px-8 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <h1 className="text-lg font-semibold tracking-wide text-white">RogueZero Admin</h1>
          <p className="text-xs text-gray-500">License &amp; Access Control</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => fileRef.current?.click()}
            className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700 hover:border-gray-500 px-3 py-1.5 rounded-md transition-colors"
          >
            Set Background
          </button>
          {bgImage && (
            <button
              onClick={() => setBgImage(null)}
              className="text-xs text-gray-600 hover:text-red-400 transition-colors"
            >
              Clear BG
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleBgUpload} />
          <button
            onClick={() => setShowModal(true)}
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            + Add User
          </button>
          <button
            onClick={() => openGroupModal()}
            className="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            + Add to Group
          </button>
        </div>
      </header>

      {/* ── Tab Nav ── */}
      <nav className="backdrop-blur-sm bg-gray-950/60 border-b border-gray-800 px-8">
        <div className="flex gap-1">
          {([
            { id: 'overview',    label: 'Overview' },
            { id: 'users',       label: 'Users' },
            { id: 'user-groups', label: 'Groups' },
            { id: 'managers',    label: 'Managers' },
            { id: 'session-health', label: 'Session Health' },
            { id: 'token-universe', label: 'Token Universe' },
            { id: 'rate-limits', label: 'Rate Limits' },
          ] as { id: Tab; label: string }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={[
                'px-4 py-3 text-sm font-medium border-b-2 transition-colors',
                tab === t.id
                  ? 'border-emerald-500 text-white'
                  : 'border-transparent text-gray-500 hover:text-gray-300',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {/* ── Main ── */}
      <main className="px-8 py-6">

        {/* Overview Tab */}
        {tab === 'overview' && (
          <div className="space-y-6">
            <RuntimeControlPanel
              control={runtimeControl}
              updating={runtimeControlUpdating || runtimeControlLoading}
              onSelect={updateRuntimeControl}
              onAuto={resumeRuntimeAuto}
              onToggleEntries={toggleRuntimeEntries}
            />

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatCard label="Total Users"      value={users.length} />
              <StatCard label="Licensed"         value={licensedUsersCount} sub="entitled users" />
              <StatCard label="Idle"             value={idleUsersCount} sub="not currently trading" />
              <StatCard label="Expiring Soon"    value={expiringSoonUsers.length} sub="within 30 days" />
            </div>

            {/* ── Bot Capacity ── */}
            <CapacityPanel
              active={runtimeControl?.liveSessions ?? activeSessions.size}
              capacity={runtimeControl?.concurrentCapacity ?? users.filter(u => u.access_enabled && !isExpired(u.expiry_date)).length}
              reserved={runtimeControl?.reservedSessions ?? activeSessions.size}
              traders={users.filter(u => activeSessions.has(u.id))}
            />

            {/* Expiring soon list */}
            {expiringSoonUsers.length > 0 && (
              <div className="bg-gray-900/70 border border-yellow-900/50 rounded-xl p-5">
                <h3 className="text-sm font-medium text-yellow-400 mb-3">Expiring within 30 days</h3>
                <div className="space-y-2">
                  {expiringSoonUsers.map(u => (
                    <div key={u.id} className="flex items-center justify-between text-sm">
                      <span className="text-white">{u.username}</span>
                      <span className="text-yellow-400 text-xs">{formatDate(u.expiry_date)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Users Tab */}
        {tab === 'users' && (
          <div>
            {loading ? (
              <div className="py-24 text-center text-gray-600 text-sm">Loading users…</div>
            ) : users.length === 0 ? (
              <div className="py-24 text-center text-gray-600 text-sm">
                No users yet — click <span className="text-emerald-500">+ Add User</span> to get started.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-4 mb-4">
                  <span className="text-xs text-gray-600">{users.length} users</span>
                  <span className="text-xs text-emerald-500 font-medium">{licensedUsersCount} licensed</span>
                  <span className="text-xs text-gray-700">{idleUsersCount} idle</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {users.map((u) => (
                    <UserCard
                      key={u.id}
                      user={u}
                      isLive={activeSessions.has(u.id)}
                      onToggle={handleToggleAccess}
                      onAssign={handleAssignLicense}
                      onEdit={openEditUser}
                      onDelete={handleDelete}
                      assigning={assigning}
                      toggling={toggling}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* User Groups Tab */}
        {tab === 'user-groups' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">User groups</p>
                <p className="text-xs text-gray-600 mt-0.5">Segment customers by group name and bot allocation.</p>
              </div>
              <button
                onClick={() => openGroupModal()}
                className="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                + Add to Group
              </button>
            </div>
            {groups.length === 0 ? (
              <div className="py-20 text-center text-gray-600 text-sm">No groups yet — create one to organize users.</div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                {groups.map(group => {
                  const members = users.filter(u => u.group_id === group.id);
                  return (
                    <div key={group.id} className="bg-gray-900/80 border border-gray-800 rounded-xl p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-white font-semibold">{group.name}</h3>
                          <p className="text-xs text-gray-600 mt-1">{group.member_count} users · {group.bot_limit} bots allocated</p>
                        </div>
                        <button
                          onClick={() => openGroupModal(group)}
                          className="text-xs border border-gray-700 hover:border-violet-400 text-gray-400 hover:text-violet-200 px-3 py-1.5 rounded-md transition-colors"
                        >
                          Edit
                        </button>
                      </div>
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wider text-gray-600">Manager</span>
                        <select
                          value={group.manager_id ?? ''}
                          onChange={(e) => void handleBindGroupToManager(group.id, e.target.value)}
                          className="flex-1 bg-gray-950 border border-gray-800 text-xs text-white rounded-md px-2 py-1.5 outline-none focus:border-cyan-400/40"
                        >
                          <option value="">— unassigned —</option>
                          {managers.map((m) => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="mt-4 space-y-2">
                        {members.length === 0 ? (
                          <p className="text-xs text-gray-700 italic">No users assigned yet.</p>
                        ) : members.map(member => (
                          <div key={member.id} className="flex items-center justify-between rounded-lg bg-gray-950/60 border border-gray-800/70 px-3 py-2">
                            <div>
                              <p className="text-sm text-white">{member.username}</p>
                              <p className="text-[10px] text-gray-600 font-mono">{shortWallet(member.wallet_address)}</p>
                            </div>
                            <span className={member.access_enabled && !isExpired(member.expiry_date) ? 'text-[10px] text-emerald-400' : 'text-[10px] text-gray-600'}>
                              {member.access_enabled && !isExpired(member.expiry_date) ? 'licensed' : 'idle'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Managers Tab */}
        {tab === 'managers' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">Access managers</p>
                <p className="text-xs text-gray-600 mt-0.5">A manager holds one management key that unlocks every bot across all groups assigned to them.</p>
              </div>
              <button
                onClick={() => setShowManagerModal(true)}
                className="bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                + Add Manager
              </button>
            </div>
            {managers.length === 0 ? (
              <div className="py-20 text-center text-gray-600 text-sm">No managers yet — create one to delegate multi-bot control.</div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                {managers.map((m) => {
                  const boundGroups = groups.filter((g) => g.manager_id === m.id);
                  const expired = isExpired(m.expiry_date);
                  return (
                    <div key={m.id} className="bg-gray-900/80 border border-gray-800 rounded-xl p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-white font-semibold">{m.name}</h3>
                          <p className="text-xs text-gray-600 mt-1">{m.group_count} groups · {m.duration ?? '—'}</p>
                        </div>
                        <span className={m.access_enabled && !expired ? 'text-[10px] text-emerald-400' : 'text-[10px] text-gray-600'}>
                          {m.access_enabled && !expired ? 'active' : expired ? 'expired' : 'disabled'}
                        </span>
                      </div>

                      <div className="mt-3">
                        {m.management_key ? (
                          <div className="flex items-center gap-2 rounded-lg bg-gray-950/70 border border-gray-800 px-3 py-2">
                            <span className="font-mono text-[10px] text-cyan-200 flex-1 min-w-0 truncate">{m.management_key}</span>
                            <button
                              onClick={() => m.management_key && void navigator.clipboard.writeText(m.management_key)}
                              className="shrink-0 text-[9px] text-gray-600 hover:text-emerald-400 transition-colors"
                            >
                              copy
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => void handleAssignManagerLicense(m.id)}
                            disabled={managerAssigning === m.id}
                            className="w-full text-xs border border-cyan-700 hover:border-cyan-400 text-cyan-300 hover:text-cyan-100 px-3 py-2 rounded-md transition-colors disabled:opacity-40"
                          >
                            {managerAssigning === m.id ? 'generating…' : 'Generate management key'}
                          </button>
                        )}
                      </div>

                      <div className="mt-3 space-y-1">
                        {boundGroups.length === 0 ? (
                          <p className="text-xs text-gray-700 italic">No groups bound. Assign groups from the Groups tab.</p>
                        ) : boundGroups.map((g) => (
                          <div key={g.id} className="flex items-center justify-between rounded-lg bg-gray-950/60 border border-gray-800/70 px-3 py-1.5">
                            <span className="text-xs text-white">{g.name}</span>
                            <span className="text-[10px] text-gray-600">{g.member_count} bots</span>
                          </div>
                        ))}
                      </div>

                      <div className="mt-4 flex items-center gap-2">
                        <button
                          onClick={() => void handleToggleManagerAccess(m.id, m.access_enabled)}
                          disabled={managerToggling === m.id}
                          className="flex-1 text-xs border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
                        >
                          {m.access_enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => void handleDeleteManager(m.id)}
                          className="text-xs border border-gray-800 hover:border-red-500 text-gray-600 hover:text-red-300 px-3 py-1.5 rounded-md transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Rate Limits Tab */}
        {tab === 'rate-limits' && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">API Health</p>
                <p className="text-xs text-gray-600 mt-0.5">Gauge = response stress. Green → yellow → red as latency rises.</p>
              </div>
              <button
                onClick={() => void fetchRateLimits()}
                disabled={rlLoading}
                className="text-xs border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
              >
                {rlLoading ? 'Testing…' : '↻ Refresh'}
              </button>
            </div>

            {rlLoading && !rlData ? (
              <div className="py-16 text-center text-gray-600 text-sm">Running connection tests…</div>
            ) : (
              <>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                {/* ─ Helius ─ */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <p className="text-sm font-semibold text-white">Helius</p>
                      <p className="text-[10px] text-gray-600">Solana RPC · target {heliusFleetRps} rps (cap {heliusProviderRps} rps)</p>
                    </div>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${rlData?.helius?.connected ? 'bg-emerald-500' : rlData ? 'bg-red-500' : 'bg-gray-700'}`} />
                  </div>
                  <div className="flex justify-center mb-2">
                    <div className="w-40">
                      <SpeedGauge
                        value={rlData?.helius?.latencyMs ?? null}
                        max={500}
                        centerLabel={`${rlData?.helius?.latencyMs}ms`}
                        limitLabel={`${heliusFleetRps} rps target · ${heliusFleetDas} DAS`}
                        ok={rlData?.helius ? (rlData.helius.connected ?? null) : null}
                      />
                    </div>
                  </div>
                  {rlData?.helius?.error && <p className="text-xs text-red-400 mb-2">{String(rlData.helius.error)}</p>}
                  <div className="space-y-1.5 border-t border-gray-800 pt-3">
                    {rlData?.helius?.blockHeight != null && <RlRow label="Block Height" value={Number(rlData.helius.blockHeight).toLocaleString()} />}
                    <RlRow label="sendTransaction target" value={`${heliusSenderTps} / sec`} />
                    <RlRow label="Provider cap (RPC / DAS)" value={`${heliusProviderRps} / ${heliusProviderDas}`} />
                    <RlRow label="Monthly Credits" value={Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(heliusMonthlyCredits)} />
                  </div>
                </div>

                {/* ─ Jupiter ─ */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <p className="text-sm font-semibold text-white">Jupiter</p>
                      <p className="text-[10px] text-gray-600">Swap API v2 · target {jupiterFleetRps} rps (cap {jupiterProviderRps} rps)</p>
                    </div>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${rlData?.jupiter?.connected ? 'bg-emerald-500' : rlData ? 'bg-red-500' : 'bg-gray-700'}`} />
                  </div>
                  <div className="flex justify-center mb-2">
                    <div className="w-40">
                      <SpeedGauge
                        value={rlData?.jupiter?.latencyMs ?? null}
                        max={1000}
                        centerLabel={`${rlData?.jupiter?.latencyMs}ms`}
                        limitLabel={`${jupiterFleetRps} rps target · ${jupiterProviderRps} cap`}
                        ok={rlData?.jupiter ? (rlData.jupiter.connected ?? null) : null}
                      />
                    </div>
                  </div>
                  {rlData?.jupiter?.error && <p className="text-xs text-red-400 mb-2">{String(rlData.jupiter.error)}</p>}
                  <div className="space-y-1.5 border-t border-gray-800 pt-3">
                    {rlData?.jupiter?.outUsdc        != null && <RlRow label="SOL→USDC (0.001)" value={`${rlData.jupiter.outUsdc} USDC`} />}
                    {rlData?.jupiter?.priceImpactPct != null && <RlRow label="Price Impact"    value={`${rlData.jupiter.priceImpactPct}%`} />}
                    {rlData?.jupiter?.router         != null && <RlRow label="Router"          value={String(rlData.jupiter.router)} />}
                    <RlRow label="/execute cap" value={`${jupiterExecuteRps} RPS`} />
                    <RlRow label="Monthly Budget" value={Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(jupiterMonthlyBudget)} />
                  </div>
                </div>

                {/* ─ TigerData ─ */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <p className="text-sm font-semibold text-white">TigerData</p>
                      <p className="text-[10px] text-gray-600">TimescaleDB · connections</p>
                    </div>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${rlData?.tigerdata?.connected ? 'bg-emerald-500' : rlData ? 'bg-red-500' : 'bg-gray-700'}`} />
                  </div>
                  <div className="flex justify-center mb-2">
                    <div className="w-40">
                      <SpeedGauge
                        value={rlData?.tigerdata?.activeConnections ?? null}
                        max={rlData?.tigerdata?.maxConnections ?? 100}
                        centerLabel={rlData?.tigerdata ? `${rlData.tigerdata.activeConnections}/${rlData.tigerdata.maxConnections}` : '—'}
                        limitLabel="pool connections"
                        ok={rlData?.tigerdata ? (rlData.tigerdata.connected ?? null) : null}
                      />
                    </div>
                  </div>
                  {rlData?.tigerdata?.error && <p className="text-xs text-red-400 mb-2">{String(rlData.tigerdata.error)}</p>}
                  <div className="space-y-1.5 border-t border-gray-800 pt-3">
                    <RlRow label="Latency"      value={rlData?.tigerdata ? `${rlData.tigerdata.latencyMs ?? '—'} ms` : '—'} warn={(rlData?.tigerdata?.latencyMs ?? 0) > 300} />
                    <RlRow label="DB Size"      value={rlData?.tigerdata ? String(rlData.tigerdata.dbSize ?? '—') : '—'} />
                    <RlRow label="Pool idle"    value={rlData?.tigerdata ? `${rlData.tigerdata.pool?.idle ?? '—'} / ${rlData.tigerdata.pool?.total ?? '—'}` : '—'} />
                    {Array.isArray(rlData?.tigerdata?.tables) && (rlData.tigerdata.tables as { name: string; rows: number }[]).map(t => (
                      <RlRow key={t.name} label={t.name} value={`${t.rows.toLocaleString()} rows`} />
                    ))}
                  </div>
                </div>

              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <BudgetPressureCard title="Helius Monthly Credits" budget={rlData?.providerBudgets?.budgets?.['helius-credits']} />
                <BudgetPressureCard title="Jupiter Monthly Requests" budget={rlData?.providerBudgets?.budgets?.['jupiter-requests']} />
              </div>
              </>
            )}
          </div>
        )}

        {/* Session Health Tab */}
        {tab === 'session-health' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">Session Health</p>
                <p className="text-xs text-gray-600 mt-0.5">Aggregate lifecycle visibility for stalled trading, slow stop/return flow, and sessions waiting on funding.</p>
              </div>
              <button
                onClick={() => void fetchSessionHealth()}
                disabled={sessionHealthLoading}
                className="text-xs border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
              >
                {sessionHealthLoading ? 'Refreshing…' : '↻ Refresh'}
              </button>
            </div>

            {sessionHealthLoading && !sessionHealth ? (
              <div className="py-16 text-center text-gray-600 text-sm">Loading session health…</div>
            ) : sessionHealth && (
              <>
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-6">
                  <StatCard label="Trading Users" value={sessionHealth.summary.liveUsers} sub="active or starting" />
                  <StatCard label="Active Sessions" value={sessionHealth.summary.activeSessions} sub="currently trading" />
                  <StatCard label="Ready / Starting" value={sessionHealth.summary.readyOrStartingSessions} sub="queued to run" />
                  <StatCard label="Stopping" value={sessionHealth.summary.stoppingSessions} sub="return flow pending" />
                  <StatCard label="Needs Attention" value={sessionHealth.summary.attentionCount} sub="stale active + stopping + errors" />
                  <StatCard label="Total Sessions" value={sessionHealth.summary.totalSessions} sub={new Date(sessionHealth.generatedAt).toLocaleTimeString('en-US')} />
                </div>

                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Execution Queue</p>
                      <p className="text-xs text-gray-600 mt-0.5">Durable worker queue pressure for throttled 350-bot execution claims.</p>
                    </div>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] ${sessionHealth.executionQueue.staleRunning > 0 ? 'border-red-900/60 bg-red-950/30 text-red-300' : sessionHealth.executionQueue.claimable > 25 ? 'border-yellow-900/60 bg-yellow-950/20 text-yellow-300' : 'border-emerald-900/40 bg-emerald-950/15 text-emerald-300'}`}>
                      {sessionHealth.executionQueue.staleRunning > 0 ? 'stale locks' : sessionHealth.executionQueue.claimable > 25 ? 'backlog' : 'normal'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                    <StatCard label="Total Items" value={sessionHealth.executionQueue.total} sub="queued + running" />
                    <StatCard label="Queued" value={sessionHealth.executionQueue.queued} sub="waiting for claim" />
                    <StatCard label="Claimable" value={sessionHealth.executionQueue.claimable} sub="ready now" />
                    <StatCard label="Running" value={sessionHealth.executionQueue.running} sub="worker locked" />
                    <StatCard label="Stale Locks" value={sessionHealth.executionQueue.staleRunning} sub="will be reclaimed" />
                    <StatCard label="Oldest Queue" value={sessionHealth.executionQueue.oldestQueuedAgeSeconds == null ? '—' : `${Math.floor(sessionHealth.executionQueue.oldestQueuedAgeSeconds)}s`} sub={sessionHealth.executionQueue.newestUpdatedAt ? `updated ${new Date(sessionHealth.executionQueue.newestUpdatedAt).toLocaleTimeString('en-US')}` : 'not initialized'} />
                  </div>
                  {sessionHealth.executionQueue.topReasons.length > 0 && (
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
                      {sessionHealth.executionQueue.topReasons.map((item) => (
                        <div key={`${item.status}:${item.reason}`} className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-[11px] font-medium text-gray-300">{item.reason}</p>
                            <span className="text-sm font-semibold text-white">{item.count}</span>
                          </div>
                          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-gray-600">{item.status}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <TradeDecisionPanel health={sessionHealth} />

                <RecentTradesTable trades={sessionHealth.recentTrades} />

                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-white">Status Breakdown</p>
                    <p className="text-xs text-gray-600 mt-0.5">No wallets shown here — just the lifecycle pressure points that matter operationally.</p>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
                    {Object.entries(sessionHealth.countsByStatus).map(([status, count]) => (
                      <div key={status} className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-3">
                        <p className="text-[10px] uppercase tracking-wider text-gray-600">{status.replace(/_/g, ' ')}</p>
                        <p className="text-2xl font-semibold text-white mt-1">{count}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Launch Risk Proof</p>
                      <p className="text-xs text-gray-600 mt-0.5">Confirms the dynamic circuit breakers and fill-quality audit are visible before starting a frontend session.</p>
                    </div>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] ${sessionHealth.riskProof.recentBadFills > 0 || sessionHealth.riskProof.badFillStreakSessions > 0 || sessionHealth.riskProof.consecutiveLossSessions > 0 ? 'border-yellow-900/60 bg-yellow-950/20 text-yellow-300' : 'border-emerald-900/40 bg-emerald-950/15 text-emerald-300'}`}>
                      {sessionHealth.riskProof.recentBadFills > 0 ? 'bad fills seen' : sessionHealth.riskProof.consecutiveLossSessions > 0 ? 'loss streaks seen' : 'risk clear'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                    <StatCard label="Daily Loss Sessions" value={sessionHealth.riskProof.dailyLossSessions} sub={`max ${formatSignedUsd(-sessionHealth.riskProof.maxDailyLossUsd)}`} />
                    <StatCard label="Loss Streaks" value={sessionHealth.riskProof.consecutiveLossSessions} sub={`max ${sessionHealth.riskProof.maxConsecutiveLosses}`} />
                    <StatCard label="Bad-Fill Streaks" value={sessionHealth.riskProof.badFillStreakSessions} sub={`max ${sessionHealth.riskProof.maxBadFillStreak}`} />
                    <StatCard label="Recent Bad Fills" value={sessionHealth.riskProof.recentBadFills} sub="from latest audits" />
                    <StatCard label="Audit Rows" value={sessionHealth.riskProof.recentAudits.length} sub="last execution audit" />
                    <StatCard label="Launch Gate" value={sessionHealth.summary.attentionCount === 0 && sessionHealth.executionQueue.staleRunning === 0 && sessionHealth.riskProof.recentBadFills === 0 ? 'PASS' : 'CHECK'} sub="admin proof view" />
                  </div>

                  {sessionHealth.riskProof.recentAudits.length === 0 ? (
                    <div className="rounded-lg border border-gray-800 bg-gray-950/70 px-4 py-4 text-xs text-gray-500">
                      No confirmed execution audit rows yet. After the next confirmed swap, this panel will show expected vs actual output and bad-fill status.
                    </div>
                  ) : (
                    <div className="max-h-72 overflow-auto rounded-lg border border-gray-800">
                      <table className="w-full text-[11px]">
                        <thead className="sticky top-0 z-10 bg-gray-950">
                          <tr className="border-b border-gray-800 text-left text-[10px] uppercase tracking-wider text-gray-600">
                            <th className="py-2 pr-3">User</th>
                            <th className="py-2 pr-3">Session</th>
                            <th className="py-2 pr-3">Direction</th>
                            <th className="py-2 pr-3">Fill Delta</th>
                            <th className="py-2 pr-3">Impact</th>
                            <th className="py-2 pr-3">Bad Fill</th>
                            <th className="py-2 pr-3">At</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sessionHealth.riskProof.recentAudits.map((audit) => (
                            <tr key={`${audit.sessionId}-${audit.at}`} className="border-b border-gray-800/50">
                              <td className="py-2 pr-3 font-medium text-white">{audit.username}</td>
                              <td className="py-2 pr-3 font-mono text-gray-400">{audit.sessionId.slice(0, 8)}</td>
                              <td className="py-2 pr-3 text-gray-300">{audit.direction.replace(/_/g, ' ')}</td>
                              <td className={`py-2 pr-3 ${audit.outputDeltaBps !== null && audit.outputDeltaBps < 0 ? 'text-yellow-300' : 'text-emerald-300'}`}>{audit.outputDeltaBps === null ? '—' : `${audit.outputDeltaBps} bps`}</td>
                              <td className="py-2 pr-3 text-gray-300">{audit.priceImpactBps === null ? '—' : `${audit.priceImpactBps} bps`}</td>
                              <td className={`py-2 pr-3 font-semibold ${audit.badFill ? 'text-red-300' : 'text-emerald-300'}`}>{audit.badFill ? 'YES' : 'no'}</td>
                              <td className="py-2 pr-3 text-gray-500">{formatDateTime(audit.at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <SizingTable snapshots={sessionHealth.recentSizing} />

                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Session Stop Control</p>
                      <p className="text-xs text-gray-600 mt-0.5">Compact per-session rows. Admin can only trigger maintenance stop.</p>
                    </div>
                    <button
                      onClick={() => void loadAdminSessions()}
                      disabled={adminSessionsLoading}
                      className="text-xs border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
                    >
                      {adminSessionsLoading ? 'Refreshing…' : '↻ Refresh'}
                    </button>
                  </div>

                  {adminSessions.length === 0 ? (
                    <div className="rounded-lg border border-emerald-900/30 bg-emerald-950/20 px-4 py-6 text-sm text-emerald-300">
                      No active or pending sessions to manage.
                    </div>
                  ) : (
                    <div className="max-h-155 overflow-auto rounded-lg border border-gray-800">
                      <table className="w-full text-[11px]">
                        <thead className="sticky top-0 z-10 bg-gray-950">
                          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-600 border-b border-gray-800">
                            <th className="py-2 pr-3">User</th>
                            <th className="py-2 pr-3">Session</th>
                            <th className="py-2 pr-3">Status</th>
                            <th className="py-2 pr-3">Health</th>
                            <th className="py-2 pr-3">Position</th>
                            <th className="py-2 pr-3">Balance</th>
                            <th className="py-2 pr-3">Started</th>
                            <th className="py-2 pr-3">Stop reason</th>
                            <th className="py-2 pr-3 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adminSessions.map((session) => {
                            const isStopping = session.status === 'stopping';
                            return (
                              <tr key={session.id} className="border-b border-gray-800/50">
                                <td className="py-2 pr-3 text-white font-medium">{session.username}</td>
                                <td className="py-2 pr-3 font-mono text-gray-400">{session.id.slice(0, 8)}</td>
                                <td className="py-2 pr-3 text-gray-300">{session.status.replace(/_/g, ' ')}</td>
                                <td className="py-2 pr-3 text-gray-300">{getAdminSessionHealthLabel(session)}</td>
                                <td className="py-2 pr-3 text-gray-300">{getAdminSessionPositionLabel(session)}</td>
                                <td className="py-2 pr-3 text-gray-300">{lamportsToSolString(getAdminSessionBalanceLamports(session))}</td>
                                <td className="py-2 pr-3 text-gray-500">{formatDateTime(session.started_at)}</td>
                                <td className="py-2 pr-3 text-gray-500">{session.stop_reason ? session.stop_reason.replace(/_/g, ' ') : '—'}</td>
                                <td className="py-2 pr-3 text-right">
                                  <button
                                    onClick={() => void handleForceStopSession(session.id)}
                                    disabled={isStopping || forceStoppingSessionId === session.id}
                                    className="rounded-md border border-red-700/50 bg-red-950/40 px-2.5 py-1 text-[10px] text-red-200 transition hover:bg-red-900/50 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    {forceStoppingSessionId === session.id ? 'Stopping…' : isStopping ? 'Stopping' : 'Force Stop'}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <SessionIssuePanel
                    title="Stale Active Sessions"
                    subtitle={`No trade submit seen for ${sessionHealth.thresholds.activeStaleMinutes}+ minutes while status is active.`}
                    issues={sessionHealth.issues.staleActive}
                    emptyLabel="No stale active sessions. The bot gremlins are behaving."
                  />
                  <SessionIssuePanel
                    title="Slow Stop / Return Flow"
                    subtitle={`Sessions still in stopping after ${sessionHealth.thresholds.stoppingStaleMinutes}+ minutes.`}
                    issues={sessionHealth.issues.stopping}
                    emptyLabel="No stop-flow backlog. Funds are not visibly lingering in limbo here."
                  />
                  <SessionIssuePanel
                    title="Error Sessions"
                    subtitle="Sessions that landed in explicit error state and need investigation."
                    issues={sessionHealth.issues.errors}
                    emptyLabel="No sessions are currently in error state."
                  />
                  <SessionIssuePanel
                    title="Awaiting Funding"
                    subtitle={`Sessions waiting ${sessionHealth.thresholds.awaitingFundingWarnMinutes}+ minutes for user funding.`}
                    issues={sessionHealth.issues.awaitingFunding}
                    emptyLabel="No long-wait funding sessions right now."
                  />
                </div>
              </>
            )}
          </div>
        )}

        {/* Token Universe Tab */}
        {tab === 'token-universe' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">Token Universe</p>
                <p className="text-xs text-gray-600 mt-0.5">This controls what the bot is allowed to trade. Green/enabled means tradable; disabled rows are audit history only.</p>
              </div>
              <button
                onClick={() => void fetchTokenUniverse()}
                disabled={tokenUniverseLoading}
                className="text-xs border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
              >
                {tokenUniverseLoading ? 'Refreshing…' : '↻ Refresh'}
              </button>
            </div>

            {tokenUniverseLoading && !tokenUniverse ? (
              <div className="py-16 text-center text-gray-600 text-sm">Loading token universe…</div>
            ) : tokenUniverse && (
              <>
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
                  <StatCard label="Tradable Now" value={tokenUniverse.summary.enabledTokens} sub={`${tokenUniverse.summary.configuredTokens - tokenUniverse.summary.enabledTokens} disabled / audit only`} />
                  <StatCard label="Held Right Now" value={tokenUniverse.summary.activelyHeldTokens} sub="open session positions" />
                  <StatCard label="Used This Week" value={tokenUniverse.summary.tradedTokens7d} sub="tokens with trades" />
                  <StatCard label="Route-Approved" value={tokenUniverse.admission.summary.admitted} sub={`${tokenUniverse.admission.summary.rejected} route/safety rejected`} />
                  <StatCard label="Most Used" value={tokenUniverse.bestToken?.symbol ?? '—'} sub={tokenUniverse.bestToken ? `${tokenUniverse.bestToken.confirmedTradeCount7d} confirmed trades` : 'no confirmed trades'} />
                </div>

                <div className="rounded-xl border border-cyan-900/40 bg-cyan-950/10 p-4 text-xs text-cyan-100">
                  <p className="font-semibold text-cyan-200">How to read this tab</p>
                  <p className="mt-1 text-cyan-100/80">
                    The bot only trades rows marked <span className="font-semibold text-emerald-300">enabled</span>. A token must come from Jupiter Token API v2, pass RogueZero safety filters, and/or pass route checks before it should be enabled. Disabled tokens stay visible so we can audit what was rejected instead of hiding history.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-white">Where Tokens Come From</p>
                        <p className="text-xs text-gray-600 mt-0.5">Jupiter Token API v2 lists are filtered before anything becomes tradable.</p>
                      </div>
                      <span className={[
                        'rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em]',
                        tokenUniverse.autoSort.status === 'applied'
                          ? 'border-emerald-900/40 bg-emerald-950/15 text-emerald-300'
                          : tokenUniverse.autoSort.status === 'skipped'
                            ? 'border-yellow-900/40 bg-yellow-950/15 text-yellow-300'
                            : 'border-gray-800 bg-gray-950/60 text-gray-400',
                      ].join(' ')}>
                        {tokenUniverse.autoSort.status}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <SizingMetric label="database table" value={tokenUniverse.autoSort.sourceTable ?? 'rz_token_universe'} />
                      <SizingMetric label="last worker sort" value={formatDateTime(tokenUniverse.autoSort.lastRunAt)} />
                      <SizingMetric label="tokens checked" value={String(tokenUniverse.autoSort.candidateCount)} />
                      <SizingMetric label="worker enabled" value={String(tokenUniverse.autoSort.enabledCount)} />
                    </div>
                    {tokenUniverse.autoSort.reason && (
                      <p className="text-xs text-yellow-300">{tokenUniverse.autoSort.reason}</p>
                    )}
                  </div>

                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Safety + Route Checks</p>
                      <p className="text-xs text-gray-600 mt-0.5">Shows whether candidates passed safety filters and USDC route checks.</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <SizingMetric label="route rows checked" value={String(tokenUniverse.admission.summary.total)} />
                      <SizingMetric label="last checked" value={formatDateTime(tokenUniverse.admission.summary.latestObservedAt)} />
                      <SizingMetric label="currently disabled" value={String(tokenUniverse.summary.configuredTokens - tokenUniverse.summary.enabledTokens)} />
                      <SizingMetric label="needs recovery" value={String(tokenUniverse.deadletter.openCount)} />
                    </div>
                    {tokenUniverse.admission.candidates.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {tokenUniverse.admission.candidates.slice(0, 8).map((candidate) => (
                          <span
                            key={`${candidate.status}:${candidate.mint}`}
                            className={[
                              'rounded-full border px-2 py-1 text-[10px]',
                              candidate.status === 'admitted'
                                ? 'border-emerald-900/40 bg-emerald-950/15 text-emerald-300'
                                : 'border-red-900/40 bg-red-950/15 text-red-300',
                            ].join(' ')}
                          >
                            {candidate.symbol} · {candidate.status}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Currently Held</p>
                      <p className="text-xs text-gray-600 mt-0.5">Tokens sitting in active session wallets right now.</p>
                    </div>
                    {tokenUniverse.activeTokens.length === 0 ? (
                      <div className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-3 text-sm text-gray-500">
                        No active token exposure right now.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {tokenUniverse.activeTokens.slice(0, 8).map((token) => (
                          <div key={token.mint} className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2 text-xs">
                            <div>
                              <div className="font-medium text-white">{token.symbol}</div>
                              <div className="font-mono text-[10px] text-gray-500">{shortWallet(token.mint)}</div>
                            </div>
                            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-300">
                              {token.activeSessionCount} active
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-white">Tradable Tokens</p>
                      <p className="text-xs text-gray-600 mt-0.5">This is the actual bot universe. Disabled/rejected rows are hidden below as audit history.</p>
                    </div>
                    <p className="text-[11px] text-gray-500">updated {formatDateTime(tokenUniverse.generatedAt)}</p>
                  </div>

                  {tokenUniverse.tokens.length === 0 ? (
                    <div className="text-sm text-gray-500">No token universe rows found yet.</div>
                  ) : (
                    <div className="space-y-4">
                      {tokenUniverse.tokens.filter((token) => token.enabled).length === 0 ? (
                        <div className="rounded-lg border border-red-900/30 bg-red-950/20 px-4 py-4 text-sm text-red-300">
                          No tradable tokens are enabled. The worker should not enter new positions until this is fixed.
                        </div>
                      ) : (
                        <div className="max-h-96 overflow-auto rounded-lg border border-emerald-900/30">
                          <table className="w-full text-[11px]">
                            <thead className="sticky top-0 z-10 bg-gray-950">
                              <tr className="text-left text-[10px] uppercase tracking-wider text-gray-600 border-b border-gray-800">
                                <th className="py-2 pr-3">Token</th>
                                <th className="py-2 pr-3">Why allowed</th>
                                <th className="py-2 pr-3">Priority</th>
                                <th className="py-2 pr-3">Trades (7d)</th>
                                <th className="py-2 pr-3">Confirmed (7d)</th>
                                <th className="py-2 pr-3">Active</th>
                                <th className="py-2 pr-3">Last Traded</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tokenUniverse.tokens.filter((token) => token.enabled).map((token) => (
                                <tr key={token.mint} className="border-b border-gray-800/50">
                                  <td className="py-2 pr-3">
                                    <div className="text-white font-medium">{token.symbol}</div>
                                    <div className="text-[10px] text-gray-500 font-mono">{shortWallet(token.mint)}</div>
                                  </td>
                                  <td className="py-2 pr-3 text-emerald-300">
                                    {token.notes?.replace('admitted:', 'route-approved · ').replace('core-seed', 'core seed') ?? 'approved'}
                                  </td>
                                  <td className="py-2 pr-3 text-gray-300">{token.priority}</td>
                                  <td className="py-2 pr-3 text-gray-300">{token.tradeCount7d}</td>
                                  <td className="py-2 pr-3 text-gray-300">{token.confirmedTradeCount7d}</td>
                                  <td className="py-2 pr-3">
                                    <span className={token.currentlyActive ? 'text-emerald-300' : 'text-gray-500'}>{token.currentlyActive ? 'active' : '—'}</span>
                                  </td>
                                  <td className="py-2 pr-3 text-gray-500">{formatDateTime(token.lastTradedAt)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      <details className="rounded-lg border border-gray-800 bg-gray-950/50">
                        <summary className="cursor-pointer px-3 py-2 text-xs text-gray-400 hover:text-white">
                          Audit-only disabled/rejected rows ({tokenUniverse.tokens.filter((token) => !token.enabled).length})
                        </summary>
                        <div className="max-h-155 overflow-auto border-t border-gray-800">
                          <table className="w-full text-[11px]">
                            <thead className="sticky top-0 z-10 bg-gray-950">
                              <tr className="text-left text-[10px] uppercase tracking-wider text-gray-600 border-b border-gray-800">
                                <th className="py-2 pr-3">Token</th>
                                <th className="py-2 pr-3">Status</th>
                                <th className="py-2 pr-3">Priority</th>
                                <th className="py-2 pr-3">Reason / source</th>
                                <th className="py-2 pr-3">Trades (7d)</th>
                                <th className="py-2 pr-3">Last Traded</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tokenUniverse.tokens.filter((token) => !token.enabled).map((token) => (
                                <tr key={token.mint} className="border-b border-gray-800/50">
                                  <td className="py-2 pr-3">
                                    <div className="text-white font-medium">{token.symbol}</div>
                                    <div className="text-[10px] text-gray-500 font-mono">{shortWallet(token.mint)}</div>
                                  </td>
                                  <td className="py-2 pr-3 text-gray-500">audit only</td>
                                  <td className="py-2 pr-3 text-gray-300">{token.priority}</td>
                                  <td className="py-2 pr-3 text-gray-500">
                                    {token.notes?.replace('jupiter-token-api-v2:', 'Jupiter v2 · ') ?? 'disabled / legacy'}
                                  </td>
                                  <td className="py-2 pr-3 text-gray-300">{token.tradeCount7d}</td>
                                  <td className="py-2 pr-3 text-gray-500">{formatDateTime(token.lastTradedAt)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {/* ── Add/Edit User Modal ── */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-7 w-full max-w-md shadow-2xl">
            <h2 className="text-base font-semibold text-white mb-5">{editingUser ? 'Edit User' : 'Add New User'}</h2>
            <form onSubmit={(e) => void handleCreateUser(e)} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Username</label>
                <input
                  type="text"
                  required
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  placeholder="e.g. trader_alpha"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Wallet Address</label>
                <input
                  type="text"
                  required
                  value={form.walletAddress}
                  onChange={e => setForm(f => ({ ...f, walletAddress: e.target.value }))}
                  placeholder="Solana wallet address"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">License Duration</label>
                <div className="grid grid-cols-3 gap-2">
                  {DURATIONS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, duration: opt.value }))}
                      className={[
                        'py-2 rounded-lg text-sm font-medium border transition-colors',
                        form.duration === opt.value
                          ? 'bg-emerald-600 border-emerald-500 text-white'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500',
                      ].join(' ')}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Max Wallet USD</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={form.maxWalletUsd}
                  onChange={e => setForm(f => ({ ...f, maxWalletUsd: e.target.value }))}
                  placeholder="10000"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">User Group</label>
                <select
                  value={form.groupId}
                  onChange={e => setForm(f => ({ ...f, groupId: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500 transition-colors"
                >
                  <option value="">No group</option>
                  {groups.map(group => (
                    <option key={group.id} value={group.id}>{group.name} · {group.bot_limit} bots</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowModal(false); setEditingUser(null); }}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formBusy}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
                >
                  {formBusy ? 'Saving…' : editingUser ? 'Save User' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Add/Edit Group Modal ── */}
      {showGroupModal && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowGroupModal(false); }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-7 w-full max-w-lg shadow-2xl">
            <h2 className="text-base font-semibold text-white mb-5">{editingGroup ? 'Edit Group' : 'Add to Group'}</h2>
            <form onSubmit={(e) => void handleCreateOrUpdateGroup(e)} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Group Name</label>
                  <input
                    type="text"
                    required
                    value={groupForm.name}
                    onChange={e => setGroupForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Alpha Cohort"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Number of Bots</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={groupForm.botLimit}
                    onChange={e => setGroupForm(f => ({ ...f, botLimit: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Add Existing User</label>
                <select
                  value={groupForm.existingUserId}
                  onChange={e => setGroupForm(f => ({ ...f, existingUserId: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500 transition-colors"
                >
                  <option value="">Choose a user...</option>
                  {users.filter(u => !editingGroup || u.group_id !== editingGroup.id).map(user => (
                    <option key={user.id} value={user.id}>{user.username} {user.group_name ? `(currently ${user.group_name})` : ''}</option>
                  ))}
                </select>
              </div>
              {!editingGroup && (
                <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 space-y-3">
                  <p className="text-xs text-gray-500">Or create a new user directly inside this group.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={groupForm.newUsername}
                      onChange={e => setGroupForm(f => ({ ...f, newUsername: e.target.value }))}
                      placeholder="Username"
                      className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors"
                    />
                    <input
                      type="text"
                      value={groupForm.newWalletAddress}
                      onChange={e => setGroupForm(f => ({ ...f, newWalletAddress: e.target.value }))}
                      placeholder="Wallet address"
                      className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors font-mono"
                    />
                    <select
                      value={groupForm.newDuration}
                      onChange={e => setGroupForm(f => ({ ...f, newDuration: e.target.value }))}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500 transition-colors"
                    >
                      {DURATIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={groupForm.newMaxWalletUsd}
                      onChange={e => setGroupForm(f => ({ ...f, newMaxWalletUsd: e.target.value }))}
                      placeholder="Max wallet USD"
                      className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors"
                    />
                  </div>
                </div>
              )}
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowGroupModal(false); setEditingGroup(null); }}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formBusy}
                  className="flex-1 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
                >
                  {formBusy ? 'Saving…' : editingGroup ? 'Save Group' : 'Create Group'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showManagerModal && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowManagerModal(false); }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-7 w-full max-w-md shadow-2xl">
            <h2 className="text-base font-semibold text-white mb-1">Add Manager</h2>
            <p className="text-xs text-gray-600 mb-5">Create an access manager, then generate their management key and bind groups from the Groups tab.</p>
            <form onSubmit={(e) => void handleCreateManager(e)} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Manager Name</label>
                <input
                  type="text"
                  required
                  value={managerForm.name}
                  onChange={e => setManagerForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Desk Lead — East"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Key Duration</label>
                <select
                  value={managerForm.duration}
                  onChange={e => setManagerForm(f => ({ ...f, duration: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors"
                >
                  {DURATIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setShowManagerModal(false)}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={managerBusy}
                  className="flex-1 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
                >
                  {managerBusy ? 'Creating…' : 'Create Manager'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
