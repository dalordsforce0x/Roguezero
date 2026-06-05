// GET /api/rate-limits/helius
// Live Helius RPC health check via getBlockHeight. Logs latency + block height.

import { NextResponse } from 'next/server';

export async function GET() {
  // Mirror worker behavior (packages/runtime-config getHeliusRpcUrl):
  // when HELIUS_GATEKEEPER_ENABLED, use the beta gatekeeper URL with HELIUS_API_KEY;
  // otherwise use the raw HELIUS_RPC_URL.
  const gatekeeperEnabled = ['1', 'true', 'yes', 'on'].includes(
    (process.env.HELIUS_GATEKEEPER_ENABLED ?? '').toLowerCase().trim(),
  );
  const apiKey = process.env.HELIUS_API_KEY;
  const rawRpc = process.env.HELIUS_RPC_URL;
  const rpcUrl = gatekeeperEnabled && apiKey
    ? `https://beta.helius-rpc.com/?api-key=${apiKey}`
    : rawRpc;
  if (!rpcUrl) {
    return NextResponse.json(
      { connected: false, error: 'HELIUS_RPC_URL (or HELIUS_API_KEY with gatekeeper) must be set on the admin service' },
      { status: 500 },
    );
  }

  const start = Date.now();
  const providerCap = {
    rpcRps: 200,
    dasRps: 50,
    sendTransactionTps: 50,
  } as const;
  const fleetTarget = {
    rpcRps: Number(process.env.HELIUS_RPC_RPS ?? 180),
    rpcBurst: Number(process.env.HELIUS_RPC_BURST ?? Math.min(20, Number(process.env.HELIUS_RPC_RPS ?? 180))),
    dasRps: Number(process.env.HELIUS_DAS_RPS ?? 45),
    senderTps: Number(process.env.HELIUS_SENDER_TPS ?? 45),
  } as const;
  const monthlyCredits = Number(process.env.HELIUS_MONTHLY_CREDIT_LIMIT ?? 100_000_000);
  const monthlyBudgetEnforced = process.env.HELIUS_MONTHLY_BUDGET_ENFORCE !== 'false';

  try {
    const res = await fetch(rpcUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockHeight' }),
    });
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const text = await res.text();
      console.error('[helius] ✗ RPC test failed %d: %s', res.status, text);
      return NextResponse.json({ connected: false, latencyMs, status: res.status, error: text });
    }

    const data = await res.json() as { result?: number; error?: { message: string } };

    if (data.error) {
      console.error('[helius] ✗ RPC returned error:', data.error.message);
      return NextResponse.json({ connected: false, latencyMs, error: data.error.message });
    }

    const blockHeight = data.result ?? null;

    console.log('[helius] ✓ connected — latency=%dms  blockHeight=%d', latencyMs, blockHeight);

    return NextResponse.json({
      connected:   true,
      latencyMs,
      blockHeight,
      plan: {
        name: 'Business',
        providerCap,
        fleetTarget,
        monthlyCredits,
        monthlyBudgetEnforced,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[helius] ✗ threw:', msg);
    return NextResponse.json(
      { connected: false, latencyMs: Date.now() - start, error: msg },
      { status: 500 },
    );
  }
}
