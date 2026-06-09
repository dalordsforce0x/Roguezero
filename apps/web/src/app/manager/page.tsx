'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type ManagerGroup = {
  id: string;
  name: string;
  botLimit: number;
};

type ManagerUser = {
  id: string;
  username: string;
  walletAddress: string;
  groupId: string | null;
  groupName: string | null;
  accessEnabled: boolean;
  expiryDate: string | null;
  maxWalletUsd: number;
};

type ManagerInfo = {
  id: string;
  name: string;
  expiryDate: string | null;
  accessEnabled: boolean;
  maskedKey: string | null;
};

type SessionPosition = {
  status?: string;
  positionMint?: string | null;
  positionSymbol?: string | null;
  entryPriceUsd?: number | null;
  lastMarkedPriceUsd?: number | null;
};

type ManagerSession = {
  id: string;
  userId?: string;
  status?: string;
  ownerWallet?: string;
  sessionWallet?: string;
  userControl?: {
    profitHandling?: {
      mode?: 'send_to_owner' | 'compound';
      payoutToken?: 'SOL' | 'USDC';
    };
  };
  funding?: {
    realizedPnlUsd?: number;
    unrealizedPnlUsd?: number;
    capturedFeesUsd?: number;
    currentBalanceAtomic?: string;
    fundingTokenSymbol?: string;
  };
  serviceControl?: {
    positionsState?: { positions?: Record<string, SessionPosition> };
    positionState?: SessionPosition;
    rotationState?: { activeStrategy?: string };
    healthState?: {
      state?: string;
      severity?: string;
      reason?: string | null;
      detail?: string | null;
      updatedAt?: string;
    };
    lastSignal?: {
      at?: string;
      status?: string;
      regime?: string | null;
      momentumBps?: number | null;
      signal?: string | null;
      strategy?: string | null;
    };
    lastTradeGate?: {
      at?: string;
      decision?: string;
      reason?: string;
      expectedEdgeBps?: number | null;
      estimatedCostBps?: number | null;
    };
  };
};

type OverviewState = {
  manager: ManagerInfo;
  groups: ManagerGroup[];
  users: ManagerUser[];
};

const LIVE_STATUSES = new Set(['active', 'starting', 'ready', 'stopping']);

const shortWallet = (wallet: string | undefined | null) => (
  wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : '—'
);

const formatUsd = (value: number | undefined | null) => (
  typeof value === 'number' && Number.isFinite(value)
    ? `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`
    : '—'
);

const openPositionsOf = (session: ManagerSession | undefined): SessionPosition[] => {
  if (!session?.serviceControl) return [];
  const fromMap = Object.values(session.serviceControl.positionsState?.positions ?? {})
    .filter((p) => p.status && p.status !== 'flat');
  if (fromMap.length > 0) return fromMap;
  const single = session.serviceControl.positionState;
  return single && single.status && single.status !== 'flat' ? [single] : [];
};

