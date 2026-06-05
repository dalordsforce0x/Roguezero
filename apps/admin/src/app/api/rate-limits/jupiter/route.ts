// GET /api/rate-limits/jupiter
// Live Jupiter Swap API v2 health check — SOL→USDC price-only order (no taker = no tx).
// Uses api.jup.ag/swap/v2 with x-api-key header (new Developer Platform API).

import { NextResponse } from 'next/server';

// 0.001 SOL price check — no taker means quote only, no transaction assembled
const BASE_URL = 'https://api.jup.ag/swap/v2';
const ORDER_PARAMS = new URLSearchParams({
  inputMint:  'So11111111111111111111111111111111111111112',  // SOL
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  amount:     '1000000', // 0.001 SOL in lamports
}).toString();

export async function GET() {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { connected: false, error: 'JUPITER_API_KEY must be set on the admin service' },
      { status: 500 },
    );
  }

  const start = Date.now();
  const providerCap = {
    generalRps: 150,
    executeRps: 100,
    txSubmitRps: 100,
  } as const;
  const fleetTarget = {
    generalRps: Number(process.env.JUPITER_GENERAL_RPS ?? 135),
    generalBurst: Number(process.env.JUPITER_GENERAL_BURST ?? Math.min(20, Number(process.env.JUPITER_GENERAL_RPS ?? 135))),
  } as const;
  const monthlyRequestsBudget = Number(process.env.JUPITER_MONTHLY_REQUEST_LIMIT ?? 500_000_000);
  const monthlyBudgetEnforced = process.env.JUPITER_MONTHLY_BUDGET_ENFORCE === 'true';

  try {
    const res = await fetch(`${BASE_URL}/order?${ORDER_PARAMS}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    });
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const text = await res.text();
      console.error('[jupiter] ✗ /swap/v2/order failed %d: %s', res.status, text);
      return NextResponse.json({ connected: false, latencyMs, status: res.status, error: text });
    }

    const data = await res.json() as {
      outAmount?:      string;
      priceImpactPct?: string;
      router?:         string;
      mode?:           string;
      feeBps?:         number;
    };

    const outUsdc = data.outAmount ? (Number(data.outAmount) / 1e6).toFixed(4) : null;

    console.log(
      '[jupiter] ✓ /swap/v2/order — latency=%dms  outUsdc=%s  impact=%s%%  router=%s  mode=%s',
      latencyMs,
      outUsdc ?? '?',
      data.priceImpactPct ?? '?',
      data.router ?? '?',
      data.mode   ?? '?',
    );

    return NextResponse.json({
      connected:      true,
      latencyMs,
      outUsdc,
      outAmount:      data.outAmount      ?? null,
      priceImpactPct: data.priceImpactPct ?? null,
      router:         data.router         ?? null,
      mode:           data.mode           ?? null,
      feeBps:         data.feeBps         ?? null,
      currentPlan: 'pro',
      plan: {
        name: 'Pro (yearly)',
        providerCap,
        fleetTarget,
        includedCreditsPerYear: 6_000_000_000,
        monthlyRequestsBudget,
        monthlyBudgetEnforced,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[jupiter] ✗ threw:', msg);
    return NextResponse.json(
      { connected: false, latencyMs: Date.now() - start, error: msg },
      { status: 500 },
    );
  }
}
