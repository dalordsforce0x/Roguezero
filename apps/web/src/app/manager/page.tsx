'use client';

import { useCallback, useEffect, useState } from 'react';

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
};

type ManagerSession = {
  id: string;
  userId?: string;
  status?: string;
  ownerWallet?: string;
  sessionWallet?: string;
  funding?: { realizedPnlUsd?: number; capturedFeesUsd?: number };
};

type OverviewState = {
  manager: ManagerInfo;
  groups: ManagerGroup[];
  users: ManagerUser[];
};

const shortWallet = (wallet: string | undefined) => (
  wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : '—'
);

export default function ManagerPage() {
  const [phase, setPhase] = useState<'checking' | 'auth' | 'ready'>('checking');
  const [managementKey, setManagementKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [overview, setOverview] = useState<OverviewState | null>(null);
  const [sessions, setSessions] = useState<ManagerSession[]>([]);

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
    setPhase('auth');
  }, []);

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

  const sessionsByUser = new Map<string, ManagerSession[]>();
  for (const session of sessions) {
    const key = session.userId ?? '';
    const list = sessionsByUser.get(key) ?? [];
    list.push(session);
    sessionsByUser.set(key, list);
  }

  return (
    <div
      className="min-h-screen bg-cover bg-center text-white"
      style={{ backgroundImage: "url('/media/roguezerobg.png')" }}
    >
      <header className="px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/rz-logo.png" alt="RogueZero" className="h-12 w-auto" />
          <span className="text-[10px] uppercase tracking-[0.28em] text-cyan-300">access manager</span>
        </div>
        <div className="flex items-center gap-3">
          {overview && (
            <span className="text-xs font-semibold text-emerald-400">{overview.manager.name}</span>
          )}
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-1 text-xs text-cyan-100 transition hover:bg-black/60"
          >
            sign out
          </button>
        </div>
      </header>

      <main className="px-6 pb-10 space-y-6">
        <section className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-cyan-200/15 bg-slate-950/50 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">groups</div>
            <div className="mt-1 text-2xl font-semibold">{overview?.groups.length ?? 0}</div>
          </div>
          <div className="rounded-xl border border-cyan-200/15 bg-slate-950/50 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">bots</div>
            <div className="mt-1 text-2xl font-semibold">{overview?.users.length ?? 0}</div>
          </div>
          <div className="rounded-xl border border-cyan-200/15 bg-slate-950/50 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">live sessions</div>
            <div className="mt-1 text-2xl font-semibold">{sessions.length}</div>
          </div>
        </section>

        {(overview?.groups ?? []).map((group) => {
          const groupUsers = (overview?.users ?? []).filter((u) => u.groupId === group.id);
          return (
            <section key={group.id} className="rounded-xl border border-cyan-200/15 bg-slate-950/45 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-cyan-100">{group.name}</div>
                <div className="text-xs text-cyan-300/60">{groupUsers.length} / {group.botLimit} bots</div>
              </div>
              <div className="mt-3 space-y-2">
                {groupUsers.length === 0 && (
                  <div className="text-xs text-cyan-100/50">no bots in this group yet</div>
                )}
                {groupUsers.map((user) => {
                  const userSessions = sessionsByUser.get(user.id) ?? [];
                  return (
                    <div key={user.id} className="rounded-lg border border-white/5 bg-black/30 p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-white">{user.username}</span>
                          <span className="font-mono text-[11px] text-cyan-300/70">{shortWallet(user.walletAddress)}</span>
                        </div>
                        <span className={`text-[10px] uppercase tracking-wider ${user.accessEnabled ? 'text-emerald-400' : 'text-red-300'}`}>
                          {user.accessEnabled ? 'enabled' : 'disabled'}
                        </span>
                      </div>
                      {userSessions.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {userSessions.map((session) => (
                            <div key={session.id} className="flex items-center justify-between text-[11px] text-cyan-100/70">
                              <span className="font-mono">{session.id.slice(0, 8)}</span>
                              <span className="uppercase tracking-wider">{session.status ?? 'unknown'}</span>
                              <span>
                                pnl {typeof session.funding?.realizedPnlUsd === 'number' ? `$${session.funding.realizedPnlUsd.toFixed(2)}` : '—'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
