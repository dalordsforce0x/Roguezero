// build: 20260530093932
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Transaction } from '@solana/web3.js';

// ── Auth types ────────────────────────────────────────────────────────────────

type AuthState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'checking' }
  | { status: 'unauthorized'; reason: 'not_registered' | 'access_disabled' | 'license_expired' | 'service_unavailable'; username?: string; expiryDate?: string }
  | { status: 'authorized'; user: AuthUser };

type AuthUser = {
  id: string;
  username: string;
  walletAddress: string;
  expiryDate: string | null;
  maxWalletUsd?: number | null;
  duration: string | null;
  gatedAccessEnrolledAt?: string | null;
  licenseKeyRevealedAt?: string | null;
};

const isUnauthorizedReason = (
  value: string | undefined,
): value is Extract<AuthState, { status: 'unauthorized' }>['reason'] =>
  value === 'not_registered' || value === 'access_disabled' || value === 'license_expired' || value === 'service_unavailable';

type UnauthorizedApiResponse = {
  authorized?: boolean;
  reason?: string;
  error?: string;
  user?: {
    id?: string;
    username?: string;
    walletAddress?: string;
    expiryDate?: string | null;
    maxWalletUsd?: number | null;
    duration?: string | null;
    gatedAccessEnrolledAt?: string | null;
    licenseKeyRevealedAt?: string | null;
  };
};

type AccessGateState = 'checking' | 'temporary_required' | 'temporary_unlocked' | 'license_required' | 'access_granted';

type AccessBootPayload = {
  state?: AccessGateState;
  source?: 'trusted_device' | 'license_key' | 'live_session_bypass' | null;
  trustedUntil?: string | null;
  liveSessionCount?: number;
  userId?: string | null;
  error?: string;
};

type AccessEnrollPayload = {
  ok?: boolean;
  user?: AuthUser;
  firstReveal?: boolean;
  licenseKey?: string | null;
  liveSessionCount?: number;
  trustedUntil?: string;
  error?: string;
  details?: string;
};

// ── Types ─────────────────────────────────────────────────────────────────────

type SessionStatus =
  | 'awaiting_funding' | 'ready' | 'starting' | 'active'
  | 'paused' | 'stopping' | 'stopped' | 'settling' | 'error';

type SessionPositionState = {
  status: 'flat' | 'long' | 'long_sol';
  positionMint?: string | null;
  positionSymbol?: string | null;
  entryStrategy?: string | null;
  entryPriceUsd: number | null;
  entryAt: string | null;
  quantityAtomic: string | null;
  highWaterPriceUsd: number | null;
  lastMarkedPriceUsd: number | null;
  lastMarkedAt: string | null;
  pendingExitReason: string | null;
  exitReason: string | null;
};

type SessionPositionsState = {
  activePositionMint: string | null;
  positions: Record<string, SessionPositionState>;
};

type SessionSignal = {
  at: string;
  status: string;
  regime: string | null;
  momentumBps: number | null;
  guardReason: string | null;
  signal?: string | null;
  strategy?: string | null;
};

type SessionTradeGate = {
  at: string;
  decision: string;
  reason: string;
  expectedEdgeBps: number | null;
  estimatedCostBps: number | null;
  safetyBufferBps: number | null;
};

type SessionHealthState = {
  state: 'active_trading' | 'waiting_market' | 'blocked' | 'exit_blocked' | 'gas_danger' | 'recovery_required' | 'stopping' | 'stopped' | 'error';
  severity: 'info' | 'warn' | 'error';
  reason: string | null;
  detail: string | null;
  updatedAt: string;
  blockerCount: number;
};

type Session = {
  id: string;
  status: SessionStatus;
  sessionWallet: string;
  ownerWallet: string;
  userControl: {
    profitHandling?: {
      mode: 'send_to_owner' | 'compound';
      payoutToken: 'SOL' | 'USDC';
    };
  };
  funding: {
    fundingTokenSymbol: string;
    requestedFundingLamports: string;
    startingBalanceAtomic: string;
    currentBalanceAtomic: string;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    capturedFeesUsd: number;
  };
  riskLimits: {
    maxSessionLossUsd: number;
    maxDailyLossUsd: number;
  };
  serviceControl?: {
    positionsState?: SessionPositionsState;
    positionState?: SessionPositionState;
    lastSignal?: SessionSignal;
    lastTradeGate?: SessionTradeGate;
    healthState?: SessionHealthState;
    residualRecovery?: {
      state: string;
      sessionWallet: string;
      ownerWallet: string;
      solBalance: number;
      residualTokenAccounts: string[];
      detectedAt: string;
      note: string;
    };
    rotationState?: { activeStrategy: string };
    schedulingState?: {
      lastDecisionOutcome?: string | null;
      lastDecisionReason?: string | null;
      lastBlockedAt?: string | null;
      lastBlockedReason?: string | null;
      blockedReasonCounts?: Record<string, number>;
      lastProfitTransferAt?: string | null;
      transferredProfitUsd?: number | null;
    };
  };
  requestedAt: string;
  startedAt: string | null;
};

type CreateResponse = {
  session: Session;
  sessionWallet: string;
  fundingInstructions: {
    sendTo: string;
    minimumFundingLamports: number;
    minimumFundingSol: number;
    message: string;
  };
  error?: string;
};

type FundingQuoteResponse = {
  unsignedTransactionBase64?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  requestedLamports?: number;
  requestedUsd?: number;
  requestedFundingPct?: number | null;
  maxWalletUsd?: number;
  error?: string;
  details?: string;
};

type PerformanceSummary = {
  totalSessions: number;
  activeSessions: number;
  stoppedSessions: number;
  awaitingFundingSessions: number;
  readyOrStartingSessions: number;
  longSolSessions: number;
  totalExecutions: number;
  confirmedExecutions: number;
  submittedExecutions: number;
  preparedExecutions: number;
  failedExecutions: number;
  cancelledExecutions: number;
  totalRealizedPnlUsd: number;
  confirmedRealizedPnlUsd: number;
  confirmedRealizedPnlTodayUsd: number;
  historicalPnlStatus: 'confirmed' | 'legacy_untrusted';
  totalCapturedFeesUsd: number;
  firstSessionAt: string | null;
  lastSessionAt: string | null;
  lastExecutionAt: string | null;
};

type PerformanceTradeMetric = {
  tokenSymbol: string;
  pnlUsd: number;
  entryAt: string | null;
  exitAt: string;
  sessionId: string;
  sessionWallet: string;
  exitSignature: string | null;
};

type PerformanceTradeMetrics = {
  completedRoundTrips: number;
  dailyRealizedPnlUsd: number;
  historicRealizedPnlUsd: number;
  bestTrade: PerformanceTradeMetric | null;
  bestTradeToday: PerformanceTradeMetric | null;
  profitableTokens: Array<{
    tokenSymbol: string;
    realizedPnlUsd: number;
    trades: number;
  }>;
  pnlTimeline: Array<{
    date: string;
    pnlUsd: number;
    trades: number;
  }>;
};

type PerformanceSessionHistory = {
  sessionId: string;
  sessionWallet: string;
  status: string;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  stopReason: string | null;
  fundedAmountAtomic: string;
  confirmedExecutions: number;
  completedRoundTrips: number;
  confirmedRealizedPnlUsd: number;
  confirmedCapturedFeesUsd: number;
  lastConfirmedExecutionAt: string | null;
  bestTrade: PerformanceTradeMetric | null;
  latestTrade: PerformanceTradeMetric | null;
  completedTrades: PerformanceTradeMetric[];
};

type PerformanceActivityItem = {
  at: string;
  kind: string;
  sessionId: string;
  sessionWallet: string;
  status: string | null;
  executionId: string | null;
  signature: string | null;
  amount: string | null;
  reason?: string | null;
};

type PerformanceSessionInsight = {
  sessionId: string;
  status: string;
  sessionWallet: string;
  lastSignal: {
    at: string | null;
    status: string | null;
    regime: string | null;
    momentumBps: number | null;
    guardReason: string | null;
  };
  lastTradeGate: {
    at: string | null;
    decision: string | null;
    reason: string | null;
    expectedEdgeBps: number | null;
    estimatedCostBps: number | null;
    safetyBufferBps: number | null;
  };
};

type PerformanceResponse = {
  generatedAt: string;
  linkedBy: {
    userId: string | null;
    ownerWallet: string | null;
    licenseId: string | null;
  };
  summary: PerformanceSummary;
  tradeMetrics: PerformanceTradeMetrics;
  recentActivity: PerformanceActivityItem[];
  latestSessionInsights: PerformanceSessionInsight[];
  sessionHistory: PerformanceSessionHistory[];
};

const API = '/api/rz';

const DEFAULT_SESSION_REQUEST = {
  startingBalanceAtomic: '0',
  stopLossBehavior: 'stop' as const,
  riskLimits: {
    maxSessionLossUsd: 50,
    maxDailyLossUsd: 100,
    maxPositionSizeUsd: 1000,
    maxOpenPositions: 10,
    maxSlippageBps: 50,
    cooldownMs: 30000,
  },
};

const STATUS_COLORS: Record<SessionStatus, string> = {
  awaiting_funding: 'text-yellow-400 bg-yellow-900/30',
  ready:            'text-blue-400   bg-blue-900/30',
  starting:         'text-blue-300   bg-blue-900/30',
  active:           'text-emerald-400 bg-emerald-900/30',
  paused:           'text-orange-400 bg-orange-900/30',
  stopping:         'text-red-400    bg-red-900/30',
  stopped:          'text-gray-500   bg-gray-800/50',
  settling:         'text-purple-400 bg-purple-900/30',
  error:            'text-red-500    bg-red-900/40',
};

type PanelView = 'activity' | 'performance';
type DashboardView = 'overview' | 'historical';
type TopInfoSection = 'user' | 'wallet' | 'monitoring';
type SessionMarker = {
  title: string;
  detail: string;
  tone: 'neutral' | 'good' | 'warn';
};

type InfoRow = {
  label: string;
  value: string;
  href?: string;
  title?: string;
};

type GateProps = {
  mode: 'temporary' | 'license';
  onUnlock: (password: string) => Promise<void>;
};

const GATE_VIDEO_SRC = '/media/rz-gated-access-intro.mp4';
const IDLE_MULTI_BIRDS_VIDEO_SRC = '/media/rz-idle-multi-birds.mp4';
const IDLE_ROGUE_BIRD_VIDEO_SRC = '/media/rz-idle-rogue-bird.mp4';
const IDLE_WHITE_DOVE_VIDEO_SRC = '/media/rz-trading-bird.mp4';
const PROFIT_CELEBRATION_GIF_SRC = '/media/profit-made.gif';
const IDLE_BIRD_VIDEO_SOURCES = [
  {
    src: IDLE_MULTI_BIRDS_VIDEO_SRC,
    type: 'video/mp4',
    wrapperClassName: 'absolute inset-0 flex items-center justify-center overflow-hidden bg-black',
    className: 'h-full w-full scale-[1.12] translate-x-[4%] -translate-y-[8%] object-contain bg-black',
  },
  {
    src: IDLE_ROGUE_BIRD_VIDEO_SRC,
    type: 'video/mp4',
    wrapperClassName: 'absolute inset-0 flex items-end justify-center bg-black',
    className: 'w-full h-auto object-contain [filter:invert(1)_brightness(0.9)]',
  },
  {
    src: IDLE_WHITE_DOVE_VIDEO_SRC,
    type: 'video/mp4',
    wrapperClassName: 'absolute inset-0 flex items-center justify-center bg-black',
    className: 'h-[50%] w-[50%] object-contain [filter:invert(1)_brightness(0.85)]',
  },
] as const;
const TRADING_CUBE_VIDEO_SOURCES = [
  '/media/the-cube.mp4',
  '/media/the-cube-v2.mp4',
  '/media/the-cube-v3.mp4',
] as const;
const LICENSE_REVEAL_STORAGE_KEY = 'rz-pending-license-reveal';
const FUNDING_PRESET_PCTS = [25, 50, 95] as const;
const SESSION_PRIORITY: SessionStatus[] = [
  'active',
  'starting',
  'stopping',
  'settling',
  'paused',
  'ready',
  'awaiting_funding',
  'error',
  'stopped',
];

