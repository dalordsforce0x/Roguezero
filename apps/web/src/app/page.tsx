'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

// ── Auth types ────────────────────────────────────────────────────────────────

type AuthState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'checking' }
  | { status: 'unauthorized'; reason: 'not_registered' | 'access_disabled' | 'license_expired'; username?: string; expiryDate?: string }
  | { status: 'authorized'; user: AuthUser };

type AuthUser = {
  id: string;
  username: string;
  walletAddress: string;
  licenseKey: string | null;
  expiryDate: string | null;
  duration: string | null;
};

const isUnauthorizedReason = (
  value: string | undefined,
): value is Extract<AuthState, { status: 'unauthorized' }>['reason'] =>
  value === 'not_registered' || value === 'access_disabled' || value === 'license_expired';

type UnauthorizedApiResponse = {
  authorized?: boolean;
  reason?: string;
  error?: string;
  user?: {
    id?: string;
    username?: string;
    walletAddress?: string;
    licenseKey?: string | null;
    expiryDate?: string | null;
    duration?: string | null;
  };
};

// ── Types ─────────────────────────────────────────────────────────────────────

type SessionStatus =
  | 'awaiting_funding' | 'ready' | 'starting' | 'active'
  | 'paused' | 'stopping' | 'stopped' | 'settling' | 'error';

type SessionPositionState = {
  status: 'flat' | 'long_sol';
  entryPriceUsd: number | null;
  entryAt: string | null;
  quantityAtomic: string | null;
  highWaterPriceUsd: number | null;
  lastMarkedPriceUsd: number | null;
  lastMarkedAt: string | null;
  pendingExitReason: string | null;
  exitReason: string | null;
};

type SessionSignal = {
  at: string;
  status: string;
  regime: string | null;
  momentumBps: number | null;
  guardReason: string | null;
};

type SessionTradeGate = {
  at: string;
  decision: string;
  reason: string;
  expectedEdgeBps: number | null;
  estimatedCostBps: number | null;
  safetyBufferBps: number | null;
};

type Session = {
  id: string;
  status: SessionStatus;
  sessionWallet: string;
  ownerWallet: string;
  funding: {
    fundingTokenSymbol: string;
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
    positionState?: SessionPositionState;
    lastSignal?: SessionSignal;
    lastTradeGate?: SessionTradeGate;
    rotationState?: { activeStrategy: string };
  };
  requestedAt: string;
  startedAt: string | null;
};

type CreateResponse = {
  session: Session;
  sessionWallet: string;
  fundingInstructions: {
    sendTo: string;
    minimumFundingSol: number;
    message: string;
  };
  error?: string;
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
  targetDurationMinutes: 60,
  stopLossBehavior: 'stop' as const,
  riskLimits: {
    maxSessionLossUsd: 50,
    maxDailyLossUsd: 100,
    maxPositionSizeUsd: 20,
    maxOpenPositions: 1,
    maxSlippageBps: 50,
    cooldownMs: 30000,
  },
};

// ── Status badge ──────────────────────────────────────────────────────────────

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

function StatusBadge({ status }: { status: SessionStatus }) {
  const cls = STATUS_COLORS[status] ?? 'text-gray-400 bg-gray-800';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status.replace(/_/g, ' ')}
    </span>
  );
}

type PanelView = 'activity' | 'performance';
type DashboardView = 'overview' | 'historical';

type SessionMarker = {
  title: string;
  detail: string;
  tone: 'neutral' | 'good' | 'warn';
};

type InfoRow = {
  label: string;
  value: string;
};

type GateProps = {
  storageKey: string;
  onUnlock: () => void;
};

const GATE_PASSWORD = '1121';
const GATE_VIDEO_SRC = '/media/rz-gated-access-intro.mp4';
const WEB_GATE_STORAGE_KEY = 'rz-web-gate-unlocked';
const IDLE_BIRD_ALT_VIDEO_SRC = '/media/birds2-alpha.webm';

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

