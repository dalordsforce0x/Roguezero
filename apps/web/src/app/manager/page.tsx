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

const formatExpiry = (iso: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

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
    if (phase === 'ready') void loadSessions();
  }, [phase, loadSessions]);

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

  return (
    <div
      className="flex min-h-screen flex-col bg-cover bg-center text-white"
      style={{ backgroundImage: "url('/media/roguezerobg.png')" }}
    >
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-cyan-200/15 bg-slate-950/70 px-6 py-3 backdrop-blur">
        <a href="/" className="flex items-center gap-3 transition hover:opacity-80" title="Back to RogueZero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/rz-logo.png" alt="RogueZero" className="h-10 w-auto" />
          <span className="text-[10px] uppercase tracking-[0.28em] text-cyan-300">access manage</span>
        </a>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-sm font-semibold text-emerald-400">{overview?.manager.name ?? 'Manager'}</div>
            <div className="font-mono text-[11px] text-cyan-200/70">{overview?.manager.maskedKey ?? '—'}</div>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-cyan-100 transition hover:bg-black/60"
          >
            sign out
          </button>
        </div>
      </header>

      {/* ── Body: two panes ────────────────────────────────────────── */}
      <main className="flex flex-1 gap-4 overflow-hidden p-4">
        {/* LEFT: groups + bot tiles */}
        <aside className="flex w-85 shrink-0 flex-col overflow-y-auto rounded-xl border border-cyan-200/15 bg-slate-950/55 p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[10px] uppercase tracking-[0.22em] text-cyan-300/70">access manage</span>
            <span className="text-[10px] text-cyan-300/50">
              {overview?.groups.length ?? 0} groups · {overview?.users.length ?? 0} bots
            </span>
          </div>

          <div className="space-y-4">
            {(overview?.groups ?? []).map((group) => {
              const groupUsers = (overview?.users ?? []).filter((u) => u.groupId === group.id);
              return (
                <div key={group.id}>
                  <div className="mb-2 flex items-center justify-between px-1">
                    <span className="text-xs font-semibold text-cyan-100">{group.name}</span>
                    <span className="text-[10px] text-cyan-300/55">{groupUsers.length}/{group.botLimit}</span>
                  </div>
                  {groupUsers.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-cyan-100/40">
                      no bots in this group
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {groupUsers.map((user) => {
                        const session = sessionByUser.get(user.id);
                        const live = LIVE_STATUSES.has(session?.status ?? '');
                        const selected = user.id === selectedUserId;
                        return (
                          <button
                            key={user.id}
                            type="button"
                            onClick={() => setSelectedUserId(user.id)}
                            className={`group flex flex-col overflow-hidden rounded-lg border bg-black/40 text-left transition ${
                              selected
                                ? 'border-emerald-400 shadow-[0_0_18px_rgba(16,185,129,0.25)]'
                                : 'border-white/10 hover:border-cyan-300/40'
                            }`}
                          >
                            {/* tile thumbnail = controller screen preview */}
                            <div className="relative flex h-16 items-center justify-center bg-linear-to-br from-slate-800/60 to-slate-950/60">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src="/rz-logo.png" alt="" className="h-7 w-auto opacity-30" />
                              <span
                                className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full ${
                                  live ? 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)]' : 'bg-gray-600'
                                }`}
                              />
                            </div>
                            <div className="px-2 py-1.5">
                              <div className="truncate text-[11px] font-medium text-white">{user.username}</div>
                              <div className={`text-[9px] uppercase tracking-wider ${live ? 'text-emerald-400' : 'text-gray-500'}`}>
                                {session?.status ?? 'idle'}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {(overview?.groups.length ?? 0) === 0 && (
              <div className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-xs text-cyan-100/40">
                no groups assigned to this manager
              </div>
            )}
          </div>
        </aside>

        {/* RIGHT: device + info + chart */}
        <section className="flex flex-1 flex-col gap-4 overflow-y-auto">
          {!selectedUser ? (
            <div className="flex flex-1 items-center justify-center rounded-xl border border-cyan-200/15 bg-slate-950/45 text-sm text-cyan-100/50">
              select a bot to view its console
            </div>
          ) : (
            <>
              <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
                {/* QUICK VIEW device */}
                <div className="flex flex-col rounded-xl border border-cyan-200/15 bg-slate-950/55 p-3">
                  <div className="mb-2 flex items-center justify-between px-1">
                    <span className="text-[10px] uppercase tracking-[0.22em] text-cyan-300/70">quick view</span>
                    <span className="font-mono text-[10px] text-cyan-200/60">{selectedUser.username}</span>
                  </div>
                  <div className="relative flex-1 overflow-hidden rounded-lg border border-white/10 bg-black/50">
                    {sessionLive ? (
                      <iframe
                        title={`bot-${selectedUser.id}`}
                        src="/"
                        className="h-full w-full"
                      />
                    ) : (
                      <div className="flex h-full min-h-70 flex-col items-center justify-center gap-3 text-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/rz-logo.png" alt="" className="h-12 w-auto opacity-25" />
                        <div className="text-xs text-cyan-100/55">embedded bot console</div>
                        <button
                          type="button"
                          onClick={() => setSessionLive(true)}
                          className="rounded-lg border border-cyan-300/25 bg-cyan-500/10 px-4 py-2 text-xs text-cyan-100 transition hover:bg-cyan-500/18"
                        >
                          go to session (sign in required)
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Info block */}
                <div className="flex flex-col gap-3 rounded-xl border border-cyan-200/15 bg-slate-950/55 p-4">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-cyan-300/70">bot info</div>

                  <InfoRow label="Username" value={selectedUser.username} />
                  <InfoRow label="Owner wallet" value={shortWallet(selectedUser.walletAddress)} mono />
                  <InfoRow
                    label="Status"
                    value={
                      <span className={LIVE_STATUSES.has(selectedSession?.status ?? '') ? 'text-emerald-400' : 'text-gray-400'}>
                        {selectedSession?.status ?? 'idle'}
                      </span>
                    }
                  />
                  <InfoRow
                    label="Solscan"
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

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <Stat label="Realized PnL" value={formatUsd(selectedSession?.funding?.realizedPnlUsd)} positive={(selectedSession?.funding?.realizedPnlUsd ?? 0) >= 0} />
                    <Stat label="Unrealized" value={formatUsd(selectedSession?.funding?.unrealizedPnlUsd)} positive={(selectedSession?.funding?.unrealizedPnlUsd ?? 0) >= 0} />
                    <Stat label="Fees captured" value={formatUsd(selectedSession?.funding?.capturedFeesUsd)} positive />
                    <Stat label="Open positions" value={String(selectedPositions.length)} />
                  </div>

                  {selectedPositions.length > 0 && (
                    <div className="space-y-1 rounded-lg border border-white/5 bg-black/30 p-2">
                      {selectedPositions.slice(0, 4).map((pos, i) => (
                        <div key={i} className="flex items-center justify-between text-[11px] text-cyan-100/75">
                          <span>{pos.positionSymbol ?? shortWallet(pos.positionMint)}</span>
                          <span className="font-mono">{pos.lastMarkedPriceUsd != null ? `$${pos.lastMarkedPriceUsd.toFixed(4)}` : '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-auto border-t border-white/10 pt-2">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-cyan-300/70">settings</div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-cyan-100/75">
                      <span>Profit handling</span>
                      <span className="text-cyan-200">
                        {selectedSession?.userControl?.profitHandling?.mode === 'compound' ? 'compound' : 'send to owner'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-cyan-100/75">
                      <span>Payout token</span>
                      <span className="text-cyan-200">{selectedSession?.userControl?.profitHandling?.payoutToken ?? '—'}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-cyan-100/75">
                      <span>License expiry</span>
                      <span className="text-cyan-200">{formatExpiry(selectedUser.expiryDate)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* PnL chart */}
              <div className="rounded-xl border border-cyan-200/15 bg-slate-950/55 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-[0.22em] text-cyan-300/70">pnl</span>
                  <span className={`text-sm font-semibold ${(selectedSession?.funding?.realizedPnlUsd ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-300'}`}>
                    {formatUsd(selectedSession?.funding?.realizedPnlUsd)}
                  </span>
                </div>
                <div className="flex h-28 items-center justify-center rounded-lg border border-white/5 bg-black/30 text-[11px] text-cyan-100/40">
                  pnl chart
                </div>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-cyan-100/55">{label}</span>
      <span className={`text-white ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function Stat({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="rounded-lg border border-white/5 bg-black/30 p-2">
      <div className="text-[9px] uppercase tracking-wider text-cyan-300/55">{label}</div>
      <div className={`text-sm font-semibold ${positive === undefined ? 'text-white' : positive ? 'text-emerald-400' : 'text-red-300'}`}>
        {value}
      </div>
    </div>
  );
}
