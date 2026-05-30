import { NextRequest, NextResponse } from 'next/server';
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TTL_SECONDS,
  DEVICE_ID_COOKIE,
  TEMP_GATE_COOKIE,
  buildTrustedUntilIso,
  callInternalApi,
  createOpaqueToken,
  getCookieBaseOptions,
  getOrCreateDeviceId,
  hashAccessValue,
  readCookieValue,
} from '@/lib/accessServer';

type EnrollResponse = {
  ok?: boolean;
  user?: {
    id: string;
    username: string;
    walletAddress: string;
    expiryDate: string | null;
    accessEnabled: boolean;
    duration: string | null;
    gatedAccessEnrolledAt: string | null;
    licenseKeyRevealedAt: string | null;
  };
  firstReveal?: boolean;
  licenseKey?: string | null;
  liveSessionCount?: number;
  error?: string;
  details?: string;
};

export async function POST(request: NextRequest) {
  try {
    const hasTempGate = Boolean(readCookieValue(request, TEMP_GATE_COOKIE));
    const existingAccess = Boolean(readCookieValue(request, ACCESS_TOKEN_COOKIE));

    if (!hasTempGate && !existingAccess) {
      return NextResponse.json({ error: 'temporary gate required before enrollment' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as { wallet?: unknown };
    const wallet = typeof body.wallet === 'string' ? body.wallet : '';
    if (!wallet) {
      return NextResponse.json({ error: 'wallet is required' }, { status: 400 });
    }

    const { deviceId, created } = getOrCreateDeviceId(request);
    const deviceIdHash = hashAccessValue(deviceId);
    const enrollResult = await callInternalApi<EnrollResponse>('/access/enroll', {
      method: 'POST',
      body: { wallet, deviceIdHash },
    });

    if (!enrollResult.response.ok || !enrollResult.json?.user) {
      return NextResponse.json(enrollResult.json ?? { error: 'Failed to enroll trusted device' }, { status: enrollResult.response.status });
    }

    const rawAccessToken = createOpaqueToken();
    const trustedUntil = buildTrustedUntilIso();
    const sessionResult = await callInternalApi('/access/session', {
      method: 'POST',
      body: {
        tokenHash: hashAccessValue(rawAccessToken),
        userId: enrollResult.json.user.id,
        deviceIdHash,
        accessMode: 'trusted_device',
        trustedUntil,
      },
    });

    if (!sessionResult.response.ok) {
      return NextResponse.json(sessionResult.json ?? { error: 'Failed to establish trusted-device access session' }, { status: sessionResult.response.status });
    }

    const response = NextResponse.json({
      ok: true,
      user: enrollResult.json.user,
      firstReveal: enrollResult.json.firstReveal ?? false,
      licenseKey: enrollResult.json.licenseKey ?? null,
      liveSessionCount: enrollResult.json.liveSessionCount ?? 0,
      trustedUntil,
    });

    response.cookies.set(ACCESS_TOKEN_COOKIE, rawAccessToken, getCookieBaseOptions(ACCESS_TTL_SECONDS));
    response.cookies.delete(TEMP_GATE_COOKIE);
    if (created) {
      response.cookies.set(DEVICE_ID_COOKIE, deviceId, getCookieBaseOptions(60 * 60 * 24 * 365));
    }

    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to enroll trusted device' },
      { status: 500 },
    );
  }
}