export default function ManagerPage() {
  const [phase, setPhase] = useState<'checking' | 'auth' | 'ready'>('checking');
  const [managementKey, setManagementKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [overview, setOverview] = useState<OverviewState | null>(null);
  const [sessions, setSessions] = useState<ManagerSession[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [sessionLive, setSessionLive] = useState(false);

  const loadOverview = useCallback(async () => {
    const res = await fetch('/api/manager/overview', { cache: 'no-store' });
    if (res.status === 401) {
      setPhase('auth');
      return false;
    }
    if (!res.ok) {
      setError('Failed to load manager overview');
      return false;
    }
    const data = await res.json() as OverviewState;
    setOverview(data);
    setPhase('ready');
    return true;
  }, []);

  const loadSessions = useCallback(async () => {
    const res = await fetch('/api/manager/sessions', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json() as { sessions?: ManagerSession[] };
    setSessions(data.sessions ?? []);
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (phase !== 'ready') return;
    void loadSessions();
    // Poll live data every 10s so the manager console reflects current state.
    const overviewTimer = setInterval(() => { void loadOverview(); }, 30_000);
    const sessionTimer = setInterval(() => { void loadSessions(); }, 10_000);
    return () => {
      clearInterval(overviewTimer);
      clearInterval(sessionTimer);
    };
  }, [phase, loadSessions, loadOverview]);

  const submitKey = useCallback(async () => {
    if (!managementKey.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/manager/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ managementKey: managementKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { details?: string; error?: string }).details ?? (data as { error?: string }).error ?? 'invalid management key');
        return;
      }
      setManagementKey('');
      await loadOverview();
    } catch {
      setError('network error');
    } finally {
      setSubmitting(false);
    }
  }, [managementKey, loadOverview]);

  const logout = useCallback(async () => {
    await fetch('/api/manager/logout', { method: 'POST' });
    setOverview(null);
    setSessions([]);
    setSelectedUserId(null);
    setSessionLive(false);
    setPhase('auth');
  }, []);

  // Latest session per user (sessions arrive newest-first from the API).
  const sessionByUser = useMemo(() => {
    const map = new Map<string, ManagerSession>();
    for (const session of sessions) {
      const key = session.userId ?? '';
      if (!map.has(key)) map.set(key, session);
    }
    return map;
  }, [sessions]);

  // Auto-select the first bot once data is present.
  useEffect(() => {
    if (!selectedUserId && overview && overview.users.length > 0) {
      setSelectedUserId(overview.users[0].id);
    }
  }, [overview, selectedUserId]);

  // Reset the embedded device whenever the selected bot changes.
  useEffect(() => {
    setSessionLive(false);
  }, [selectedUserId]);

  const selectedUser = overview?.users.find((u) => u.id === selectedUserId) ?? null;
  const selectedSession = selectedUserId ? sessionByUser.get(selectedUserId) : undefined;
  const selectedPositions = openPositionsOf(selectedSession);

  if (phase === 'checking') {
    return (
      <div className="min-h-screen bg-black text-cyan-200 flex items-center justify-center text-sm uppercase tracking-[0.25em]">
        loading
      </div>
    );
  }

  if (phase === 'auth') {
    return (
      <div
        className="min-h-screen bg-cover bg-center text-white flex items-center justify-center p-6"
        style={{ backgroundImage: "url('/media/roguezerobg.png')" }}
      >
        <div className="w-full max-w-sm rounded-2xl border border-cyan-200/20 bg-slate-950/88 p-6 shadow-[0_0_35px_rgba(34,211,238,0.08)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/rz-logo.png" alt="RogueZero" className="h-12 w-auto mb-4" />
          <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-300">access manager</div>
          <div className="mt-2 text-lg text-white">enter management key</div>
          <div className="mt-1 text-xs text-cyan-100/70">manage every bot in your assigned groups</div>
          <input
            type="password"
            value={managementKey}
            onChange={(event) => {
              setManagementKey(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !submitting) void submitKey();
            }}
            className="mt-4 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/40"
            placeholder="management key"
            autoFocus
          />
          {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
          <button
            type="button"
            onClick={() => void submitKey()}
            disabled={submitting}
            className="mt-4 w-full rounded-lg border border-cyan-300/25 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100 transition hover:bg-cyan-500/18 disabled:opacity-50"
          >
            {submitting ? 'verifying…' : 'unlock manager console'}
          </button>
        </div>
      </div>
    );
  }

  const settingsMode = selectedSession?.userControl?.profitHandling?.mode === 'compound' ? 'compound' : 'send to owner';
  const payoutToken = selectedSession?.userControl?.profitHandling?.payoutToken ?? 'SOL';
  const realized = selectedSession?.funding?.realizedPnlUsd;

  return (
    <div
      className="flex min-h-screen flex-col text-white"
      style={{ background: 'radial-gradient(circle at 50% -10%, #515151 0%, #343434 55%, #232323 100%)' }}
    >
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="grid grid-cols-[1fr_auto_1fr] items-start gap-4 px-8 pt-5 pb-3">
        {/* left: logo back to main UI */}
        <a href="/" className="flex items-center gap-3 justify-self-start transition hover:opacity-80" title="Back to RogueZero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/rz-logo.png" alt="RogueZero" className="h-12 w-auto" />
        </a>

        {/* center: Access Manage */}
        <div className="self-center justify-self-center text-lg font-medium tracking-wide text-white underline underline-offset-4">
          Access Manage
        </div>

        {/* right: sign-out pill + manager / access key */}
        <div className="flex items-start justify-end gap-5 justify-self-end">
          <button
            type="button"
            onClick={() => void logout()}
            className="flex items-center gap-2 rounded-full bg-linear-to-b from-sky-400 to-blue-600 px-4 py-1.5 text-sm font-semibold text-white shadow-[0_2px_10px_rgba(37,99,235,0.45)] transition hover:brightness-110"
            title="Sign out of the manager console"
          >
            SIGN OUT
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/25 text-[11px]">&#128100;</span>
          </button>
          <div className="space-y-1 text-sm">
            <div className="flex items-baseline gap-2">
              <span className="text-white">Manager:</span>
              <span className="min-w-45 border-b border-white/60 pb-0.5 font-medium text-emerald-300">
                {overview?.manager.name ?? '—'}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-white">Access Key:</span>
              <span className="min-w-45 border-b border-white/60 pb-0.5 font-mono text-cyan-200/80">
                {overview?.manager.maskedKey ?? '—'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Body: gallery | divider | detail ───────────────────────── */}
      <main className="flex flex-1 gap-6 overflow-hidden px-8 pb-6">
        {/* LEFT: wide controller-tile gallery */}
        <section className="flex-1 overflow-y-auto pr-2">
          <div className="space-y-7">
            {(overview?.groups ?? []).map((group) => {
              const groupUsers = (overview?.users ?? []).filter((u) => u.groupId === group.id);
              return (
                <div key={group.id}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="text-lg font-medium text-white underline underline-offset-4">
                      {group.name}
                    </span>
                    {groupUsers.length > 6 && (
                      <select
                        value={groupUsers.some((u) => u.id === selectedUserId) ? selectedUserId ?? '' : ''}
                        onChange={(e) => e.target.value && setSelectedUserId(e.target.value)}
                        className="max-w-56 shrink-0 rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs text-white/80 outline-none focus:border-lime-400/50"
                      >
                        <option value="">jump to bot… ({groupUsers.length})</option>
                        {groupUsers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.username} — {sessionByUser.get(u.id)?.status ?? 'idle'}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {groupUsers.length === 0 ? (
                    <div className="text-sm text-white/35">no bots in this group</div>
                  ) : (
                    <div className="flex flex-nowrap gap-4 overflow-x-auto pb-2">
                      {groupUsers.map((user) => {
                        const session = sessionByUser.get(user.id);
                        const live = LIVE_STATUSES.has(session?.status ?? '');
                        const selected = user.id === selectedUserId;
                        return (
                          <button
                            key={user.id}
                            type="button"
                            onClick={() => setSelectedUserId(user.id)}
                            className="group flex w-32 shrink-0 flex-col items-center gap-2"
                          >
                            {/* controller-screen tile = live mini render of the bot screen */}
                            <div
                              className={`relative w-full overflow-hidden rounded-2xl p-1.5 shadow-[0_6px_16px_rgba(0,0,0,0.45)] transition ${
                                selected
                                  ? 'bg-linear-to-b from-lime-300/80 to-lime-600/60 ring-2 ring-lime-400'
                                  : 'bg-linear-to-b from-gray-200/90 to-gray-400/80'
                              }`}
                            >
                              <div className="relative overflow-hidden rounded-xl">
                                <ScaledScreen width={116}>
                                  <BotScreen user={user} session={session} />
                                </ScaledScreen>
                                <span
                                  className={`absolute right-2 top-2 z-10 h-2.5 w-2.5 rounded-full ${
                                    live ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.9)]' : 'bg-gray-600'
                                  }`}
                                />
                              </div>
                            </div>
                            {/* caption */}
                            <span className="w-full truncate text-center text-xs text-lime-400 underline underline-offset-2">
                              {user.username}/ {session?.status ?? 'idle'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {(overview?.groups.length ?? 0) === 0 && (
              <div className="text-sm text-white/40">no groups assigned to this manager</div>
            )}
          </div>
        </section>

        {/* DIVIDER */}
        <div className="my-1 w-2 shrink-0 rounded-full bg-black/80" />

        {/* RIGHT: quick view + info + pnl chart */}
        <section className="flex w-110 shrink-0 flex-col gap-5 overflow-y-auto pr-1">
          {!selectedUser ? (
            <div className="flex flex-1 items-center justify-center text-sm text-white/45">
              select a bot to view its console
            </div>
          ) : (
            <>
              <div className="text-center text-lg font-medium text-white underline underline-offset-4">QUiCK VIEW</div>

              {/* device frame */}
              <div className="rounded-4xl bg-linear-to-b from-gray-100 to-gray-400 p-3 shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
                <div className="overflow-hidden rounded-[1.4rem] bg-black">
                  {sessionLive ? (
                    <iframe title={`bot-${selectedUser.id}`} src="/" className="h-80 w-full" />
                  ) : (
                    <ScaledScreen width={400}>
                      <BotScreen user={selectedUser} session={selectedSession} />
                    </ScaledScreen>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSessionLive(true)}
                  className="mx-auto mt-2 block text-sm text-white underline underline-offset-2 transition hover:text-cyan-200"
                >
                  go to session (sign in required)
                </button>
              </div>

              {/* info block */}
              <div className="space-y-1.5 text-center text-sm">
                <InfoLine label="Username" value={selectedUser.username} />
                <InfoLine label="license key" value={shortWallet(selectedUser.walletAddress)} mono />
                <InfoLine
                  label="Status"
                  value={
                    <span className={LIVE_STATUSES.has(selectedSession?.status ?? '') ? 'text-emerald-400' : 'text-gray-300'}>
                      {selectedSession?.status ?? 'idle'}
                    </span>
                  }
                />
                <InfoLine
                  label="Solscan Url"
                  value={
                    selectedSession?.sessionWallet ? (
                      <a
                        href={`https://solscan.io/account/${selectedSession.sessionWallet}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-cyan-300 hover:text-cyan-200"
                      >
                        {shortWallet(selectedSession.sessionWallet)}
                      </a>
                    ) : '—'
                  }
                />
                <InfoLine
                  label="PnL"
                  value={
                    <span className={(realized ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-300'}>
                      {formatUsd(realized)}
                    </span>
                  }
                />
                <InfoLine label="Open Positions" value={String(selectedPositions.length)} />
                <div className="pt-1 text-white">
                  <span className="underline underline-offset-2">Settings</span>
                  <span className="text-white/80">: take profits ({payoutToken.toLowerCase()})</span>
                </div>
                <div className="text-white/80">
                  {settingsMode === 'compound' ? 'compound' : 'send to owner'} /{' '}
                  <span className="text-emerald-400">{settingsMode === 'compound' ? 'YES' : 'NO'}</span>
                </div>
              </div>

              {/* pnl chart */}
              <div className="rounded-md border border-cyan-300/30 bg-[#0a1018] p-2">
                <svg viewBox="0 0 300 110" preserveAspectRatio="none" className="h-28 w-full">
                  <defs>
                    <pattern id="grid" width="20" height="18" patternUnits="userSpaceOnUse">
                      <path d="M20 0H0V18" fill="none" stroke="rgba(56,189,248,0.12)" strokeWidth="1" />
                    </pattern>
                  </defs>
                  <rect width="300" height="110" fill="url(#grid)" />
                  <polyline
                    fill="none"
                    stroke="#7dd3fc"
                    strokeWidth="1.6"
                    points="6,96 30,92 36,70 54,74 66,46 78,58 96,30 108,44 126,40 150,58 168,52 186,66 204,58 222,40 240,46 258,22 276,30 294,8"
                  />
                </svg>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function InfoLine({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-center gap-2">
      <span className="text-white underline underline-offset-2">{label}:</span>
      <span className={`min-w-37.5 border-b border-white/40 pb-0.5 text-left text-white ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}

// Base design size for the controller screen; the gallery tile and the device
// frame both render this and scale it to their target width (whole-screen view).
const SCREEN_W = 360;
const SCREEN_H = 270;

function ScaledScreen({ width, children }: { width: number; children: React.ReactNode }) {
  const scale = width / SCREEN_W;
  return (
    <div style={{ width, height: SCREEN_H * scale }} className="overflow-hidden">
      <div
        style={{ width: SCREEN_W, height: SCREEN_H, transform: `scale(${scale})`, transformOrigin: 'top left' }}
      >
        {children}
      </div>
    </div>
  );
}

const HEALTH_LABELS: Record<string, { text: string; tone: string }> = {
  active_trading: { text: 'ACTIVE · TRADING', tone: 'text-emerald-400' },
  waiting_market: { text: 'WAITING · MARKET', tone: 'text-cyan-300' },
  blocked: { text: 'BLOCKED', tone: 'text-amber-400' },
  exit_blocked: { text: 'EXIT BLOCKED', tone: 'text-amber-400' },
  gas_danger: { text: 'GAS DANGER', tone: 'text-red-400' },
  recovery_required: { text: 'RECOVERY', tone: 'text-red-400' },
  stopping: { text: 'STOPPING', tone: 'text-red-300' },
  stopped: { text: 'STOPPED', tone: 'text-gray-400' },
  error: { text: 'ERROR', tone: 'text-red-400' },
};

const tidy = (raw: string | null | undefined) =>
  raw ? raw.replace(/_/g, ' ') : null;

const fmtUsdScreen = (v: number | undefined | null) =>
  typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}` : '$0.00';

/**
 * Live mini-render of the bot's controller screen. Driven entirely by the
 * session payload, so it reflects true current state (status, signal, position,
 * PnL, gate decision). Rendered at a fixed SCREEN_W×SCREEN_H and scaled by the
 * caller for tiles vs the device frame.
 */
function BotScreen({ user, session }: { user: ManagerUser; session: ManagerSession | undefined }) {
  const svc = session?.serviceControl;
  const status = session?.status ?? 'idle';
  const live = LIVE_STATUSES.has(status);
  const health = svc?.healthState?.state ?? (live ? 'waiting_market' : 'stopped');
  const healthMeta = HEALTH_LABELS[health] ?? { text: status.toUpperCase(), tone: 'text-cyan-300' };

  const positions = openPositionsOf(session);
  const pos = positions[0];
  const strategy = svc?.rotationState?.activeStrategy ?? svc?.lastSignal?.strategy ?? null;
  const signal = svc?.lastSignal;
  const gate = svc?.lastTradeGate;

  const realized = session?.funding?.realizedPnlUsd ?? 0;
  const unrealized = session?.funding?.unrealizedPnlUsd ?? 0;

  return (
    <div
      style={{ width: SCREEN_W, height: SCREEN_H }}
      className="flex flex-col bg-[#070d16] font-mono text-cyan-100"
    >
      {/* tab bar */}
      <div className="flex items-center justify-between border-b border-cyan-300/15 bg-black/40 px-3 py-1.5 text-[10px] uppercase tracking-widest">
        <span className="flex gap-2">
          <span className={live ? 'text-emerald-400' : 'text-white/35'}>start</span>
          <span className={status === 'stopping' || status === 'stopped' ? 'text-red-400' : 'text-white/35'}>stop</span>
        </span>
        <span className="flex gap-2">
          <span className="text-cyan-300">activity</span>
          <span className="text-white/35">dashboard</span>
        </span>
      </div>

      {/* status row */}
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="truncate text-[11px] text-white">{user.username}</span>
        <span className={`text-[10px] font-semibold ${healthMeta.tone}`}>{healthMeta.text}</span>
      </div>

      {/* strategy / signal */}
      <div className="px-3 pt-1 text-[9px] text-cyan-200/70">
        <div>strategy: <span className="text-cyan-100">{tidy(strategy) ?? '—'}</span></div>
        <div>
          signal: <span className="text-cyan-100">{tidy(signal?.signal) ?? tidy(signal?.regime) ?? 'scanning'}</span>
          {typeof signal?.momentumBps === 'number' && (
            <span className="text-white/45"> · {signal.momentumBps >= 0 ? '+' : ''}{signal.momentumBps}bps</span>
          )}
        </div>
      </div>

      {/* position panel */}
      <div className="mx-3 mt-2 flex-1 rounded border border-cyan-300/15 bg-black/30 p-2 text-[9px]">
        {pos ? (
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-cyan-200/70">position</span>
              <span className="text-emerald-300">{pos.positionSymbol ?? shortWallet(pos.positionMint)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-cyan-200/70">entry</span>
              <span>{pos.entryPriceUsd != null ? `$${pos.entryPriceUsd.toFixed(5)}` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-cyan-200/70">mark</span>
              <span>{pos.lastMarkedPriceUsd != null ? `$${pos.lastMarkedPriceUsd.toFixed(5)}` : '—'}</span>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-cyan-200/55">
            <span>flat · no open position</span>
            {gate?.reason && (
              <span className="text-[8px] text-amber-400/80">gate: {tidy(gate.reason)}</span>
            )}
          </div>
        )}
      </div>

      {/* pnl footer */}
      <div className="flex items-center justify-between border-t border-cyan-300/15 px-3 py-2 text-[10px]">
        <span>
          <span className="text-cyan-200/60">realized </span>
          <span className={realized >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtUsdScreen(realized)}</span>
        </span>
        <span>
          <span className="text-cyan-200/60">unreal </span>
          <span className={unrealized >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtUsdScreen(unrealized)}</span>
        </span>
      </div>
    </div>
  );
}