const describeActivity = (item: PerformanceActivityItem) => {
  switch (item.kind) {
    case 'session_requested':
      return {
        title: 'session requested',
        detail: `${item.sessionWallet.slice(0, 6)}…${item.sessionWallet.slice(-4)} staged for funding.`,
      };
    case 'session_started':
      return {
        title: 'session started',
        detail: `${item.sessionWallet.slice(0, 6)}…${item.sessionWallet.slice(-4)} moved into execution flow.`,
      };
    case 'session_ended':
      return {
        title: 'session ended',
        detail: `Session ${item.sessionId.slice(0, 8)} closed with status ${item.status ?? 'unknown'}.`,
      };
    case 'swap_confirmed':
      return {
        title: 'swap confirmed',
        detail: `${formatExecutionAmountSol(item.amount)} submitted from ${item.sessionWallet.slice(0, 6)}…${item.sessionWallet.slice(-4)}.`,
      };
    case 'swap_submitted':
      return {
        title: 'swap submitted',
        detail: `Execution is in flight${item.signature ? ` · ${item.signature.slice(0, 8)}…` : ''}.`,
      };
    case 'swap_prepared':
      return {
        title: 'swap prepared',
        detail: `${formatExecutionAmountSol(item.amount)} prepared and waiting on execution path.`,
      };
    default:
      return {
        title: 'swap failed',
        detail: `Execution failed${item.executionId ? ` · ${item.executionId.slice(0, 8)}…` : ''}.`,
      };
  }
};

const getLatestActivityItem = (activity: PerformanceActivityItem[]) => (
  [...activity].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())[0] ?? null
);

const getPhaseKeyword = (session: Session | null, activity: PerformanceActivityItem[]): string => {
  if (!session || session.status === 'stopped') return 'idle';
  const latestActivity = getLatestActivityItem(activity);
  switch (session.status) {
    case 'awaiting_funding': return 'funding bot';
    case 'ready': return 'funding bot';
    case 'starting': return 'scanning';
    case 'active':
      if (latestActivity?.kind === 'swap_submitted' || latestActivity?.kind === 'swap_prepared') return 'executing trade';
      if (session.serviceControl?.positionState?.status === 'long_sol') return 'working';
      return 'scanning';
    case 'paused': return 'idle';
    case 'stopping':
    case 'settling': return 'withdrawing funds';
    case 'error': return 'idle';
    default: return 'idle';
  }
};

