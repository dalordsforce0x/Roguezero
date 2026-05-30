'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface User {
  id: string;
  username: string;
  wallet_address: string;
  license_key: string | null;
  expiry_date: string | null;
  access_enabled: boolean;
  duration: string | null;
  gated_access_enrolled_at: string | null;
  license_key_revealed_at: string | null;
  created_at: string;
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
  countsByStatus: Record<string, number>;
  issues: {
    staleActive: SessionHealthIssue[];
    stopping: SessionHealthIssue[];
    errors: SessionHealthIssue[];
    awaitingFunding: SessionHealthIssue[];
  };
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

interface HeliusRateLimitData {
  connected?: boolean;
  latencyMs?: number;
  blockHeight?: number;
  error?: string;
}

interface JupiterRateLimitData {
  connected?: boolean;
  latencyMs?: number;
  outUsdc?: string;
  priceImpactPct?: string;
  router?: string;
  error?: string;
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

interface RateLimitData {
  helius: HeliusRateLimitData;
  jupiter: JupiterRateLimitData;
  tigerdata: TigerDataRateLimitData;
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
function isExpired(iso: string | null) {
  return !!iso && new Date(iso) < new Date();
}

type Tab = 'users' | 'overview' | 'rate-limits' | 'session-health';

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
  traders,
}: {
  active: number;
  capacity: number;
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
      className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden"
      style={{ boxShadow: `0 0 0 1px rgba(255,255,255,0.03), inset 0 1px 0 rgba(255,255,255,0.04)` }}
    >
      {/* ── Top accent bar ── */}
      <div className="h-[2px] w-full" style={{ background: `linear-gradient(90deg, transparent, ${fillColor}88, transparent)` }} />

      <div className="flex divide-x divide-gray-800">

        {/* ── Left: capacity meter ── */}
        <div className="px-6 py-5 flex flex-col gap-4 min-w-[200px]">
          <div className="flex items-center justify-between">
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

          {/* Big number */}
          <div className="flex items-end gap-2">
            <span
              className="text-5xl font-bold tabular-nums leading-none"
              style={{ color: fillColor, filter: `drop-shadow(0 0 12px ${fillColor}66)` }}
            >
              {active}
            </span>
            <span className="text-gray-600 text-lg font-medium mb-1">/ {capacity}</span>
          </div>

          {/* Slot dots */}
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: Math.max(capacity, 1) }).map((_, i) => (
              <span
                key={i}
                className="block w-3 h-3 rounded-full transition-all duration-500"
                style={
                  i < active
                    ? { background: fillColor, boxShadow: `0 0 6px ${fillColor}99` }
                    : { background: '#1f2937', border: '1px solid #374151' }
                }
              />
            ))}
          </div>

          {/* Progress bar */}
          <div className="h-1 rounded-full bg-gray-800 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${Math.max(pct * 100, capacity === 0 ? 0 : 2)}%`,
                background: `linear-gradient(90deg, ${fillColor}99, ${fillColor})`,
                boxShadow: active > 0 ? `0 0 8px ${fillColor}66` : 'none',
              }}
            />
          </div>
        </div>

        {/* ── Right: who's trading ── */}
        <div className="flex-1 px-6 py-5 flex flex-col gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Currently Trading</span>

          {traders.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-4 gap-2">
              <div className="w-8 h-8 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center">
                <span className="text-gray-600 text-xs">—</span>
              </div>
              <p className="text-xs text-gray-600">No bots running</p>
            </div>
          ) : (
            <div className="space-y-2">
              {traders.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gray-800/50 border border-gray-700/50"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: '#10b981', boxShadow: '0 0 6px rgba(16,185,129,0.7)', animation: 'livePulse 1.8s ease-in-out infinite' }}
                  />
                  <span className="text-sm font-semibold text-white flex-1">{t.username}</span>
                  <span className="trading-live-badge shrink-0">● LIVE</span>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
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

function SizingMetric({ label, value }: { label: string; value: string }) {
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
  const positionState = (session.service_control as { positionState?: { status?: unknown; exitReason?: unknown } })?.positionState;
  const status = positionState?.status;
  const exitReason = typeof positionState?.exitReason === 'string' ? positionState.exitReason : null;

  if (status === 'long_sol') return 'LONG SOL';
  if (exitReason) return `FLAT · ${exitReason.replace(/_/g, ' ')}`;
  return 'FLAT';
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
  onDelete: (id: string) => void;
  assigning: string | null;
  toggling:  string | null;
}

function UserCard({ user: u, isLive, onToggle, onAssign, onDelete, assigning, toggling }: UserCardProps) {
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
      <div className={['absolute left-0 top-0 bottom-0 w-[2px]', isActive ? 'trading-accent-bar' : 'bg-gray-800'].join(' ')} />

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
              'inline-block h-3.5 w-3.5 mt-[3px] rounded-full bg-white shadow transition-transform duration-200',
              u.access_enabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
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
  const [loading, setLoading]     = useState(true);
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  const [adminSessions, setAdminSessions] = useState<AdminSession[]>([]);
  const [adminSessionsLoading, setAdminSessionsLoading] = useState(false);
  const [forceStoppingSessionId, setForceStoppingSessionId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm]           = useState({ username: '', walletAddress: '', duration: '1month' });
  const [formBusy, setFormBusy]   = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [toggling, setToggling]   = useState<string | null>(null);
  const [bgImage, setBgImage]     = useState<string | null>(null);
  const fileRef                   = useRef<HTMLInputElement>(null);

  // ─ Rate Limits state ─────────────────────────────────────────────────────
  const [rlData,    setRlData]    = useState<RateLimitData | null>(null);
  const [rlLoading, setRlLoading] = useState(false);
  const [sessionHealth, setSessionHealth] = useState<SessionHealthData | null>(null);
  const [sessionHealthLoading, setSessionHealthLoading] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [gateUnlocked, setGateUnlocked] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch('/api/users');
      const data = await res.json() as { success: boolean; users: User[] };
      setUsers(data.users ?? []);
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

  useEffect(() => {
    const boot = setTimeout(() => {
      void loadUsers();
      void fetchActiveSessions();
      setNowMs(Date.now());
    }, 0);
    const t = setInterval(() => void fetchActiveSessions(), 8000);
    return () => {
      clearTimeout(boot);
      clearInterval(t);
    };
  }, [loadUsers, fetchActiveSessions]);

  const fetchRateLimits = useCallback(async () => {
    setRlLoading(true);
    try {
      const [h, j, t] = await Promise.all([
        fetch('/api/rate-limits/helius').then(r   => r.json()),
        fetch('/api/rate-limits/jupiter').then(r   => r.json()),
        fetch('/api/rate-limits/tigerdata').then(r => r.json()),
      ]);
      setRlData({ helius: h, jupiter: j, tigerdata: t });
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

  const loadAdminSessions = useCallback(async () => {
    setAdminSessionsLoading(true);
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) return;
      const data = await res.json() as { sessions: AdminSession[] };
      setAdminSessions(data.sessions ?? []);
    } finally {
      setAdminSessionsLoading(false);
    }
  }, []);

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

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setFormBusy(true);
    await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    setShowModal(false);
    setForm({ username: '', walletAddress: '', duration: '1month' });
    setFormBusy(false);
    void loadUsers();
  }

  async function handleAssignLicense(id: string) {
    setAssigning(id);
    await fetch(`/api/users/${id}/assign-license`, { method: 'POST' });
    setAssigning(null);
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
    return <IntroGate storageKey={ADMIN_GATE_STORAGE_KEY} onUnlock={() => setGateUnlocked(true)} />;
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
        </div>
      </header>

      {/* ── Tab Nav ── */}
      <nav className="backdrop-blur-sm bg-gray-950/60 border-b border-gray-800 px-8">
        <div className="flex gap-1">
          {([
            { id: 'overview',    label: 'Overview' },
            { id: 'users',       label: 'Users' },
            { id: 'session-health', label: 'Session Health' },
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
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatCard label="Total Users"      value={users.length} />
              <StatCard label="Active Licenses"  value={users.filter(u => u.access_enabled && !isExpired(u.expiry_date)).length} sub="trading enabled" />
              <StatCard label="Disabled"         value={users.filter(u => !u.access_enabled).length} sub="view-only access" />
              <StatCard label="Expiring Soon"    value={expiringSoonUsers.length} sub="within 30 days" />
            </div>

            {/* ── Bot Capacity ── */}
            <CapacityPanel
              active={activeSessions.size}
              capacity={users.filter(u => u.access_enabled && !isExpired(u.expiry_date)).length}
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
                  <span className="text-xs text-emerald-500 font-medium">{users.filter(u => u.access_enabled && !isExpired(u.expiry_date)).length} live</span>
                  <span className="text-xs text-gray-700">{users.filter(u => !u.access_enabled).length} idle</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {users.map((u) => (
                    <UserCard
                      key={u.id}
                      user={u}
                      isLive={activeSessions.has(u.id)}
                      onToggle={handleToggleAccess}
                      onAssign={handleAssignLicense}
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
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                {/* ─ Helius ─ */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <p className="text-sm font-semibold text-white">Helius</p>
                      <p className="text-[10px] text-gray-600">Solana RPC · 50 req/s</p>
                    </div>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${rlData?.helius?.connected ? 'bg-emerald-500' : rlData ? 'bg-red-500' : 'bg-gray-700'}`} />
                  </div>
                  <div className="flex justify-center mb-2">
                    <div className="w-40">
                      <SpeedGauge
                        value={rlData?.helius?.latencyMs ?? null}
                        max={500}
                        centerLabel={`${rlData?.helius?.latencyMs}ms`}
                        limitLabel="50 req/s RPC · 10 DAS"
                        ok={rlData?.helius ? (rlData.helius.connected ?? null) : null}
                      />
                    </div>
                  </div>
                  {rlData?.helius?.error && <p className="text-xs text-red-400 mb-2">{String(rlData.helius.error)}</p>}
                  <div className="space-y-1.5 border-t border-gray-800 pt-3">
                    {rlData?.helius?.blockHeight != null && <RlRow label="Block Height" value={Number(rlData.helius.blockHeight).toLocaleString()} />}
                    <RlRow label="sendTransaction" value="5 / sec" />
                    <RlRow label="WebSocket"       value="150 conns · 1,000 subs" />
                    <RlRow label="Monthly Credits" value="10M" />
                  </div>
                </div>

                {/* ─ Jupiter ─ */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <p className="text-sm font-semibold text-white">Jupiter</p>
                      <p className="text-[10px] text-gray-600">Swap API v2 · 10 req/s</p>
                    </div>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${rlData?.jupiter?.connected ? 'bg-emerald-500' : rlData ? 'bg-red-500' : 'bg-gray-700'}`} />
                  </div>
                  <div className="flex justify-center mb-2">
                    <div className="w-40">
                      <SpeedGauge
                        value={rlData?.jupiter?.latencyMs ?? null}
                        max={1000}
                        centerLabel={`${rlData?.jupiter?.latencyMs}ms`}
                        limitLabel="10 req/s · Developer"
                        ok={rlData?.jupiter ? (rlData.jupiter.connected ?? null) : null}
                      />
                    </div>
                  </div>
                  {rlData?.jupiter?.error && <p className="text-xs text-red-400 mb-2">{String(rlData.jupiter.error)}</p>}
                  <div className="space-y-1.5 border-t border-gray-800 pt-3">
                    {rlData?.jupiter?.outUsdc        != null && <RlRow label="SOL→USDC (0.001)" value={`${rlData.jupiter.outUsdc} USDC`} />}
                    {rlData?.jupiter?.priceImpactPct != null && <RlRow label="Price Impact"    value={`${rlData.jupiter.priceImpactPct}%`} />}
                    {rlData?.jupiter?.router         != null && <RlRow label="Router"          value={String(rlData.jupiter.router)} />}
                    <RlRow label="/execute limit" value="100 RPS" />
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
                  <StatCard label="Live Users" value={sessionHealth.summary.liveUsers} sub="active or starting" />
                  <StatCard label="Active Sessions" value={sessionHealth.summary.activeSessions} sub="currently trading" />
                  <StatCard label="Ready / Starting" value={sessionHealth.summary.readyOrStartingSessions} sub="queued to run" />
                  <StatCard label="Stopping" value={sessionHealth.summary.stoppingSessions} sub="return flow pending" />
                  <StatCard label="Needs Attention" value={sessionHealth.summary.attentionCount} sub="stale active + stopping + errors" />
                  <StatCard label="Total Sessions" value={sessionHealth.summary.totalSessions} sub={new Date(sessionHealth.generatedAt).toLocaleTimeString('en-US')} />
                </div>

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

                <SizingTable snapshots={sessionHealth.recentSizing} />

                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Live Session Control</p>
                      <p className="text-xs text-gray-600 mt-0.5">Active and pending sessions with direct maintenance stop access.</p>
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
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                      {adminSessions.map((session) => {
                        const realizedPnl = getAdminSessionRealizedPnl(session);
                        const positionLabel = getAdminSessionPositionLabel(session);
                        const isStopping = session.status === 'stopping';

                        return (
                          <div key={session.id} className="rounded-lg border border-gray-800 bg-gray-950/70 px-4 py-4 space-y-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-sm font-medium text-white">{session.username}</p>
                                <p className="text-[11px] text-gray-600">{session.id.slice(0, 8)} · {session.status.replace(/_/g, ' ')}</p>
                              </div>
                              <button
                                onClick={() => void handleForceStopSession(session.id)}
                                disabled={isStopping || forceStoppingSessionId === session.id}
                                className="rounded-md border border-red-700/50 bg-red-950/40 px-3 py-1.5 text-xs text-red-200 transition hover:bg-red-900/50 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {forceStoppingSessionId === session.id ? 'Stopping…' : isStopping ? 'Stopping' : 'Force Stop'}
                              </button>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <SizingMetric label="Position" value={positionLabel} />
                              <SizingMetric label="Balance" value={lamportsToSolString(getAdminSessionBalanceLamports(session))} />
                              <SizingMetric label="Realized PnL" value={formatSignedUsd(realizedPnl)} />
                              <SizingMetric label="Started" value={formatDateTime(session.started_at)} />
                            </div>

                            <div className="space-y-1 text-[11px] text-gray-500">
                              <div className="flex items-center justify-between gap-3">
                                <span>requested</span>
                                <span className="text-gray-300">{formatDateTime(session.requested_at)}</span>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <span>session wallet</span>
                                <span className="font-mono text-gray-300">{shortWallet(session.session_wallet)}</span>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <span>owner wallet</span>
                                <span className="font-mono text-gray-300">{shortWallet(session.owner_wallet)}</span>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <span>stop reason</span>
                                <span className="text-gray-300">{session.stop_reason ? session.stop_reason.replace(/_/g, ' ') : '—'}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
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
      </main>

      {/* ── Add User Modal ── */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-7 w-full max-w-md shadow-2xl">
            <h2 className="text-base font-semibold text-white mb-5">Add New User</h2>
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
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formBusy}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
                >
                  {formBusy ? 'Creating…' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
