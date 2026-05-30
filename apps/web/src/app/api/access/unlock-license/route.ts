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
} from '@/lib/accessServer';

type LicenseAuthResponse = {
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
  liveSessionCount?: number;
  error?: string;
  details?: string;
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { password?: unknown; licenseKey?: unknown };
  const licenseKey = typeof body.licenseKey === 'string'
    ? body.licenseKey
    : typeof body.password === 'string'
      ? body.password
      : '';

  if (!licenseKey) {
    return NextResponse.json({ error: 'license key is required' }, { status: 400 });
  }

  const { deviceId, created } = getOrCreateDeviceId(request);
  const deviceIdHash = hashAccessValue(deviceId);
  const authResult = await callInternalApi<LicenseAuthResponse>('/access/license-auth', {
    method: 'POST',
    body: { licenseKey, deviceIdHash },
  });

  if (!authResult.response.ok || !authResult.json?.user) {
    return NextResponse.json(authResult.json ?? { error: 'Failed to validate license key' }, { status: authResult.response.status });
  }

  const rawAccessToken = createOpaqueToken();
  const trustedUntil = buildTrustedUntilIso();
  const sessionResult = await callInternalApi('/access/session', {
    method: 'POST',
    body: {
      tokenHash: hashAccessValue(rawAccessToken),
      userId: authResult.json.user.id,
      deviceIdHash,
      accessMode: 'license_key',
      trustedUntil,
    },
  });

  if (!sessionResult.response.ok) {
    return NextResponse.json({ error: 'Failed to establish license-key access session' }, { status: sessionResult.response.status });
  }

  const response = NextResponse.json({
    ok: true,
    user: authResult.json.user,
    liveSessionCount: authResult.json.liveSessionCount ?? 0,
    trustedUntil,
  });

  response.cookies.set(ACCESS_TOKEN_COOKIE, rawAccessToken, getCookieBaseOptions(ACCESS_TTL_SECONDS));
  response.cookies.delete(TEMP_GATE_COOKIE);
  if (created) {
    response.cookies.set(DEVICE_ID_COOKIE, deviceId, getCookieBaseOptions(60 * 60 * 24 * 365));
  }

  return response;
}