const formatDateTime = (value: string | null) => {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const formatFundingSol = (atomic: string) => {
  const numeric = Number(atomic);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0.000000 SOL';
  return `${(numeric / 1_000_000_000).toFixed(6)} SOL`;
};

const formatFundingRequirement = (value: number) => (
  Number.isFinite(value) && value > 0
    ? `${value.toFixed(6)} SOL`
    : 'loading live threshold'
);

const formatUsd = (value: number) => `${value > 0 ? '+' : value < 0 ? '-' : ''}$${Math.abs(value).toFixed(4)}`;
const formatMetricUsd = (value: number) => `${value > 0 ? '+' : value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;

const formatShortDate = (value: string | null) => {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

const formatExecutionAmountSol = (atomic: string | null) => {
  const numeric = Number(atomic ?? '0');
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  return `${(numeric / 1_000_000_000).toFixed(4)} SOL`;
};

const formatWalletShort = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

const formatDuration = (startedAt: string | null, endedAt: string | null) => {
  if (!startedAt) return '—';

  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';

  const totalMinutes = Math.max(0, Math.round((end - start) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

const formatActivityReason = (reason: string) =>
  reason
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());

const describeActivity = (item: PerformanceActivityItem) => {
  switch (item.kind) {
    case 'session_requested':
      return {
        title: 'Session requested',
        detail: `Session wallet ${item.sessionWallet.slice(0, 6)}…${item.sessionWallet.slice(-4)} is ready for funding.`,
      };
    case 'session_started':
      return {
        title: 'Session started',
        detail: `Session ${item.sessionWallet.slice(0, 6)}…${item.sessionWallet.slice(-4)} is live and scanning.`,
      };
    case 'session_ended':
      return {
        title: 'Session ended',
        detail: `Session ${item.sessionId.slice(0, 8)} closed (${item.status ?? 'unknown'}). Performance is ready.`,
      };
    case 'swap_confirmed':
      return {
        title: 'Swap confirmed',
        detail: `Confirmed ${formatExecutionAmountSol(item.amount)} from ${item.sessionWallet.slice(0, 6)}…${item.sessionWallet.slice(-4)}.`,
      };
    case 'swap_submitted':
      return {
        title: 'Swap submitted',
        detail: `Sent to chain${item.signature ? ` · ${item.signature.slice(0, 8)}…` : ''}. Waiting for confirmation.`,
      };
    case 'swap_prepared':
      return {
        title: 'Swap prepared',
        detail: `Prepared ${formatExecutionAmountSol(item.amount)} and queued for signing.`,
      };
    case 'swap_skipped':
      return {
        title: 'Trade skipped',
        detail: `No trade taken${item.reason ? ` · ${formatActivityReason(item.reason)}` : ''}. Gate declined entry; no funds moved.`,
      };
    default:
      return {
        title: 'Swap failed',
        detail: `Execution failed${item.executionId ? ` · ${item.executionId.slice(0, 8)}…` : ''}. Review details below.`,
      };
  }
};

const getLatestActivityItem = (activity: PerformanceActivityItem[]) => (
  [...activity].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())[0] ?? null
);

const getOpenSessionPositions = (session: Session | null): SessionPositionState[] => {
  if (!session) return [];

  const fromPositionsState = Object.values(session.serviceControl?.positionsState?.positions ?? {})
    .filter((position) => position.status === 'long' || position.status === 'long_sol');

  if (fromPositionsState.length > 0) {
    return fromPositionsState;
  }

  const legacyPosition = session.serviceControl?.positionState;
  if (legacyPosition?.status === 'long' || legacyPosition?.status === 'long_sol') {
    return [legacyPosition];
  }

  return [];
};

const formatOpenPositionLabel = (position: SessionPositionState) => (
  position.positionSymbol
  ?? (position.positionMint ? `${position.positionMint.slice(0, 4)}…${position.positionMint.slice(-4)}` : 'POSITION')
);

const formatPositionDetail = (position: SessionPositionState) => {
  const label = formatOpenPositionLabel(position);
  const qty = position.quantityAtomic ? `qty ${position.quantityAtomic}` : 'qty —';
  const entry = position.entryPriceUsd !== null ? `entry $${position.entryPriceUsd.toFixed(4)}` : 'entry —';
  const mark = position.lastMarkedPriceUsd !== null ? `mark $${position.lastMarkedPriceUsd.toFixed(4)}` : 'mark —';
  const strategy = position.entryStrategy ? `strategy ${position.entryStrategy.replace(/_/g, ' ')}` : 'strategy —';
  const pendingExit = position.pendingExitReason ? ` · pending ${position.pendingExitReason.replace(/_/g, ' ')}` : '';
  return `${label} · ${position.status} · ${strategy} · ${entry} · ${mark} · ${qty}${pendingExit}`;
};

const formatHealthLabel = (state: string) => state
  .split('_')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');

const getHealthTone = (health: SessionHealthState): SessionMarker['tone'] => (
  health.severity === 'error' ? 'warn' : health.severity === 'warn' ? 'warn' : 'neutral'
);

const pickNextRandomIndex = (length: number, currentIndex: number | null = null) => {
  if (length <= 1) {
    return 0;
  }

  let nextIndex = Math.floor(Math.random() * length);
  while (nextIndex === currentIndex) {
    nextIndex = Math.floor(Math.random() * length);
  }

  return nextIndex;
};

const getPhaseKeyword = (session: Session | null, activity: PerformanceActivityItem[]): string => {
  if (!session || session.status === 'stopped') return 'idle';
  const latestActivity = getLatestActivityItem(activity);
  switch (session.status) {
    case 'awaiting_funding': return 'waiting for deposit';
    case 'ready': return 'ready to start';
    case 'starting': return 'launching trader';
    case 'active':
      if (latestActivity?.kind === 'swap_submitted' || latestActivity?.kind === 'swap_prepared') return 'executing trade';
      if (getOpenSessionPositions(session).length > 0) return 'working';
      return 'scanning';
    case 'paused': return 'idle';
    case 'stopping':
    case 'settling': return 'recovering funds';
    case 'error': return 'idle';
    default: return 'idle';
  }
};

const buildSessionMarkers = (session: Session | null, minimumFundingSol: number): SessionMarker[] => {
  if (!session) {
    return [];
  }

  const liveBalanceSol = Number(session.funding.currentBalanceAtomic) / 1_000_000_000;
  const hasLiveBalance = Number.isFinite(liveBalanceSol) && liveBalanceSol > 0;
  const minimumFundingLabel = formatFundingRequirement(minimumFundingSol);

  const markers: SessionMarker[] = [
    { title: 'Session requested', detail: formatDateTime(session.requestedAt), tone: 'neutral' },
  ];

  if (session.startedAt) {
    markers.push({ title: 'Session started', detail: formatDateTime(session.startedAt), tone: 'good' });
  }

  if (session.status === 'awaiting_funding') {
    markers.push({
      title: hasLiveBalance ? 'Deposit detected' : 'Awaiting funding',
      detail: hasLiveBalance
        ? `Detected ${liveBalanceSol.toFixed(6)} SOL on-chain. Need ${minimumFundingLabel} before start unlocks.`
        : `No deposit detected on-chain yet. Send at least ${minimumFundingLabel} to the session wallet.`,
      tone: 'warn',
    });
    markers.push({
      title: 'Control',
      detail: 'You can stop this pending session anytime and create a fresh wallet.',
      tone: 'neutral',
    });
  }

  if (session.status === 'ready') {
    markers.push({ title: 'Ready to launch', detail: 'Funding detected on-chain. Press start to begin trading.', tone: 'good' });
  }

  if (session.status === 'starting' || session.status === 'active') {
    const pos = session.serviceControl?.positionState;
    const openPositions = getOpenSessionPositions(session);
    const sig = session.serviceControl?.lastSignal;
    const gate = session.serviceControl?.lastTradeGate;
    const health = session.serviceControl?.healthState;
    // Prefer the strategy that actually fired this cycle (lastSignal.strategy);
    // fall back to the rotation pointer, then the legacy default.
    const strategy = sig?.strategy
      ?? sig?.signal
      ?? session.serviceControl?.rotationState?.activeStrategy
      ?? 'momentum';

    // Position state
    if (openPositions.length > 0) {
      const preview = openPositions.slice(0, 2).map(formatOpenPositionLabel).join(', ');
      const extra = openPositions.length > 2 ? ` +${openPositions.length - 2} more` : '';
      markers.push({
        title: `Positions: ${openPositions.length} open`,
        detail: `${preview}${extra}`,
        tone: 'good',
      });
    } else if (pos) {
      const posLabel = pos.status === 'long_sol' ? 'LONG SOL' : 'FLAT (USDC)';
      const entryDetail = pos.status === 'long_sol' && pos.entryPriceUsd
        ? `entry $${pos.entryPriceUsd.toFixed(2)} · mark $${(pos.lastMarkedPriceUsd ?? 0).toFixed(2)}`
        : pos.status === 'flat' && pos.exitReason
          ? `last exit: ${pos.exitReason.replace(/_/g, ' ')}`
          : 'waiting for entry signal';
      markers.push({ title: `Position: ${posLabel}`, detail: entryDetail, tone: pos.status === 'long_sol' ? 'good' : 'neutral' });
    }

    // Signal
    if (sig) {
      const regimeLabel = sig.regime ?? 'warming up';
      const momLabel = sig.momentumBps !== null ? `${sig.momentumBps} bps` : 'n/a';
      const guardLabel = sig.guardReason ? ` · guard: ${sig.guardReason}` : '';
      markers.push({
        title: `Signal: ${regimeLabel}`,
        detail: `momentum ${momLabel}${guardLabel} · ${sig.status}`,
        tone: sig.regime === 'bullish' ? 'good' : sig.regime === 'bearish' ? 'warn' : 'neutral',
      });
    }

    // Gate
    if (gate) {
      const gateLabel = gate.decision === 'allowed' ? 'ALLOWED' : 'BLOCKED';
      const reasonLabel = gate.reason.replace(/_/g, ' ');
      markers.push({
        title: `Gate: ${gateLabel}`,
        detail: reasonLabel,
        tone: gate.decision === 'allowed' ? 'good' : 'neutral',
      });
    }

    if (health && health.state !== 'active_trading') {
      const reason = health.reason ? health.reason.replace(/_/g, ' ') : 'no reason recorded';
      const count = health.blockerCount > 0 ? ` · count ${health.blockerCount}` : '';
      markers.push({
        title: `Health: ${formatHealthLabel(health.state)}`,
        detail: `${reason}${count}${health.detail ? ` · ${health.detail}` : ''}`,
        tone: getHealthTone(health),
      });
    }

    // Strategy
    markers.push({
      title: `Strategy: ${String(strategy).replace(/_/g, ' ')}`,
      detail: sig?.strategy ? 'Strategy that triggered the latest signal.' : 'Current rotation strategy.',
      tone: 'neutral',
    });

    // PnL snapshot
    if (session.funding.realizedPnlUsd !== 0 || session.funding.capturedFeesUsd !== 0) {
      markers.push({
        title: 'Session PnL',
        detail: `realized ${formatUsd(session.funding.realizedPnlUsd)} · fees $${session.funding.capturedFeesUsd.toFixed(4)}`,
        tone: session.funding.realizedPnlUsd >= 0 ? 'good' : 'warn',
      });
    }
  }

  if (session.status === 'paused') {
    markers.push({ title: 'Paused', detail: 'Trading is paused. Resume when you are ready.', tone: 'warn' });
    const openPositions = getOpenSessionPositions(session);
    const pos = session.serviceControl?.positionState;
    if (openPositions.length > 0) {
      markers.push({
        title: `Positions: ${openPositions.length} open`,
        detail: openPositions.slice(0, 2).map(formatOpenPositionLabel).join(', '),
        tone: 'neutral',
      });
    } else if (pos) {
      markers.push({
        title: `Position: ${pos.status === 'long_sol' || pos.status === 'long' ? 'OPEN' : 'FLAT'}`,
        detail: pos.status === 'long_sol' || pos.status === 'long' ? `entry $${pos.entryPriceUsd?.toFixed(2) ?? '—'}` : 'no open position',
        tone: 'neutral',
      });
    }
  }

  if (session.status === 'stopping' || session.status === 'settling') {
    markers.push({ title: 'Stop requested', detail: 'Sweeping funds back to your owner wallet.', tone: 'warn' });
    if (session.funding.realizedPnlUsd !== 0) {
      markers.push({
        title: 'Final PnL',
        detail: `realized ${formatUsd(session.funding.realizedPnlUsd)} · fees $${session.funding.capturedFeesUsd.toFixed(4)}`,
        tone: session.funding.realizedPnlUsd >= 0 ? 'good' : 'warn',
      });
    }
  }

  if (session.status === 'stopped') {
    markers.push({ title: 'Stopped', detail: 'Session is closed. Performance summary is ready.', tone: 'good' });
    if (session.serviceControl?.residualRecovery) {
      markers.push({
        title: 'Recovery required',
        detail: `${session.serviceControl.residualRecovery.residualTokenAccounts.length} residual token account(s) required fee-sponsored recovery.`,
        tone: 'warn',
      });
    }
    if (session.funding.realizedPnlUsd !== 0) {
      markers.push({
        title: 'Session result',
        detail: `realized ${formatUsd(session.funding.realizedPnlUsd)} · fees $${session.funding.capturedFeesUsd.toFixed(4)}`,
        tone: session.funding.realizedPnlUsd >= 0 ? 'good' : 'warn',
      });
    }
  }

  if (session.status === 'error') {
    markers.push({ title: 'Session error', detail: 'Session hit an error and needs attention.', tone: 'warn' });
  }

  return markers;
};

function IntroGate({ mode, onUnlock }: GateProps) {
  const [phase, setPhase] = useState<'checking' | 'video' | 'password'>('video');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submitPassword = useCallback(async () => {
    try {
      setSubmitting(true);
      await onUnlock(password);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'wrong password');
    } finally {
      setSubmitting(false);
    }
  }, [onUnlock, password]);

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
              <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-300">access gate</div>
              <div className="mt-2 text-lg text-white">{mode === 'temporary' ? 'enter temporary password' : 'enter license key'}</div>
              <div className="mt-1 text-xs text-cyan-100/70">
                {mode === 'temporary'
                  ? 'first-time access on this device'
                  : 'trusted device access expired — use your own key'}
              </div>
              <input
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !submitting) {
                    void submitPassword();
                  }
                }}
                className="mt-4 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/40"
                placeholder={mode === 'temporary' ? 'temporary password' : 'license key'}
                autoFocus
              />
              {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
              <button
                type="button"
                onClick={() => void submitPassword()}
                disabled={submitting}
                className="mt-4 w-full rounded-lg border border-cyan-300/25 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100 transition hover:bg-cyan-500/18"
              >
                {submitting ? 'verifying…' : mode === 'temporary' ? 'unlock controller' : 'unlock with license'}
              </button>
            </div>
          </div>
        )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  'use no memo';
  const { connection } = useConnection();
  const { publicKey, disconnect, connecting, connected, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [auth, setAuth] = useState<AuthState>({ status: 'disconnected' });
  const [creating,     setCreating]     = useState(false);
  const [createResult, setCreateResult] = useState<CreateResponse | null>(null);
  const [createError,  setCreateError]  = useState<string | null>(null);
  const [fundingSessionId, setFundingSessionId] = useState<string | null>(null);
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [fundingSignature, setFundingSignature] = useState<string | null>(null);
  const [selectedFundingPresetPct, setSelectedFundingPresetPct] = useState<(typeof FUNDING_PRESET_PCTS)[number]>(50);

  // Session monitoring
  const [sessions,        setSessions]        = useState<Session[]>([]);
  const [actioning,        setActioning]        = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [minimumFundingSol, setMinimumFundingSol] = useState<number>(0);
  const [panelView, setPanelView] = useState<PanelView>('activity');
  const [topInfoSection, setTopInfoSection] = useState<TopInfoSection>('user');
  const [dashboardView, setDashboardView] = useState<DashboardView>('overview');
  const [performance, setPerformance] = useState<PerformanceResponse | null>(null);
  const [showOpenTrades, setShowOpenTrades] = useState(false);
  const [showProfitModeModal, setShowProfitModeModal] = useState(false);
  const [dismissedProfitModeSessionId, setDismissedProfitModeSessionId] = useState<string | null>(null);
  const [startingWithProfitMode, setStartingWithProfitMode] = useState(false);
  const [profitModeChoice, setProfitModeChoice] = useState<'send_to_owner' | 'compound'>('send_to_owner');
  const [profitPayoutTokenChoice, setProfitPayoutTokenChoice] = useState<'SOL' | 'USDC'>('USDC');
  const [showStopModal, setShowStopModal] = useState(false);
  const [stoppingSession, setStoppingSession] = useState(false);
  const [selectedHistoricalSessionId, setSelectedHistoricalSessionId] = useState<string | null>(null);
  const [accessGateState, setAccessGateState] = useState<AccessGateState>('checking');
  const [accessTrustedUntil, setAccessTrustedUntil] = useState<string | null>(null);
  const [enrollingAccess, setEnrollingAccess] = useState(false);
  const [licenseReveal, setLicenseReveal] = useState<{ userId: string; licenseKey: string } | null>(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const stored = window.sessionStorage.getItem(LICENSE_REVEAL_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    try {
      const parsed = JSON.parse(stored) as { userId?: unknown; licenseKey?: unknown };
      if (typeof parsed.userId === 'string' && typeof parsed.licenseKey === 'string') {
        return { userId: parsed.userId, licenseKey: parsed.licenseKey };
      }
    } catch {
      window.sessionStorage.removeItem(LICENSE_REVEAL_STORAGE_KEY);
    }

    return null;
  });
  const [idleBirdVideoIndex, setIdleBirdVideoIndex] = useState(() => pickNextRandomIndex(IDLE_BIRD_VIDEO_SOURCES.length));
  const [tradingCubeVideoIndex, setTradingCubeVideoIndex] = useState(() => pickNextRandomIndex(TRADING_CUBE_VIDEO_SOURCES.length));
  const [profitCelebrationVisible, setProfitCelebrationVisible] = useState(false);
  const [profitCelebrationKey, setProfitCelebrationKey] = useState(0);
  const lastCelebratedTradeKeyRef = useRef<string | null>(null);
  const lastCelebratedProfitTransferKeyRef = useRef<string | null>(null);
  const celebrationInitializedRef = useRef(false);
  const profitCelebrationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sessions the user just funded and that are awaiting the profit-mode prompt
  // once the worker flips them to `ready`. This is the safety net so the prompt
  // still appears even if the inline funding poll window expires first.
  const awaitingProfitModeSessionIdsRef = useRef<Set<string>>(new Set());

  const refreshAccessGate = useCallback(async () => {
    try {
      const response = await fetch('/api/access/boot', { cache: 'no-store' });
      const payload = await response.json() as AccessBootPayload;
      setAccessGateState(payload.state ?? 'temporary_required');
      setAccessTrustedUntil(payload.trustedUntil ?? null);
    } catch {
      setAccessGateState('temporary_required');
      setAccessTrustedUntil(null);
    }
  }, []);

  useEffect(() => {
    const bootCheck = setTimeout(() => {
      void refreshAccessGate();
    }, 0);

    return () => clearTimeout(bootCheck);
  }, [refreshAccessGate]);

  const unlockTemporaryGate = useCallback(async (password: string) => {
    const response = await fetch('/api/access/unlock-temporary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const payload = await response.json().catch(() => ({ error: 'wrong password' })) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? 'wrong password');
    }

    setAccessGateState('temporary_unlocked');
  }, []);

  const unlockLicenseGate = useCallback(async (password: string) => {
    const response = await fetch('/api/access/unlock-license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const payload = await response.json().catch(() => ({ error: 'license key rejected' })) as AccessEnrollPayload;
    if (!response.ok) {
      throw new Error(payload.details ?? payload.error ?? 'license key rejected');
    }

    setAccessGateState('access_granted');
    setAccessTrustedUntil(payload.trustedUntil ?? null);
  }, []);

  const handleUnauthorized = useCallback((payload?: UnauthorizedApiResponse) => {
    setSessions([]);
    setPerformance(null);
    setCreateResult(null);
    setAuth({
      status: 'unauthorized',
      reason: isUnauthorizedReason(payload?.reason) ? payload.reason : 'access_disabled',
      username: payload?.user?.username,
      expiryDate: payload?.user?.expiryDate ?? undefined,
    });
  }, []);

  // ── License check ───────────────────────────────────────────────────────────

  const checkLicense = useCallback(async (wallet: string) => {
    setAuth({ status: 'checking' });
    try {
      const res = await fetch(`${API}/users/by-wallet/${encodeURIComponent(wallet)}`);
      const data = await res.json().catch(() => ({})) as {
        authorized?: boolean;
        reason?: string;
        user?: {
          id: string;
          username: string;
          walletAddress: string;
          expiryDate: string | null;
          duration: string | null;
          gatedAccessEnrolledAt?: string | null;
          licenseKeyRevealedAt?: string | null;
        };
        error?: string;
      };

      if (res.status >= 500) {
        setAuth({ status: 'unauthorized', reason: 'service_unavailable' });
        return;
      }

      if (res.ok && data.authorized && data.user) {
        setAuth({ status: 'authorized', user: data.user as AuthUser });
      } else {
        setAuth({
          status: 'unauthorized',
          reason: isUnauthorizedReason(data.reason) ? data.reason : 'not_registered',
          username: data.user?.username,
          expiryDate: data.user?.expiryDate ?? undefined,
        });
      }
    } catch {
      setAuth({ status: 'unauthorized', reason: 'service_unavailable' });
    }
  }, []);

  // ── Wallet connect via adapter modal ─────────────────────────────────────

  useEffect(() => {
    if (publicKey) {
      const check = setTimeout(() => {
        void checkLicense(publicKey.toBase58());
      }, 0);
      return () => clearTimeout(check);
    } else {
      const reset = setTimeout(() => {
        setAuth({ status: 'disconnected' });
        setSessions([]);
        setCreateResult(null);
        setPerformance(null);
      }, 0);
      return () => clearTimeout(reset);
    }
  }, [publicKey, checkLicense]);

  useEffect(() => {
    if (accessGateState !== 'temporary_unlocked') {
      return;
    }

    if (auth.status !== 'authorized') {
      return;
    }

    let cancelled = false;

    const enrollTrustedDevice = async () => {
      setEnrollingAccess(true);
      try {
        const response = await fetch('/api/access/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet: auth.user.walletAddress }),
        });

        const payload = await response.json() as AccessEnrollPayload;
        if (!response.ok) {
          throw new Error(payload.details ?? payload.error ?? 'Failed to enroll trusted device');
        }

        if (cancelled) {
          return;
        }

        setAccessGateState('access_granted');
        setAccessTrustedUntil(payload.trustedUntil ?? null);
        setAuth((current) => current.status === 'authorized' && payload.user
          ? {
              status: 'authorized',
              user: {
                ...current.user,
                ...payload.user,
              },
            }
          : current);

        if (payload.firstReveal && payload.licenseKey && payload.user) {
          if (typeof window !== 'undefined') {
            window.sessionStorage.setItem(
              LICENSE_REVEAL_STORAGE_KEY,
              JSON.stringify({ userId: payload.user.id, licenseKey: payload.licenseKey }),
            );
          }
          setLicenseReveal({ userId: payload.user.id, licenseKey: payload.licenseKey });
        }
      } catch {
        if (!cancelled) {
          setAccessGateState('temporary_required');
          setAccessTrustedUntil(null);
        }
      } finally {
        if (!cancelled) {
          setEnrollingAccess(false);
        }
      }
    };

    void enrollTrustedDevice();

    return () => {
      cancelled = true;
    };
  }, [accessGateState, auth]);

  useEffect(() => {
    if (!connecting) return;
    const update = setTimeout(() => {
      setAuth({ status: 'connecting' });
    }, 0);
    return () => clearTimeout(update);
  }, [connecting]);

  const connectWallet = () => {
    setVisible(true);
  };

  const disconnectWallet = async () => {
    await disconnect();
  };

  // ── Sessions ──────────────────────────────────────────────────────────────

  const fetchSessions = useCallback(async (userId: string) => {
    try {
      const res = await fetch(`${API}/sessions?userId=${encodeURIComponent(userId)}`);
      if (res.status === 403) {
        const payload = await res.json() as UnauthorizedApiResponse;
        handleUnauthorized(payload);
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json() as { sessions: Session[]; minimumFundingLamports?: number; minimumFundingSol?: number };
      setSessions(data.sessions ?? []);
      setMinimumFundingSol(data.minimumFundingSol ?? 0);
      return data.sessions ?? [];
    } catch {
      // Keep latest known UI state on transient polling failures.
      return null;
    }
  }, [handleUnauthorized]);

  const fetchPerformance = useCallback(async (user: AuthUser) => {
    try {
      const params = new URLSearchParams({ userId: user.id });
      if (user.walletAddress) {
        params.set('ownerWallet', user.walletAddress);
      }
      const res = await fetch(`${API}/sessions/performance?${params.toString()}`);
      if (res.status === 403) {
        const payload = await res.json() as UnauthorizedApiResponse;
        handleUnauthorized(payload);
        return;
      }
      if (!res.ok) return;
      const data = await res.json() as PerformanceResponse;
      setPerformance(data);
    } catch {
      // Keep latest known UI state on transient polling failures.
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    if (auth.status !== 'authorized') return;
    const initialFetch = setTimeout(() => {
      void fetchSessions(auth.user.id);
      void fetchPerformance(auth.user);
    }, 0);
    const t = setInterval(() => {
      void fetchSessions(auth.user.id);
      void fetchPerformance(auth.user);
    }, 6000);
    return () => {
      clearTimeout(initialFetch);
      clearInterval(t);
    };
  }, [auth, fetchPerformance, fetchSessions]);

  // Safety net: if a just-funded session reaches `ready` after the inline
  // funding poll window has expired, the background poll picks it up here and
  // still pops the profit-mode prompt so the user is never stuck on a funded
  // session with no way to proceed.
  useEffect(() => {
    if (awaitingProfitModeSessionIdsRef.current.size === 0) return;
    if (showProfitModeModal) return;
    const readySession = sessions.find(
      (item) => awaitingProfitModeSessionIdsRef.current.has(item.id) && item.status === 'ready',
    );
    if (!readySession) return;
    awaitingProfitModeSessionIdsRef.current.delete(readySession.id);
    setDismissedProfitModeSessionId(null);
    setProfitModeChoice(readySession.userControl?.profitHandling?.mode ?? 'send_to_owner');
    setProfitPayoutTokenChoice(readySession.userControl?.profitHandling?.payoutToken ?? 'USDC');
    setShowProfitModeModal(true);
  }, [sessions, showProfitModeModal]);

  const sessionHistoryForSelection = performance?.sessionHistory ?? [];
  const [prevPerformanceSnapshot, setPrevPerformanceSnapshot] = useState(performance);
  if (performance !== prevPerformanceSnapshot) {
    setPrevPerformanceSnapshot(performance);
    if (sessionHistoryForSelection.length === 0) {
      setSelectedHistoricalSessionId(null);
    } else if (
      !selectedHistoricalSessionId
      || !sessionHistoryForSelection.some((session) => session.sessionId === selectedHistoricalSessionId)
    ) {
      setSelectedHistoricalSessionId(sessionHistoryForSelection[0].sessionId);
    }
  }

  // ── Create session ────────────────────────────────────────────────────────

  const createSession = useCallback(async () => {
    if (auth.status !== 'authorized') return;
    const user = auth.user;

    setCreating(true);
    setCreateError(null);
    setCreateResult(null);
    setFundingError(null);
    setFundingSignature(null);

    try {
      const res = await fetch(`${API}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId:        user.id,
          keyAuthUserId: user.id,
          licenseId:     user.id,
          ownerWallet:   user.walletAddress,
          fundingMint:        'So11111111111111111111111111111111111111112',
          fundingTokenSymbol: 'SOL',
          ...DEFAULT_SESSION_REQUEST,
        }),
      });
      const data = await res.json() as CreateResponse;
      if (!res.ok) {
        if (res.status === 403) {
          handleUnauthorized(data as unknown as UnauthorizedApiResponse);
          return;
        }
        setCreateError((data as { error?: string }).error ?? `HTTP ${res.status}`);
      } else {
        setCreateResult(data);
        void fetchSessions(user.id);
      }
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreating(false);
    }
  }, [auth, fetchSessions, handleUnauthorized]);

  const fundSession = useCallback(async (session: Session) => {
    if (auth.status !== 'authorized' || !publicKey) return;

    setFundingSessionId(session.id);
    setFundingError(null);
    setFundingSignature(null);
    setCreateError(null);

    try {
      const quoteResponse = await fetch(`${API}/sessions/${session.id}/funding-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedFundingPct: selectedFundingPresetPct }),
      });
      const quote = await quoteResponse.json() as FundingQuoteResponse;

      if (!quoteResponse.ok || !quote.unsignedTransactionBase64 || !quote.blockhash || quote.lastValidBlockHeight === undefined) {
        if (quoteResponse.status === 403) {
          handleUnauthorized(quote as unknown as UnauthorizedApiResponse);
          return;
        }

        throw new Error(quote.details ?? quote.error ?? `Funding quote failed (HTTP ${quoteResponse.status})`);
      }

      const transaction = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));

      // The server bakes a blockhash into the quote, but it can expire while the
      // wallet popup waits for the user to approve. Refresh it right before
      // signing so a slow approval no longer fails with an expired blockhash.
      let confirmBlockhash = quote.blockhash;
      let confirmLastValidBlockHeight = quote.lastValidBlockHeight;
      try {
        const fresh = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = fresh.blockhash;
        transaction.feePayer = publicKey;
        confirmBlockhash = fresh.blockhash;
        confirmLastValidBlockHeight = fresh.lastValidBlockHeight;
      } catch {
        // Fall back to the server-provided blockhash if the refresh fails.
      }

      const signature = await sendTransaction(transaction, connection, {
        preflightCommitment: 'confirmed',
      });

      await connection.confirmTransaction({
        signature,
        blockhash: confirmBlockhash,
        lastValidBlockHeight: confirmLastValidBlockHeight,
      }, 'confirmed');

      setFundingSignature(signature);
      // Register this session so the profit-mode prompt still fires from the
      // background poll if the inline window below expires before the worker
      // (which polls on-chain every ~5s) flips the session to `ready`.
      awaitingProfitModeSessionIdsRef.current.add(session.id);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const latestSessions = await fetchSessions(auth.user.id);
        const fundedSession = latestSessions?.find((item) => item.id === session.id);
        if (fundedSession?.status === 'ready') {
          awaitingProfitModeSessionIdsRef.current.delete(session.id);
          setDismissedProfitModeSessionId(null);
          setProfitModeChoice(fundedSession.userControl?.profitHandling?.mode ?? 'send_to_owner');
          setProfitPayoutTokenChoice(fundedSession.userControl?.profitHandling?.payoutToken ?? 'USDC');
          setShowProfitModeModal(true);
          break;
        }

        if (fundedSession && fundedSession.status !== 'awaiting_funding') {
          break;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error) {
      setFundingError(error instanceof Error ? error.message : 'Funding transaction failed');
    } finally {
      setFundingSessionId(null);
    }
  }, [auth, connection, fetchSessions, handleUnauthorized, publicKey, selectedFundingPresetPct, sendTransaction]);

  // ── Session action ────────────────────────────────────────────────────────

  const handleAction = useCallback(async (
    sessionId: string,
    action: 'start' | 'pause' | 'resume' | 'stop',
    options?: {
      profitMode?: 'send_to_owner' | 'compound';
      profitPayoutToken?: 'SOL' | 'USDC';
      stopDisposition?: 'return_tokens' | 'liquidate';
      clientActionSource?: string;
    },
  ) => {
    if (auth.status !== 'authorized') return;
    setActioning(sessionId);
    setActionError(null);
    try {
      const res = await fetch(`${API}/sessions/${sessionId}/action`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(options?.profitMode ? { profitMode: options.profitMode } : {}),
          ...(options?.profitPayoutToken ? { profitPayoutToken: options.profitPayoutToken } : {}),
          ...(options?.stopDisposition ? { stopDisposition: options.stopDisposition } : {}),
          ...(options?.clientActionSource ? { clientActionSource: options.clientActionSource } : {}),
        }),
      });
      if (res.status === 403) {
        const payload = await res.json() as UnauthorizedApiResponse;
        handleUnauthorized(payload);
        return;
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({})) as { error?: string; details?: string };
        throw new Error(payload.details ?? payload.error ?? `Session action failed (HTTP ${res.status})`);
      }
      void fetchSessions(auth.user.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Session action failed');
    } finally {
      setActioning(null);
    }
  }, [auth, fetchSessions, handleUnauthorized]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const isConnecting = connecting || auth.status === 'connecting' || auth.status === 'checking';
  const authorizedUser = auth.status === 'authorized' ? auth.user : null;
  const primarySession = sessions.length > 0
    ? [...sessions].sort((a, b) => {
      const priorityDiff = SESSION_PRIORITY.indexOf(a.status) - SESSION_PRIORITY.indexOf(b.status);
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
    })[0]
    : null;

  useEffect(() => {
    if (!primarySession || primarySession.status !== 'ready') {
      if (showProfitModeModal) {
        setShowProfitModeModal(false);
      }
      return;
    }

    if (dismissedProfitModeSessionId === primarySession.id || startingWithProfitMode) {
      return;
    }

    // The modal is already open for this ready session — do not re-seed the
    // choices from the stored values. Background session polls give
    // `primarySession` a fresh reference every cycle, which would otherwise
    // re-run this effect and clobber the user's in-progress SOL/compound
    // selection before they can hit "Save and Start".
    if (showProfitModeModal) {
      return;
    }

    setProfitModeChoice(primarySession.userControl?.profitHandling?.mode ?? 'send_to_owner');
    setProfitPayoutTokenChoice(primarySession.userControl?.profitHandling?.payoutToken ?? 'USDC');
    setShowProfitModeModal(true);
  }, [dismissedProfitModeSessionId, primarySession, showProfitModeModal, startingWithProfitMode]);

  const showLogicVideo = primarySession
    ? ['starting', 'active', 'stopping', 'settling'].includes(primarySession.status)
    : false;

  const profitHandlingMode = primarySession?.userControl?.profitHandling?.mode;
  const profitHandlingToken = primarySession?.userControl?.profitHandling?.payoutToken;
  const profitSyncKey = `${primarySession?.id ?? ''}|${profitHandlingMode ?? ''}|${profitHandlingToken ?? ''}`;
  const [prevProfitSyncKey, setPrevProfitSyncKey] = useState(profitSyncKey);
  if (profitSyncKey !== prevProfitSyncKey) {
    setPrevProfitSyncKey(profitSyncKey);
    if (profitHandlingMode === 'send_to_owner' || profitHandlingMode === 'compound') {
      setProfitModeChoice(profitHandlingMode);
    }
    if (profitHandlingToken === 'SOL' || profitHandlingToken === 'USDC') {
      setProfitPayoutTokenChoice(profitHandlingToken);
    }
  }

  const submitStartWithProfitChoice = useCallback(async () => {
    if (!primarySession || primarySession.status !== 'ready') {
      return;
    }

    try {
      setStartingWithProfitMode(true);
      await handleAction(primarySession.id, 'start', {
        profitMode: profitModeChoice,
        profitPayoutToken: profitPayoutTokenChoice,
      });
      setShowProfitModeModal(false);
    } finally {
      setStartingWithProfitMode(false);
    }
  }, [handleAction, primarySession, profitModeChoice, profitPayoutTokenChoice]);

  const submitStopWithDisposition = useCallback(async (disposition: 'return_tokens' | 'liquidate') => {
    if (!primarySession) {
      return;
    }

    try {
      setStoppingSession(true);
      await handleAction(primarySession.id, 'stop', {
        stopDisposition: disposition,
        clientActionSource: `stop-modal:${disposition}`,
      });
      setShowStopModal(false);
    } finally {
      setStoppingSession(false);
    }
  }, [handleAction, primarySession]);

  const [prevShowLogicVideo, setPrevShowLogicVideo] = useState(showLogicVideo);
  if (showLogicVideo !== prevShowLogicVideo) {
    setPrevShowLogicVideo(showLogicVideo);
    if (showLogicVideo) {
      setTradingCubeVideoIndex((currentIndex) => pickNextRandomIndex(TRADING_CUBE_VIDEO_SOURCES.length, currentIndex));
    } else {
      setIdleBirdVideoIndex((currentIndex) => pickNextRandomIndex(IDLE_BIRD_VIDEO_SOURCES.length, currentIndex));
    }
  }

  const minimumFundingLabel = formatFundingRequirement(minimumFundingSol);
  const liveFundingBalance = primarySession ? formatFundingSol(primarySession.funding.currentBalanceAtomic) : '—';
  const nextStepLabel = (() => {
    if (!primarySession) return 'create a session';
    switch (primarySession.status) {
      case 'awaiting_funding':
        return 'fund bot wallet';
      case 'ready':
        return 'choose profit mode';
      case 'starting':
        return 'starting now';
      case 'active':
        return 'monitor control';
      case 'paused':
        return 'resume stop';
      case 'stopping':
      case 'settling':
        return 'recover funds';
      case 'error':
        return 'reset session';
      default:
        return 'create a session';
    }
  })();
  const sessionMarkers = buildSessionMarkers(primarySession, minimumFundingSol);
  const controllerStatusLabel = primarySession ? primarySession.status.replace(/_/g, ' ') : '';
  const userContextRows: InfoRow[] = auth.status === 'authorized'
    ? [
      { label: 'user', value: auth.user.username },
      { label: 'access', value: accessTrustedUntil ? `trusted until ${formatDateTime(accessTrustedUntil)}` : 'trusted device enrolled' },
      { label: 'owner wallet', value: formatWalletShort(auth.user.walletAddress) },
      { label: 'started', value: formatDateTime(primarySession?.startedAt ?? null) },
      { label: 'network', value: 'Solana' },
    ]
    : [];

  const walletFinancialRows: InfoRow[] = auth.status === 'authorized'
    ? [
      { label: 'minimum required', value: minimumFundingLabel },
      { label: 'detected balance', value: liveFundingBalance },
      { label: 'funding token', value: primarySession?.funding.fundingTokenSymbol ?? 'SOL' },
      { label: 'funded amount', value: primarySession ? formatFundingSol(primarySession.funding.startingBalanceAtomic) : '—' },
      { label: 'realized pnl', value: primarySession ? formatUsd(primarySession.funding.realizedPnlUsd) : '—' },
      { label: 'unrealized pnl', value: primarySession ? formatUsd(primarySession.funding.unrealizedPnlUsd) : '—' },
      { label: 'fees captured', value: primarySession ? `$${primarySession.funding.capturedFeesUsd.toFixed(4)}` : '—' },
    ]
    : [];

  const openPositionsForPrimary = getOpenSessionPositions(primarySession);
  const sessionWalletSolscanUrl = primarySession?.sessionWallet
    ? `https://solscan.io/account/${primarySession.sessionWallet}`
    : null;

  const monitoringRows: InfoRow[] = auth.status === 'authorized'
    ? [
      { label: 'status', value: primarySession ? primarySession.status.replace(/_/g, ' ') : 'stopped' },
      {
        label: 'profit mode',
        value: primarySession?.userControl?.profitHandling
          ? `${primarySession.userControl.profitHandling.mode === 'send_to_owner' ? 'send to owner' : 'compound'} · ${primarySession.userControl.profitHandling.payoutToken}`
          : 'send to owner · USDC',
      },
      {
        label: 'session wallet',
        value: primarySession?.sessionWallet ?? 'awaiting session',
        title: primarySession?.sessionWallet ?? undefined,
      },
      {
        label: 'solscan',
        value: sessionWalletSolscanUrl ?? 'unavailable',
        href: sessionWalletSolscanUrl ?? undefined,
        title: sessionWalletSolscanUrl ?? undefined,
      },
      { label: 'open positions', value: `${openPositionsForPrimary.length}` },
      ...openPositionsForPrimary.slice(0, 4).map((position, index): InfoRow => ({
        label: `position ${index + 1}`,
        value: formatPositionDetail(position),
        title: position.positionMint ?? undefined,
      })),
      { label: 'next step', value: `${nextStepLabel} ...` },
    ]
    : [];

  const topInfoSections: Array<{
    key: TopInfoSection;
    title: string;
    rows: InfoRow[];
    titleClassName: string;
  }> = [
    {
      key: 'user',
      title: 'User',
      rows: userContextRows,
      titleClassName: 'text-cyan-200/85',
    },
    {
      key: 'wallet',
      title: 'Wallet',
      rows: walletFinancialRows,
      titleClassName: 'text-emerald-200/85',
    },
    {
      key: 'monitoring',
      title: 'Monitoring',
      rows: monitoringRows,
      titleClassName: 'text-violet-200/85',
    },
  ];
  const activeTopInfoSection = topInfoSections.find((section) => section.key === topInfoSection) ?? topInfoSections[0];

  const dashboardSummaryRows: InfoRow[] = auth.status === 'authorized'
    ? [
      { label: 'gate', value: accessTrustedUntil ? `expires ${formatDateTime(accessTrustedUntil)}` : 'trusted device active' },
      { label: 'fees captured', value: `$${(performance?.summary.totalCapturedFeesUsd ?? 0).toFixed(4)}` },
      { label: 'sessions', value: `${(performance?.summary.totalSessions ?? sessions.length)} total / ${(performance?.summary.activeSessions ?? sessions.filter((session) => session.status === 'active').length)} active` },
      { label: 'executions', value: `${(performance?.summary.confirmedExecutions ?? 0)} confirmed` },
      { label: 'inventory', value: `${(performance?.summary.longSolSessions ?? 0)} long / ${Math.max((performance?.summary.totalSessions ?? 0) - (performance?.summary.longSolSessions ?? 0), 0)} flat-ish` },
      { label: 'last execution', value: formatDateTime(performance?.summary.lastExecutionAt ?? null) },
    ]
    : [];

  const performanceActivity = performance?.recentActivity ?? [];
  const tradeMetrics = performance?.tradeMetrics ?? null;
  const strongestToken = tradeMetrics?.profitableTokens[0] ?? null;
  const pnlTimeline = tradeMetrics?.pnlTimeline ?? [];
  const pnlTimelineScale = pnlTimeline.reduce((max, point) => Math.max(max, Math.abs(point.pnlUsd)), 0) || 1;
  const primarySessionActivity = primarySession
    ? performanceActivity.filter((item) => item.sessionId === primarySession.id).slice(0, 6)
    : [];

  useEffect(() => {
    const latestConfirmedSwap = primarySessionActivity.find((item) => item.kind === 'swap_confirmed') ?? null;
    const latestTradeKey = latestConfirmedSwap
      ? `${latestConfirmedSwap.sessionId}:${latestConfirmedSwap.executionId ?? latestConfirmedSwap.signature ?? latestConfirmedSwap.at}`
      : null;
    const transferredProfitUsd = primarySession?.serviceControl?.schedulingState?.transferredProfitUsd ?? 0;
    const lastProfitTransferAt = primarySession?.serviceControl?.schedulingState?.lastProfitTransferAt ?? null;
    const profitTransferKey = lastProfitTransferAt && transferredProfitUsd > 0
      ? `${primarySession?.id ?? 'session'}:${lastProfitTransferAt}:${transferredProfitUsd}`
      : null;

    if (!celebrationInitializedRef.current) {
      lastCelebratedTradeKeyRef.current = latestTradeKey;
      lastCelebratedProfitTransferKeyRef.current = profitTransferKey;
      celebrationInitializedRef.current = true;
      return;
    }

    const hasNewTrade = Boolean(latestTradeKey && latestTradeKey !== lastCelebratedTradeKeyRef.current);
    const hasNewProfitTransfer = Boolean(profitTransferKey && profitTransferKey !== lastCelebratedProfitTransferKeyRef.current);

    if (!hasNewTrade && !hasNewProfitTransfer) {
      return;
    }

    lastCelebratedTradeKeyRef.current = latestTradeKey;
    lastCelebratedProfitTransferKeyRef.current = profitTransferKey;
    setProfitCelebrationKey((value) => value + 1);
    setProfitCelebrationVisible(true);

    if (profitCelebrationTimeoutRef.current) {
      clearTimeout(profitCelebrationTimeoutRef.current);
    }

    profitCelebrationTimeoutRef.current = setTimeout(() => {
      setProfitCelebrationVisible(false);
      profitCelebrationTimeoutRef.current = null;
    }, 5200);
  }, [primarySession?.id, primarySession?.serviceControl?.schedulingState?.lastProfitTransferAt, primarySession?.serviceControl?.schedulingState?.transferredProfitUsd, primarySessionActivity]);

  useEffect(() => () => {
    if (profitCelebrationTimeoutRef.current) {
      clearTimeout(profitCelebrationTimeoutRef.current);
    }
  }, []);

  const terminalActivityLines = (() => {
    const lines: Array<{ key: string; tone: 'neutral' | 'good' | 'warn' | 'error' | 'accent'; text: string; at?: string }> = [];

    lines.push({
      key: 'next-step',
      tone: 'accent',
      text: `next step: ${nextStepLabel} ...`,
    });

    if (primarySession) {
      lines.push({
        key: 'status',
        tone: 'neutral',
        text: `session status: ${primarySession.status.replace(/_/g, ' ')}`,
      });
    }

    if (primarySession?.status === 'awaiting_funding') {
      lines.push({
        key: 'funding-required',
        tone: 'warn',
        text: `awaiting funding (${minimumFundingLabel} required · detected ${formatFundingSol(primarySession.funding.currentBalanceAtomic)})`,
      });
    }

    sessionMarkers.forEach((marker, index) => {
      lines.push({
        key: `marker-${index}-${marker.title}`,
        tone: marker.tone === 'good' ? 'good' : marker.tone === 'warn' ? 'warn' : 'neutral',
        text: `${marker.title.toLowerCase()}: ${marker.detail}`,
      });
    });

    const activityLines = [...primarySessionActivity]
      .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
      .map((item) => {
        const activity = describeActivity(item);
        const tone: 'neutral' | 'good' | 'warn' | 'error' =
          item.kind === 'swap_confirmed' || item.kind === 'session_started'
            ? 'good'
            : item.kind === 'swap_failed'
              ? 'error'
              : item.kind === 'session_ended'
                ? 'warn'
                : 'neutral';

        return {
          key: `${item.kind}-${item.at}-${item.executionId ?? item.sessionId}`,
          tone,
          at: item.at,
          text: `${activity.title.toLowerCase()}: ${activity.detail}`,
        };
      });

    lines.push(...activityLines);

    if (createResult) {
      lines.push({
        key: 'created-session',
        tone: 'good',
        text: `session created: ${createResult.fundingInstructions.sendTo}`,
      });
    }

    if (fundingSignature) {
      lines.push({
        key: 'funding-signature',
        tone: 'good',
        text: `funding submitted: ${fundingSignature}`,
      });
    }

    if (fundingError) {
      lines.push({
        key: 'funding-error',
        tone: 'error',
        text: `funding failed: ${fundingError}`,
      });
    }

    if (actionError) {
      lines.push({
        key: 'action-error',
        tone: 'error',
        text: `session action failed: ${actionError}`,
      });
    }

    if (createError) {
      lines.push({
        key: 'create-error',
        tone: 'error',
        text: `session create failed: ${createError}`,
      });
    }

    return lines;
  })();
  const phaseKeyword = getPhaseKeyword(primarySession, primarySessionActivity);
  const sessionTakeProfit = primarySession?.funding.realizedPnlUsd ?? 0;
  const openTradeSessions = sessions.filter((session) => session.status === 'active' && session.sessionWallet && getOpenSessionPositions(session).length > 0);
  const historicalSessions = performance?.sessionHistory ?? [];
  const selectedHistoricalSession = historicalSessions.find((session) => session.sessionId === selectedHistoricalSessionId)
    ?? historicalSessions[0]
    ?? null;

  const primaryAction = (() => {
    if (auth.status !== 'authorized') {
      return { label: 'Start', disabled: true, onClick: () => undefined };
    }

    if (!primarySession || ['stopped', 'error'].includes(primarySession.status)) {
      return {
        label: creating ? 'Starting…' : 'Start',
        disabled: creating,
        onClick: () => {
          void createSession();
        },
      };
    }

    if (primarySession.status === 'awaiting_funding') {
      return {
        label: fundingSessionId === primarySession.id ? 'Funding…' : 'Fund Wallet',
        disabled: fundingSessionId === primarySession.id,
        onClick: () => void fundSession(primarySession),
      };
    }

    if (primarySession.status === 'ready') {
      return {
        label: actioning === primarySession.id ? 'Starting…' : 'Start',
        disabled: actioning === primarySession.id,
        onClick: () => {
          setDismissedProfitModeSessionId(null);
          setProfitModeChoice(primarySession.userControl?.profitHandling?.mode ?? 'send_to_owner');
          setProfitPayoutTokenChoice(primarySession.userControl?.profitHandling?.payoutToken ?? 'USDC');
          setShowProfitModeModal(true);
        },
      };
    }

    if (primarySession.status === 'active') {
      return {
        label: actioning === primarySession.id ? 'Pausing…' : 'Pause',
        disabled: actioning === primarySession.id,
        onClick: () => void handleAction(primarySession.id, 'pause'),
      };
    }

    if (primarySession.status === 'paused') {
      return {
        label: actioning === primarySession.id ? 'Resuming…' : 'Resume',
        disabled: actioning === primarySession.id,
        onClick: () => void handleAction(primarySession.id, 'resume'),
      };
    }

    return {
      label: primarySession.status === 'starting' ? 'Starting…' : 'Running…',
      disabled: true,
      onClick: () => undefined,
    };
  })();

  const canStop = primarySession !== null && ['awaiting_funding', 'ready', 'active', 'paused', 'starting'].includes(primarySession.status);

  if (accessGateState === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-sm uppercase tracking-[0.25em] text-cyan-200">
        loading access
      </div>
    );
  }

  if (accessGateState === 'temporary_required') {
    return <IntroGate mode="temporary" onUnlock={unlockTemporaryGate} />;
  }

  if (accessGateState === 'license_required') {
    return <IntroGate mode="license" onUnlock={unlockLicenseGate} />;
  }

  // ── UI ──────────────────────────────────────────────────────────────────────

  return (
    <div
      className="min-h-screen text-white font-sans bg-cover bg-center bg-no-repeat flex flex-col"
      style={{ backgroundImage: "url('/media/roguezerobg.png')" }}
    >

      {/* ── Header ── */}
      <header className="px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <a href="/manager" title="Access Manager" aria-label="Access Manager">
            <img src="/rz-logo.png" alt="RogueZero" className="h-16 w-auto cursor-pointer transition hover:opacity-80" />
          </a>
        </div>

        {connected && publicKey ? (
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/15 bg-slate-950/35 px-3 py-1 shadow-[0_0_20px_rgba(34,211,238,0.06)] backdrop-blur-sm">
              {authorizedUser && (
                <span className="text-xs font-semibold text-emerald-400">{authorizedUser.username}</span>
              )}
              <span className="text-xs font-mono">
                <span className="text-cyan-300">{publicKey.toBase58().slice(0, 6)}</span>
                <span className="text-gray-600">…</span>
                <span className="text-violet-300">{publicKey.toBase58().slice(-4)}</span>
              </span>
            </div>
            <button
              onClick={() => void disconnectWallet()}
              className="text-xs text-gray-700 hover:text-gray-400 transition-colors border border-gray-800 hover:border-gray-600 px-2 py-1 rounded"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={() => void connectWallet()}
            disabled={isConnecting}
            className="bg-white text-black text-sm font-semibold px-4 py-2 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {isConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        )}
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-8">
        <div className="w-full max-w-[920px] px-2 sm:px-0">
          <section className="relative w-full">
            <div className="relative mx-auto w-full overflow-hidden rounded-[28px] border border-cyan-100/35 bg-slate-950/38 shadow-[0_18px_60px_rgba(0,0,0,0.52)] backdrop-blur-[7px]">
              <div className="grid h-[560px] max-h-[80vh] grid-cols-[34%_minmax(0,1fr)] items-stretch gap-[3.6%] px-[3.4%] py-[3.2%]">
              <div className="relative h-full w-full overflow-hidden rounded-[18px] border border-white/15 bg-black">
                <div className={showLogicVideo
                  ? 'absolute inset-0 flex items-center justify-center p-[9%]'
                  : IDLE_BIRD_VIDEO_SOURCES[idleBirdVideoIndex]?.wrapperClassName ?? 'absolute inset-0 flex items-center justify-center p-[9%]'}>
                  {showLogicVideo ? (
                    <video
                      key={`trading-cube-${tradingCubeVideoIndex}`}
                      autoPlay
                      muted
                      playsInline
                      onEnded={() => setTradingCubeVideoIndex((currentIndex) => pickNextRandomIndex(TRADING_CUBE_VIDEO_SOURCES.length, currentIndex))}
                      className="h-full w-full object-contain bg-black"
                    >
                      <source src={TRADING_CUBE_VIDEO_SOURCES[tradingCubeVideoIndex]} type="video/mp4" />
                    </video>
                  ) : (
                    <video
                      key={`idle-bird-${idleBirdVideoIndex}`}
                      autoPlay
                      muted
                      playsInline
                      onEnded={() => setIdleBirdVideoIndex((currentIndex) => pickNextRandomIndex(IDLE_BIRD_VIDEO_SOURCES.length, currentIndex))}
                      aria-label="Idle bird"
                      className={`${IDLE_BIRD_VIDEO_SOURCES[idleBirdVideoIndex].className} transition-transform duration-300`}
                    >
                      <source src={IDLE_BIRD_VIDEO_SOURCES[idleBirdVideoIndex].src} type={IDLE_BIRD_VIDEO_SOURCES[idleBirdVideoIndex].type} />
                    </video>
                  )}
                </div>
                <div
                  className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/35 transition-opacity duration-700 ${profitCelebrationVisible ? 'opacity-100' : 'opacity-0'}`}
                  aria-hidden="true"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={`profit-made-${profitCelebrationKey}`}
                    src={PROFIT_CELEBRATION_GIF_SRC}
                    alt="Profit made"
                    className="h-full w-full object-contain drop-shadow-[0_0_28px_rgba(34,197,94,0.35)]"
                  />
                </div>
                <div className="pointer-events-none absolute bottom-[3.5%] left-[5.5%] flex items-end gap-3 font-mono text-[clamp(8px,0.72vw,9px)]">
                  <span className="text-cyan-200">&gt; {phaseKeyword}</span>
                  {sessionTakeProfit !== 0 && (
                    <span className={`${sessionTakeProfit >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {sessionTakeProfit >= 0 ? '+' : ''}{sessionTakeProfit.toFixed(4)} usd
                    </span>
                  )}
                </div>
              </div>

              <div className="flex h-full min-h-0 flex-col self-stretch overflow-hidden rounded-[18px] border border-cyan-300/12 bg-slate-950/42 px-[4.6%] py-[4.2%] font-mono text-[clamp(8px,0.72vw,9px)] leading-[1.38] text-gray-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_0_30px_rgba(8,145,178,0.06)]">
                <div className="mb-[2.5%] flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5 text-[clamp(9px,0.72vw,10px)]">
                    <div className="text-[clamp(8px,0.85vw,10px)] uppercase tracking-[0.22em] text-gray-500">
                      {controllerStatusLabel}
                    </div>
                    <button
                      type="button"
                      onClick={primaryAction.onClick}
                      disabled={primaryAction.disabled}
                      className="rounded border border-slate-300/35 bg-gradient-to-b from-slate-200/15 to-slate-500/10 px-2 py-0.5 text-slate-100 transition hover:from-slate-200/25 hover:to-slate-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {primaryAction.label.toLowerCase()}
                    </button>
                    {primarySession?.status === 'awaiting_funding' && (
                      <div className="flex items-center gap-1">
                        {FUNDING_PRESET_PCTS.map((pct) => {
                          const active = selectedFundingPresetPct === pct;
                          return (
                            <button
                              key={pct}
                              type="button"
                              onClick={() => setSelectedFundingPresetPct(pct)}
                              disabled={fundingSessionId === primarySession.id}
                              className={`rounded border px-1.5 py-0.5 transition ${active
                                ? 'border-cyan-300/35 bg-cyan-500/12 text-cyan-100'
                                : 'border-slate-300/35 bg-slate-500/10 text-slate-200 hover:bg-slate-500/20'} disabled:cursor-not-allowed disabled:opacity-40`}
                              aria-label={`Use ${pct}% funding preset`}
                            >
                              {pct}%
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (!primarySession) return;
                        if (getOpenSessionPositions(primarySession).length > 0) {
                          setShowStopModal(true);
                        } else {
                          const isRunning = ['ready', 'starting', 'active', 'paused'].includes(primarySession.status);
                          if (isRunning && !window.confirm('Stop this session? This ends the session and returns funds to your owner wallet.')) {
                            return;
                          }
                          void handleAction(primarySession.id, 'stop', {
                            stopDisposition: 'return_tokens',
                            clientActionSource: 'inline-stop-button:return_tokens',
                          });
                        }
                      }}
                      disabled={!canStop || actioning === primarySession?.id}
                      className="rounded border border-zinc-300/35 bg-gradient-to-b from-zinc-200/15 to-zinc-500/10 px-2 py-0.5 text-zinc-100 transition hover:from-zinc-200/25 hover:to-zinc-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {(actioning === primarySession?.id && canStop ? 'Stopping…' : 'Stop').toLowerCase()}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-1.5 text-[clamp(9px,0.72vw,10px)]">
                    <button type="button" onClick={() => setPanelView('activity')} className={`px-0.5 transition ${panelView === 'activity' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                      activity
                    </button>
                    <span className="text-gray-600">/</span>
                    <button type="button" onClick={() => setPanelView('performance')} className={`px-0.5 transition ${panelView === 'performance' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                      dashboard
                    </button>
                  </div>
                </div>

                {auth.status === 'authorized' ? (
                  <>
                    <div className="flex-none text-gray-200">
                      {enrollingAccess && (
                        <div className="mb-3 rounded border border-cyan-300/18 bg-cyan-500/[0.05] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-cyan-100/80">
                          finalizing trusted device enrollment...
                        </div>
                      )}
                      {panelView === 'activity' ? (
                        <div className="px-1">
                          <div className="mb-2 flex items-center gap-4 border-b border-white/10 px-1">
                            {topInfoSections.map((section) => {
                              const active = topInfoSection === section.key;
                              return (
                                <button
                                  key={section.key}
                                  type="button"
                                  onClick={() => setTopInfoSection(section.key)}
                                  className={`border-b pb-1 text-[9px] uppercase tracking-[0.16em] transition ${active
                                    ? 'border-cyan-300 text-cyan-100'
                                    : 'border-transparent text-gray-500 hover:text-cyan-100'}`}
                                >
                                  {section.title}
                                </button>
                              );
                            })}
                          </div>
                          <div className="space-y-1 px-1">
                            {activeTopInfoSection.rows.map((row) => (
                              <div key={row.label} className="flex items-start justify-between gap-2">
                                <span className="min-w-16 text-gray-500">{row.label}</span>
                                {row.href ? (
                                  <a
                                    href={row.href}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={row.title ?? row.value}
                                    className="flex-1 break-all text-right text-cyan-100 underline decoration-cyan-300/30 underline-offset-2 hover:text-cyan-50"
                                  >
                                    {row.value}
                                  </a>
                                ) : (
                                  <span title={row.title ?? row.value} className="flex-1 break-all text-right text-cyan-100">{row.value}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                          {dashboardSummaryRows.map((row) => (
                            <div key={row.label} className="flex items-start justify-between gap-2">
                              <span className="min-w-[78px] text-gray-500">{row.label}</span>
                              <span className="flex-1 break-all text-right text-cyan-100">{row.value}</span>
                            </div>
                          ))}
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-[78px] text-gray-500">open trades</span>
                            <button
                              type="button"
                              onClick={() => setShowOpenTrades((value) => !value)}
                              className="rounded border border-cyan-400/20 bg-cyan-500/5 px-2 py-0.5 text-cyan-100 transition hover:bg-cyan-500/10"
                            >
                              {openTradeSessions.length} live
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="my-[1.2%] flex flex-none items-center justify-between gap-2 text-[9px] uppercase tracking-[0.18em] text-gray-500">
                      <div className="flex items-center gap-2">
                      <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                      <span>live activity monitor</span>
                      </div>
                      <span className="text-cyan-100">next step: {nextStepLabel} ...</span>
                    </div>

                    <div className="my-[1.2%] h-px flex-none bg-gradient-to-r from-cyan-400/30 via-white/10 to-transparent" />

                    <div className="min-h-0 flex flex-1 flex-col whitespace-pre-wrap pr-1 text-[clamp(8px,0.72vw,9px)] text-gray-300">
                      {panelView === 'activity' ? (
                        <div className="rz-scroll min-h-0 flex-1 overflow-y-auto rounded border border-cyan-300/10 bg-black/18 px-2 py-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)]">
                          {terminalActivityLines.length === 0 ? (
                            <div className="text-gray-500">&gt; waiting for activity ...</div>
                          ) : (
                            terminalActivityLines.map((line) => (
                              <div key={line.key} className="mb-1 flex items-start gap-2 last:mb-0">
                                <span className="w-[68px] shrink-0 text-gray-600">
                                  {line.at ? new Date(line.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'live'}
                                </span>
                                <span className={`${line.tone === 'good'
                                  ? 'text-emerald-300'
                                  : line.tone === 'warn'
                                    ? 'text-yellow-300'
                                    : line.tone === 'error'
                                      ? 'text-rose-300'
                                      : line.tone === 'accent'
                                        ? 'text-cyan-200'
                                        : 'text-gray-300'}`}>
                                  &gt; {line.text}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      ) : (
                        <div className="min-h-0 flex flex-1 flex-col overflow-hidden">
                          {dashboardView === 'overview' ? (
                            <div className="rz-scroll min-h-0 flex-1 overflow-y-auto">
                              <div className="mb-3 grid grid-cols-2 gap-2 text-[clamp(8px,0.72vw,9px)]">
                                <div className="rounded border border-emerald-400/20 bg-emerald-500/5 p-2 shadow-[0_0_18px_rgba(16,185,129,0.08)] transition duration-500 hover:border-emerald-300/35 hover:bg-emerald-500/10">
                                  <div className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/70">daily pnl</div>
                                  <div className={`mt-1 text-base ${((tradeMetrics?.dailyRealizedPnlUsd ?? 0) >= 0) ? 'text-emerald-200' : 'text-rose-200'}`}>
                                    {formatMetricUsd(tradeMetrics?.dailyRealizedPnlUsd ?? 0)}
                                  </div>
                                </div>
                                <div className="rounded border border-cyan-400/20 bg-cyan-500/5 p-2 shadow-[0_0_18px_rgba(34,211,238,0.08)] transition duration-500 hover:border-cyan-300/35 hover:bg-cyan-500/10">
                                  <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-200/70">historic pnl</div>
                                  <div className={`mt-1 text-base ${((tradeMetrics?.historicRealizedPnlUsd ?? 0) >= 0) ? 'text-cyan-100' : 'text-rose-200'}`}>
                                    {formatMetricUsd(tradeMetrics?.historicRealizedPnlUsd ?? 0)}
                                  </div>
                                </div>
                                <div className="rounded border border-violet-400/20 bg-violet-500/5 p-2 shadow-[0_0_18px_rgba(168,85,247,0.08)] transition duration-500 hover:border-violet-300/35 hover:bg-violet-500/10">
                                  <div className="text-[10px] uppercase tracking-[0.18em] text-violet-200/70">best trade</div>
                                  <div className={`mt-1 text-sm ${(tradeMetrics?.bestTrade?.pnlUsd ?? 0) >= 0 ? 'text-violet-100' : 'text-rose-200'}`}>
                                    {tradeMetrics?.bestTrade ? `${tradeMetrics.bestTrade.tokenSymbol} ${formatMetricUsd(tradeMetrics.bestTrade.pnlUsd)}` : 'awaiting truth'}
                                  </div>
                                  <div className="mt-1 text-gray-500">{tradeMetrics?.bestTrade ? formatShortDate(tradeMetrics.bestTrade.exitAt) : 'needs a full confirmed round trip'}</div>
                                </div>
                                <div className="rounded border border-amber-400/20 bg-amber-500/5 p-2 shadow-[0_0_18px_rgba(245,158,11,0.08)] transition duration-500 hover:border-amber-300/35 hover:bg-amber-500/10">
                                  <div className="text-[10px] uppercase tracking-[0.18em] text-amber-200/70">best trade today</div>
                                  <div className={`mt-1 text-sm ${(tradeMetrics?.bestTradeToday?.pnlUsd ?? 0) >= 0 ? 'text-amber-100' : 'text-rose-200'}`}>
                                    {tradeMetrics?.bestTradeToday ? `${tradeMetrics.bestTradeToday.tokenSymbol} ${formatMetricUsd(tradeMetrics.bestTradeToday.pnlUsd)}` : 'none today'}
                                  </div>
                                  <div className="mt-1 text-gray-500">{tradeMetrics?.bestTradeToday ? formatShortDate(tradeMetrics.bestTradeToday.exitAt) : 'watching confirmed exits'}</div>
                                </div>
                              </div>

                              {showOpenTrades && (
                                <div className="rz-scroll mb-3 max-h-28 overflow-y-auto rounded border border-cyan-400/15 bg-cyan-500/[0.04] p-2">
                                  <div className="mb-2 text-cyan-200">&gt; open trades</div>
                                  {openTradeSessions.length === 0 ? (
                                    <div className="text-gray-500">No open trades right now.</div>
                                  ) : (
                                    openTradeSessions.map((session) => {
                                      const openPositions = getOpenSessionPositions(session);
                                      const symbols = openPositions.slice(0, 3).map(formatOpenPositionLabel).join(', ');
                                      const extra = openPositions.length > 3 ? ` +${openPositions.length - 3} more` : '';

                                      return (
                                      <div key={session.id} className="mb-2 last:mb-0">
                                        <div className="text-cyan-100">{session.sessionWallet.slice(0, 6)}…{session.sessionWallet.slice(-4)}</div>
                                        <div className="text-gray-500">{openPositions.length} open · {symbols}{extra}</div>
                                      </div>
                                      );
                                    })
                                  )}
                                </div>
                              )}

                              <div className="rounded border border-white/8 bg-white/[0.03] p-2">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="text-cyan-200">&gt; realized pnl timeline</div>
                                  <div className="text-gray-500">
                                    {strongestToken
                                      ? `${strongestToken.tokenSymbol} ${formatMetricUsd(strongestToken.realizedPnlUsd)}`
                                      : 'no profitable token yet'}
                                  </div>
                                </div>
                                {pnlTimeline.length === 0 ? (
                                  <div className="mt-2 text-gray-500">No completed confirmed trade history yet.</div>
                                ) : (
                                  <div className="mt-3 flex h-16 items-end gap-1">
                                    {pnlTimeline.slice(-12).map((point, index, list) => {
                                      const height = Math.max(8, Math.round((Math.abs(point.pnlUsd) / pnlTimelineScale) * 52));
                                      const positive = point.pnlUsd >= 0;
                                      const isLatest = index === list.length - 1;

                                      return (
                                        <div key={`${point.date}-${index}`} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
                                          <div className="text-[9px] text-gray-500">{formatMetricUsd(point.pnlUsd)}</div>
                                          <div className="flex h-[52px] w-full items-end rounded-sm bg-white/[0.03] px-[1px]">
                                            <div
                                              className={`w-full rounded-sm transition-all duration-700 ${positive ? 'bg-emerald-400/80 shadow-[0_0_12px_rgba(16,185,129,0.24)]' : 'bg-rose-400/80 shadow-[0_0_12px_rgba(251,113,133,0.24)]'} ${isLatest ? 'animate-pulse' : ''}`}
                                              style={{ height: `${height}px` }}
                                            />
                                          </div>
                                          <div className="text-[9px] text-gray-500">{formatShortDate(point.date)}</div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="min-h-0 flex flex-1 gap-3 overflow-hidden text-[clamp(8px,0.72vw,9px)]">
                              <div className="flex w-[42%] min-w-[190px] flex-col overflow-hidden rounded border border-white/8 bg-white/[0.03]">
                                <div className="border-b border-white/8 px-3 py-2 text-cyan-200">&gt; session history</div>
                                <div className="rz-scroll min-h-0 overflow-y-auto p-2">
                                  {historicalSessions.length === 0 ? (
                                    <div className="text-gray-500">No confirmed session history yet.</div>
                                  ) : (
                                    historicalSessions.map((session) => {
                                      const isSelected = selectedHistoricalSession?.sessionId === session.sessionId;
                                      return (
                                        <button
                                          key={session.sessionId}
                                          type="button"
                                          onClick={() => setSelectedHistoricalSessionId(session.sessionId)}
                                          className={`mb-2 w-full rounded border px-2 py-2 text-left transition last:mb-0 ${isSelected ? 'border-cyan-300/30 bg-cyan-500/10' : 'border-white/8 bg-white/[0.02] hover:border-cyan-400/20 hover:bg-cyan-500/[0.05]'}`}
                                        >
                                          <div className="flex items-center justify-between gap-2">
                                            <div className="text-cyan-100">{formatWalletShort(session.sessionWallet)}</div>
                                            <span className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] ${STATUS_COLORS[(session.status as SessionStatus)] ?? 'text-gray-300 bg-gray-800/50'}`}>
                                              {session.status.replace(/_/g, ' ')}
                                            </span>
                                          </div>
                                          <div className="mt-1 text-gray-500">{formatDateTime(session.endedAt ?? session.startedAt ?? session.requestedAt)}</div>
                                          <div className={`mt-1 ${session.confirmedRealizedPnlUsd >= 0 ? 'text-emerald-200' : 'text-rose-200'}`}>
                                            {formatMetricUsd(session.confirmedRealizedPnlUsd)}
                                          </div>
                                          <div className="mt-1 flex items-center justify-between gap-2 text-gray-500">
                                            <span>{session.completedRoundTrips} closes</span>
                                            <span>{session.confirmedExecutions} confirmed</span>
                                          </div>
                                        </button>
                                      );
                                    })
                                  )}
                                </div>
                              </div>

                              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-white/8 bg-white/[0.03]">
                                {selectedHistoricalSession ? (
                                  <>
                                    <div className="border-b border-white/8 px-3 py-2">
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="text-cyan-200">&gt; mathematically confirmed session</div>
                                        <div className="text-gray-500">{formatWalletShort(selectedHistoricalSession.sessionWallet)}</div>
                                      </div>
                                      <div className="mt-1 text-gray-500">Closed trades and fee capture only from confirmed execution metadata.</div>
                                    </div>

                                    <div className="rz-scroll min-h-0 overflow-y-auto p-3">
                                      <div className="grid grid-cols-2 gap-2">
                                        <div className="rounded border border-emerald-400/20 bg-emerald-500/5 p-2">
                                          <div className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/70">confirmed pnl</div>
                                          <div className={`mt-1 text-sm ${selectedHistoricalSession.confirmedRealizedPnlUsd >= 0 ? 'text-emerald-100' : 'text-rose-200'}`}>
                                            {formatMetricUsd(selectedHistoricalSession.confirmedRealizedPnlUsd)}
                                          </div>
                                        </div>
                                        <div className="rounded border border-cyan-400/20 bg-cyan-500/5 p-2">
                                          <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-200/70">captured fees</div>
                                          <div className="mt-1 text-sm text-cyan-100">
                                            {formatMetricUsd(selectedHistoricalSession.confirmedCapturedFeesUsd)}
                                          </div>
                                        </div>
                                        <div className="rounded border border-violet-400/20 bg-violet-500/5 p-2">
                                          <div className="text-[10px] uppercase tracking-[0.18em] text-violet-200/70">round trips</div>
                                          <div className="mt-1 text-sm text-violet-100">{selectedHistoricalSession.completedRoundTrips}</div>
                                        </div>
                                        <div className="rounded border border-amber-400/20 bg-amber-500/5 p-2">
                                          <div className="text-[10px] uppercase tracking-[0.18em] text-amber-200/70">confirmed executions</div>
                                          <div className="mt-1 text-sm text-amber-100">{selectedHistoricalSession.confirmedExecutions}</div>
                                        </div>
                                      </div>

                                      <div className="mt-3 rounded border border-white/8 bg-white/[0.02] p-2">
                                        <div className="mb-2 text-cyan-200">&gt; session facts</div>
                                        <div className="space-y-1.5">
                                          {[
                                            { label: 'session id', value: selectedHistoricalSession.sessionId },
                                            { label: 'wallet', value: selectedHistoricalSession.sessionWallet },
                                            { label: 'funded amount', value: formatFundingSol(selectedHistoricalSession.fundedAmountAtomic) },
                                            { label: 'requested', value: formatDateTime(selectedHistoricalSession.requestedAt) },
                                            { label: 'started', value: formatDateTime(selectedHistoricalSession.startedAt) },
                                            { label: 'ended', value: formatDateTime(selectedHistoricalSession.endedAt) },
                                            { label: 'duration', value: formatDuration(selectedHistoricalSession.startedAt, selectedHistoricalSession.endedAt) },
                                            { label: 'stop reason', value: selectedHistoricalSession.stopReason?.replace(/_/g, ' ') ?? '—' },
                                            { label: 'last confirmed', value: formatDateTime(selectedHistoricalSession.lastConfirmedExecutionAt) },
                                            { label: 'best close', value: selectedHistoricalSession.bestTrade ? `${selectedHistoricalSession.bestTrade.tokenSymbol} ${formatMetricUsd(selectedHistoricalSession.bestTrade.pnlUsd)}` : '—' },
                                          ].map((row) => (
                                            <div key={row.label} className="flex items-start justify-between gap-3">
                                              <span className="min-w-[88px] text-gray-500">{row.label}</span>
                                              <span className="flex-1 break-all text-right text-cyan-100">{row.value}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>

                                      <div className="mt-3 rounded border border-white/8 bg-white/[0.02] p-2">
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                          <div className="text-cyan-200">&gt; closed trades</div>
                                          <div className="text-gray-500">{selectedHistoricalSession.completedTrades.length} confirmed closes</div>
                                        </div>
                                        {selectedHistoricalSession.completedTrades.length === 0 ? (
                                          <div className="text-gray-500">No completed confirmed round trips in this session yet.</div>
                                        ) : (
                                          selectedHistoricalSession.completedTrades.map((trade, index) => (
                                            <div key={`${trade.exitAt}-${trade.exitSignature ?? index}`} className="mb-2 rounded border border-white/6 bg-white/[0.02] p-2 last:mb-0">
                                              <div className="flex items-center justify-between gap-2">
                                                <div className="text-cyan-100">{trade.tokenSymbol} close</div>
                                                <div className={`${trade.pnlUsd >= 0 ? 'text-emerald-200' : 'text-rose-200'}`}>{formatMetricUsd(trade.pnlUsd)}</div>
                                              </div>
                                              <div className="mt-1 flex items-center justify-between gap-2 text-gray-500">
                                                <span>entry {formatDateTime(trade.entryAt)}</span>
                                                <span>exit {formatDateTime(trade.exitAt)}</span>
                                              </div>
                                              {trade.exitSignature && (
                                                <div className="mt-1 break-all text-gray-500">sig {trade.exitSignature}</div>
                                              )}
                                            </div>
                                          ))
                                        )}
                                      </div>
                                    </div>
                                  </>
                                ) : (
                                  <div className="flex h-full items-center justify-center px-3 text-gray-500">
                                    Select a session to inspect confirmed history.
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          <div className="mt-auto flex flex-none items-center gap-3 border-t border-white/8 pt-2 text-[clamp(8px,0.72vw,9px)]">
                            <button
                              type="button"
                              onClick={() => setDashboardView(dashboardView === 'overview' ? 'historical' : 'overview')}
                              className="flex items-center gap-2 rounded border border-white/10 bg-white/[0.02] p-1 pr-3 transition hover:border-cyan-300/25 hover:bg-cyan-500/[0.06] hover:shadow-[0_0_14px_rgba(34,211,238,0.12)]"
                              aria-label={dashboardView === 'overview' ? 'switch to historical' : 'switch to live'}
                              title={dashboardView === 'overview' ? 'switch to historical' : 'switch to live'}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={dashboardView === 'overview' ? '/media/historical-view-button.png' : '/media/historical-tab-button.png'}
                                alt={dashboardView === 'overview' ? 'switch to historical' : 'switch to live'}
                                className="block h-8 w-auto opacity-90 transition group-hover:opacity-100"
                              />
                              <span className="text-[10px] uppercase tracking-[0.22em] text-cyan-100/80">
                                {dashboardView === 'overview' ? 'Historical' : 'Live'}
                              </span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex min-h-0 flex-1 items-center whitespace-pre-wrap text-gray-400">
                    {auth.status === 'connecting' || auth.status === 'checking'
                      ? auth.status === 'connecting'
                        ? 'connecting to phantom...'
                        : 'verifying license...'
                      : auth.status === 'unauthorized'
                        ? auth.reason === 'not_registered'
                          ? 'wallet not registered\ncontact administrator for access.'
                            : auth.reason === 'access_disabled'
                            ? 'access denied\nplease see admin'
                              : auth.reason === 'license_expired'
                                ? `license expired${auth.expiryDate ? `\nexpired ${new Date(auth.expiryDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}`
                                : 'auth backend unavailable\nretry in a few seconds.'
                        : 'connect wallet to initialize controller.'}
                  </div>
                )}
              </div>
            </div>
            </div>
          </section>
        </div>
      </main>

      {licenseReveal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-6 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-3xl border border-cyan-300/20 bg-slate-950/96 p-6 shadow-[0_0_40px_rgba(34,211,238,0.12)]">
            <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-300">license key unlocked</div>
            <h2 className="mt-2 text-2xl font-semibold text-white">save this now</h2>
            <p className="mt-3 text-sm text-cyan-50/82">
              This device is now enrolled. Your license key replaces the shared temporary password on future access after the 6-hour trusted window expires.
            </p>
            <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-black/35 p-4 font-mono text-lg text-cyan-100 break-all">
              {licenseReveal.licenseKey}
            </div>
            <div className="mt-4 space-y-2 text-xs text-amber-100/85">
              <div>• Store it somewhere secure. This popup is the intentional reveal.</div>
              <div>• Refreshing won’t slide the 6-hour window forward.</div>
              <div>• A live session can still bypass the lock so you are not blind mid-run.</div>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={async () => {
                  await fetch('/api/access/license-revealed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: licenseReveal.userId }),
                  });
                  if (typeof window !== 'undefined') {
                    window.sessionStorage.removeItem(LICENSE_REVEAL_STORAGE_KEY);
                  }
                  setAuth((current) => current.status === 'authorized'
                    ? {
                        status: 'authorized',
                        user: {
                          ...current.user,
                          licenseKeyRevealedAt: new Date().toISOString(),
                        },
                      }
                    : current);
                  setLicenseReveal(null);
                }}
                className="rounded-xl border border-cyan-300/25 bg-cyan-500/10 px-4 py-2 text-sm text-cyan-100 transition hover:bg-cyan-500/18"
              >
                i saved it
              </button>
            </div>
          </div>
        </div>
      )}

      {showProfitModeModal && primarySession?.status === 'ready' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-6 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-2xl border border-cyan-300/20 bg-slate-950/95 p-5 shadow-[0_0_35px_rgba(34,211,238,0.12)]">
            <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-300">profit handling</div>
            <h3 className="mt-2 text-lg text-white">Choose how profits should be handled before start</h3>
            <p className="mt-2 text-sm text-cyan-50/80">
              You can either send profits back to your owner wallet as trades complete, or keep profits in the bot wallet to compound position sizing.
            </p>

            <div className="mt-4 grid gap-2">
              <button
                type="button"
                onClick={() => setProfitModeChoice('send_to_owner')}
                className={`rounded border px-3 py-2 text-left transition ${profitModeChoice === 'send_to_owner'
                  ? 'border-cyan-300/35 bg-cyan-500/12 text-cyan-100'
                  : 'border-white/10 bg-white/3 text-gray-300 hover:border-cyan-300/20 hover:text-cyan-100'}`}
              >
                <div className="text-xs uppercase tracking-[0.16em]">Send to owner</div>
                <div className="mt-1 text-xs text-gray-300">Skims realized profit back to your main wallet in the selected payout token when possible.</div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setProfitModeChoice('compound');
                  setProfitPayoutTokenChoice('SOL');
                }}
                className={`rounded border px-3 py-2 text-left transition ${profitModeChoice === 'compound'
                  ? 'border-cyan-300/35 bg-cyan-500/12 text-cyan-100'
                  : 'border-white/10 bg-white/3 text-gray-300 hover:border-cyan-300/20 hover:text-cyan-100'}`}
              >
                <div className="text-xs uppercase tracking-[0.16em]">Compound</div>
                <div className="mt-1 text-xs text-gray-300">Leaves realized profits in the bot wallet so the strategy can continue trading with a larger balance. Profits return as SOL.</div>
              </button>
            </div>

            {profitModeChoice !== 'compound' && (
              <div className="mt-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-gray-400">profit payout token</div>
                <div className="mt-2 flex gap-2">
                  {(['USDC', 'SOL'] as const).map((token) => (
                    <button
                      key={token}
                      type="button"
                      onClick={() => setProfitPayoutTokenChoice(token)}
                      className={`rounded border px-3 py-1.5 text-xs transition ${profitPayoutTokenChoice === token
                        ? 'border-cyan-300/35 bg-cyan-500/12 text-cyan-100'
                        : 'border-white/10 bg-white/3 text-gray-300 hover:border-cyan-300/20 hover:text-cyan-100'}`}
                    >
                      {token}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDismissedProfitModeSessionId(primarySession.id);
                  setShowProfitModeModal(false);
                }}
                className="rounded border border-white/15 bg-white/3 px-3 py-1.5 text-xs text-gray-200 transition hover:bg-white/8"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitStartWithProfitChoice()}
                disabled={startingWithProfitMode}
                className="rounded border border-cyan-300/25 bg-cyan-500/12 px-3 py-1.5 text-xs text-cyan-100 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {startingWithProfitMode ? 'Starting…' : 'Save and Start'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showStopModal && primarySession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-6 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-2xl border border-red-300/20 bg-slate-950/95 p-5 shadow-[0_0_35px_rgba(248,113,113,0.12)]">
            <div className="text-[10px] uppercase tracking-[0.28em] text-red-300">stop session</div>
            <h3 className="mt-2 text-lg text-white">You still have open positions</h3>
            <p className="mt-2 text-sm text-red-50/80">
              This session has {getOpenSessionPositions(primarySession).length} open position
              {getOpenSessionPositions(primarySession).length === 1 ? '' : 's'} (
              {getOpenSessionPositions(primarySession).map(formatOpenPositionLabel).join(', ')}
              ). The session wallet is destroyed after stopping for your privacy, so choose how these positions come home.
            </p>

            <div className="mt-4 grid gap-2">
              <button
                type="button"
                onClick={() => void submitStopWithDisposition('return_tokens')}
                disabled={stoppingSession}
                className="rounded border border-cyan-300/25 bg-cyan-500/10 px-3 py-2 text-left transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="text-xs uppercase tracking-[0.16em] text-cyan-100">Keep positions — send tokens to my wallet</div>
                <div className="mt-1 text-xs text-gray-300">Leaves your positions open and transfers the tokens directly to your owner wallet. Recommended.</div>
              </button>

              <button
                type="button"
                onClick={() => void submitStopWithDisposition('liquidate')}
                disabled={stoppingSession}
                className="rounded border border-red-300/30 bg-red-500/10 px-3 py-2 text-left transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="text-xs uppercase tracking-[0.16em] text-red-100">Close positions now — sell to SOL</div>
                <div className="mt-1 text-xs text-gray-300">Prematurely sells every open position back to SOL before sweeping the proceeds to your owner wallet.</div>
              </button>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowStopModal(false)}
                disabled={stoppingSession}
                className="rounded border border-white/15 bg-white/3 px-3 py-1.5 text-xs text-gray-200 transition hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}




