// GET /api/rate-limits/helius
// Live Helius RPC health check via getBlockHeight. Logs latency + block height.

import { NextResponse } from 'next/server';

export async function GET() {
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) {
    return NextResponse.json(
      { connected: false, error: 'HELIUS_RPC_URL must be set on the admin service' },
      { status: 500 },
    );
  }

  const start = Date.now();
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
        name:              'Developer',
        rpcRateLimit:      '50 req/s',
        dasRateLimit:      '10 req/s',
        monthlyCredits:    '10M',
        sendTransaction:   '5 / sec',
        wsConcurrent:      '150 connections',
        wsSubscriptions:   '1,000 / conn',
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