const buildSessionMarkers = (session: Session | null): SessionMarker[] => {
  if (!session) {
    return [];
  }

  const markers: SessionMarker[] = [
    { title: 'Session requested', detail: formatDateTime(session.requestedAt), tone: 'neutral' },
  ];

  if (session.startedAt) {
    markers.push({ title: 'Session started', detail: formatDateTime(session.startedAt), tone: 'good' });
  }

  if (session.status === 'awaiting_funding') {
    markers.push({ title: 'Awaiting funding', detail: 'Waiting for wallet deposit before execution can begin.', tone: 'warn' });
  }

  if (session.status === 'ready') {
    markers.push({ title: 'Ready to launch', detail: 'Funding detected. Session is staged for manual start.', tone: 'good' });
  }

  if (session.status === 'starting' || session.status === 'active') {
    const pos = session.serviceControl?.positionState;
    const sig = session.serviceControl?.lastSignal;
    const gate = session.serviceControl?.lastTradeGate;
    const strategy = session.serviceControl?.rotationState?.activeStrategy ?? 'momentum';

    // Position state
    if (pos) {
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

    // Strategy
    markers.push({ title: `Strategy: ${strategy}`, detail: `active strategy running`, tone: 'neutral' });

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
    markers.push({ title: 'Paused', detail: 'Trading is paused. Resume to continue.', tone: 'warn' });
    const pos = session.serviceControl?.positionState;
    if (pos) {
      markers.push({
        title: `Position: ${pos.status === 'long_sol' ? 'LONG SOL' : 'FLAT'}`,
        detail: pos.status === 'long_sol' && pos.entryPriceUsd ? `entry $${pos.entryPriceUsd.toFixed(2)}` : 'no open position',
        tone: 'neutral',
      });
    }
  }

  if (session.status === 'stopping' || session.status === 'settling') {
    markers.push({ title: 'Stop requested', detail: 'Sweeping funds back to owner wallet.', tone: 'warn' });
    if (session.funding.realizedPnlUsd !== 0) {
      markers.push({
        title: 'Final PnL',
        detail: `realized ${formatUsd(session.funding.realizedPnlUsd)} · fees $${session.funding.capturedFeesUsd.toFixed(4)}`,
        tone: session.funding.realizedPnlUsd >= 0 ? 'good' : 'warn',
      });
    }
  }

  if (session.status === 'stopped') {
    markers.push({ title: 'Stopped', detail: 'Session is closed and performance is ready to review.', tone: 'good' });
    if (session.funding.realizedPnlUsd !== 0) {
      markers.push({
        title: 'Session result',
        detail: `realized ${formatUsd(session.funding.realizedPnlUsd)} · fees $${session.funding.capturedFeesUsd.toFixed(4)}`,
        tone: session.funding.realizedPnlUsd >= 0 ? 'good' : 'warn',
      });
    }
  }

  if (session.status === 'error') {
    markers.push({ title: 'Session error', detail: 'The session hit an error state and needs attention.', tone: 'warn' });
  }

  return markers;
};

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

    setPhase('video');
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
              <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-300">access gate</div>
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
                unlock controller
              </button>
            </div>
          </div>
        )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const { publicKey, disconnect, connecting, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [auth, setAuth] = useState<AuthState>({ status: 'disconnected' });
  const [creating,     setCreating]     = useState(false);
  const [createResult, setCreateResult] = useState<CreateResponse | null>(null);
  const [createError,  setCreateError]  = useState<string | null>(null);

  // Session monitoring
  const [sessions,        setSessions]        = useState<Session[]>([]);
  const [sessionsLoading,  setSessionsLoading]  = useState(false);
  const [actioning,        setActioning]        = useState<string | null>(null);
  const [minimumFundingSol, setMinimumFundingSol] = useState<number>(0);
  const [panelView, setPanelView] = useState<PanelView>('activity');
  const [dashboardView, setDashboardView] = useState<DashboardView>('overview');
  const [performance, setPerformance] = useState<PerformanceResponse | null>(null);
  const [performanceLoading, setPerformanceLoading] = useState(false);
  const [showOpenTrades, setShowOpenTrades] = useState(false);
  const [selectedHistoricalSessionId, setSelectedHistoricalSessionId] = useState<string | null>(null);
  const [gateUnlocked, setGateUnlocked] = useState(false);
  const [idleBirdMode, setIdleBirdMode] = useState<'still' | 'alt-video'>('still');

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
      const data = await res.json() as {
        authorized?: boolean;
        reason?: string;
        user?: { id: string; username: string; walletAddress: string; licenseKey: string | null; expiryDate: string | null; duration: string | null };
      };
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
      setAuth({ status: 'unauthorized', reason: 'not_registered' });
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
    setSessionsLoading(true);
    try {
      const res = await fetch(`${API}/sessions?userId=${encodeURIComponent(userId)}`);
      if (res.status === 403) {
        const payload = await res.json() as UnauthorizedApiResponse;
        handleUnauthorized(payload);
        return;
      }
      if (!res.ok) return;
      const data = await res.json() as { sessions: Session[]; minimumFundingSol?: number };
      setSessions(data.sessions ?? []);
      setMinimumFundingSol(data.minimumFundingSol ?? 0);
    } finally {
      setSessionsLoading(false);
    }
  }, [handleUnauthorized]);

  const fetchPerformance = useCallback(async (user: AuthUser) => {
    setPerformanceLoading(true);
    try {
      const params = new URLSearchParams({ userId: user.id });
      if (user.walletAddress) {
        params.set('ownerWallet', user.walletAddress);
      }
      if (user.licenseKey) {
        params.set('licenseId', user.licenseKey);
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
    } finally {
      setPerformanceLoading(false);
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

  useEffect(() => {
    const sessionHistory = performance?.sessionHistory ?? [];
    if (sessionHistory.length === 0) {
      setSelectedHistoricalSessionId(null);
      return;
    }

    setSelectedHistoricalSessionId((current) => (
      current && sessionHistory.some((session) => session.sessionId === current)
        ? current
        : sessionHistory[0].sessionId
    ));
  }, [performance]);

  // ── Create session ────────────────────────────────────────────────────────

  const createSession = useCallback(async () => {
    if (auth.status !== 'authorized') return;
    const user = auth.user;

    setCreating(true);
    setCreateError(null);
    setCreateResult(null);

    try {
      const res = await fetch(`${API}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId:        user.id,
          keyAuthUserId: user.id,
          licenseId:     user.licenseKey ?? user.id,
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
  }, [auth, fetchSessions]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await createSession();
  };

  // ── Session action ────────────────────────────────────────────────────────

  const handleAction = async (sessionId: string, action: 'start' | 'pause' | 'resume' | 'stop') => {
    if (auth.status !== 'authorized') return;
    setActioning(sessionId);
    try {
      const res = await fetch(`${API}/sessions/${sessionId}/action`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.status === 403) {
        const payload = await res.json() as UnauthorizedApiResponse;
        handleUnauthorized(payload);
        return;
      }
      void fetchSessions(auth.user.id);
    } finally {
      setActioning(null);
    }
  };

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
  const showLogicVideo = primarySession
    ? ['starting', 'active', 'stopping', 'settling'].includes(primarySession.status)
    : false;

  useEffect(() => {
    if (showLogicVideo) {
      setIdleBirdMode('still');
      return;
    }

    const toggle = window.setInterval(() => {
      setIdleBirdMode((current) => current === 'still' ? 'alt-video' : 'still');
    }, 12000);

    return () => window.clearInterval(toggle);
  }, [showLogicVideo]);

  const sessionMarkers = buildSessionMarkers(primarySession);
  const controllerStatusLabel = primarySession ? primarySession.status.replace(/_/g, ' ') : '';
  const solscanLink = primarySession ? `https://solscan.io/account/${primarySession.sessionWallet}` : null;
  const controllerInfoRows: InfoRow[] = auth.status === 'authorized'
    ? [
      { label: 'user', value: auth.user.username },
      { label: 'license key', value: auth.user.licenseKey ?? 'no key assigned' },
      { label: 'owner wallet', value: auth.user.walletAddress },
      { label: 'started', value: formatDateTime(primarySession?.startedAt ?? null) },
      { label: 'network', value: 'Solana' },
      { label: 'funded amount', value: primarySession ? formatFundingSol(primarySession.funding.startingBalanceAtomic) : `${minimumFundingSol > 0 ? minimumFundingSol.toFixed(6) : '0.000000'} SOL` },
      { label: 'balance', value: primarySession ? formatFundingSol(primarySession.funding.currentBalanceAtomic) : '—' },
      { label: 'realized pnl', value: primarySession ? formatUsd(primarySession.funding.realizedPnlUsd) : '—' },
      { label: 'fees captured', value: primarySession ? `$${primarySession.funding.capturedFeesUsd.toFixed(4)}` : '—' },
      { label: 'ephemeral', value: primarySession?.sessionWallet ?? 'awaiting session' },
      { label: 'solscan', value: solscanLink ?? 'unavailable' },
    ]
    : [];

  const dashboardSummaryRows: InfoRow[] = auth.status === 'authorized'
    ? [
      { label: 'license', value: performance?.linkedBy.licenseId ?? auth.user.licenseKey ?? 'unassigned' },
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
  const phaseKeyword = getPhaseKeyword(primarySession, primarySessionActivity);
  const sessionTakeProfit = primarySession?.funding.realizedPnlUsd ?? 0;
  const openTradeSessions = sessions.filter((session) => session.status === 'active' && session.sessionWallet);
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
      return { label: 'Awaiting Funding', disabled: true, onClick: () => undefined };
    }

    if (primarySession.status === 'ready') {
      return {
        label: actioning === primarySession.id ? 'Starting…' : 'Start',
        disabled: actioning === primarySession.id,
        onClick: () => void handleAction(primarySession.id, 'start'),
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

  const canStop = primarySession !== null && ['ready', 'active', 'paused', 'starting'].includes(primarySession.status);

  if (!gateUnlocked) {
    return <IntroGate storageKey={WEB_GATE_STORAGE_KEY} onUnlock={() => setGateUnlocked(true)} />;
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
          <img src="/rz-logo.png" alt="RogueZero" className="h-16 w-auto" />
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
              <div className="relative h-full w-full overflow-hidden rounded-[18px] border border-white/15 bg-transparent">
                <div className="absolute inset-0">
                  {showLogicVideo ? (
                    <video
                      key="logic-active"
                      autoPlay
                      muted
                      loop
                      playsInline
                      className="h-full w-full object-contain object-bottom-left"
                    >
                      <source src="/media/rz-trading-logic.mp4" type="video/mp4" />
                    </video>
                  ) : idleBirdMode === 'alt-video' ? (
                    <div className="flex h-full w-full items-center justify-center">
                      <video
                        key="idle-bird-alt"
                        autoPlay
                        muted
                        loop
                        playsInline
                        className="h-[84%] w-[84%] object-contain object-center bg-transparent"
                      >
                        <source src={IDLE_BIRD_ALT_VIDEO_SRC} type="video/webm" />
                      </video>
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key="idle-bird-0"
                      src="/media/roguebird-alpha.webp"
                      alt="Idle bird"
                      className="h-full w-full object-contain object-bottom-left"
                    />
                  )}
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
                  <div className="text-[clamp(8px,0.85vw,10px)] uppercase tracking-[0.22em] text-gray-500">
                    {controllerStatusLabel}
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-1.5 text-[clamp(9px,0.72vw,10px)]">
                    <button
                      type="button"
                      onClick={primaryAction.onClick}
                      disabled={primaryAction.disabled}
                      className="rounded border border-emerald-300/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {primaryAction.label.toLowerCase()}
                    </button>
                    <button
                      type="button"
                      onClick={() => primarySession && void handleAction(primarySession.id, 'stop')}
                      disabled={!canStop || actioning === primarySession?.id}
                      className="rounded border border-red-400/30 bg-red-500/10 px-2 py-0.5 text-red-100 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {(actioning === primarySession?.id && canStop ? 'Stopping…' : 'Stop').toLowerCase()}
                    </button>
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
                      {panelView === 'activity' ? (
                        <div className="space-y-1.5">
                          {controllerInfoRows.map((row) => (
                            <div key={row.label} className="flex items-start justify-between gap-3">
                              <span className="min-w-[88px] text-gray-500">{row.label}</span>
                              <span className="flex-1 break-all text-right text-cyan-100">{row.value}</span>
                            </div>
                          ))}
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

                    <div className="my-[2.5%] flex flex-none items-center gap-2 text-[9px] uppercase tracking-[0.18em] text-gray-500">
                      <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                      <span>activity monitor</span>
                    </div>

                    <div className="my-[2.5%] h-px flex-none bg-gradient-to-r from-cyan-400/30 via-white/10 to-transparent" />

                    <div className="min-h-0 flex flex-1 flex-col whitespace-pre-wrap pr-1 text-[clamp(8px,0.72vw,9px)] text-gray-300">
                      {panelView === 'activity' ? (
                        <div className="rz-scroll min-h-0 flex-1 overflow-y-auto rounded border border-cyan-300/10 bg-black/18 px-2 py-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)]">
                          {sessionMarkers.map((marker, index) => (
                            <div key={`${marker.title}-${index}`} className="mb-2 last:mb-0">
                              <span className={`${marker.tone === 'good' ? 'text-emerald-300' : marker.tone === 'warn' ? 'text-yellow-300' : 'text-cyan-200'}`}>
                                &gt; {marker.title.toLowerCase()}
                              </span>
                              <div className="text-gray-400">{marker.detail}</div>
                            </div>
                          ))}

                          {(primarySession || primarySessionActivity.length > 0) && (
                            <div className="mt-3 rounded border border-cyan-300/12 bg-cyan-500/[0.04] p-2">
                              <div className="mb-2 flex items-center justify-between gap-2 text-cyan-200">
                                <span>&gt; live session log</span>
                                <span className="text-[9px] uppercase tracking-[0.16em] text-gray-500">stream</span>
                              </div>
                              {primarySessionActivity.map((item) => {
                                const activity = describeActivity(item);
                                return (
                                  <div key={`${item.kind}-${item.at}-${item.executionId ?? item.sessionId}`} className="mb-2 border-l border-cyan-300/15 pl-2 last:mb-0">
                                    <div className="text-emerald-300">&gt; {activity.title}</div>
                                    <div className="text-gray-400">{activity.detail}</div>
                                    <div className="text-gray-500">{formatDateTime(item.at)}</div>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {primarySession?.status === 'awaiting_funding' && (
                            <div className="mt-3 text-yellow-200">
                              &gt; fund wallet {primarySession.sessionWallet}
                              <div className="text-yellow-300/80">minimum funding {minimumFundingSol > 0 ? minimumFundingSol.toFixed(6) : '0.006806'} SOL</div>
                            </div>
                          )}

                          {createResult && (
                            <div className="mt-3 text-emerald-200">
                              &gt; session created
                              <div className="text-emerald-300/80 break-all">{createResult.fundingInstructions.sendTo}</div>
                            </div>
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
                                    openTradeSessions.map((session) => (
                                      <div key={session.id} className="mb-2 last:mb-0">
                                        <div className="text-cyan-100">{session.sessionWallet.slice(0, 6)}…{session.sessionWallet.slice(-4)}</div>
                                        <div className="text-gray-500">status {session.status.replace(/_/g, ' ')}</div>
                                      </div>
                                    ))
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
                            : `license expired${auth.expiryDate ? `\nexpired ${new Date(auth.expiryDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}`
                        : 'connect wallet to initialize controller.'}
                  </div>
                )}
              </div>
            </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
