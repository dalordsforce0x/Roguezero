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

type AccessBootResponse = {
  state?: 'temporary_required' | 'license_required' | 'access_granted';
  source?: 'trusted_device' | 'license_key' | 'live_session_bypass';
  userId?: string;
  trustedUntil?: string;
  liveSessionCount?: number;
  error?: string;
};

export async function GET(request: NextRequest) {
  try {
    const { deviceId, created } = getOrCreateDeviceId(request);
    const deviceIdHash = hashAccessValue(deviceId);
    const accessToken = readCookieValue(request, ACCESS_TOKEN_COOKIE);
    const tempGateUnlocked = Boolean(readCookieValue(request, TEMP_GATE_COOKIE));

    const upstream = await callInternalApi<AccessBootResponse>('/access/boot', {
      method: 'POST',
      body: {
        tokenHash: accessToken ? hashAccessValue(accessToken) : undefined,
        deviceIdHash,
      },
    });

    const payload = upstream.json;
    const baseState = tempGateUnlocked && payload?.state !== 'access_granted'
      ? 'temporary_unlocked'
      : payload?.state ?? 'temporary_required';
    const response = NextResponse.json({
      state: baseState,
      source: payload?.source ?? null,
      trustedUntil: payload?.trustedUntil ?? null,
      liveSessionCount: payload?.liveSessionCount ?? 0,
      userId: payload?.userId ?? null,
    }, {
      status: upstream.response.ok ? 200 : upstream.response.status,
    });

    if (payload?.state === 'access_granted' && !accessToken && payload.userId && payload.source === 'live_session_bypass') {
      const rawAccessToken = createOpaqueToken();
      const trustedUntil = buildTrustedUntilIso();
      await callInternalApi('/access/session', {
        method: 'POST',
        body: {
          tokenHash: hashAccessValue(rawAccessToken),
          userId: payload.userId,
          deviceIdHash,
          accessMode: 'live_session_bypass',
          trustedUntil,
        },
      });

      response.cookies.set(ACCESS_TOKEN_COOKIE, rawAccessToken, getCookieBaseOptions(ACCESS_TTL_SECONDS));
    }

    if (created) {
      response.cookies.set(DEVICE_ID_COOKIE, deviceId, getCookieBaseOptions(60 * 60 * 24 * 365));
    }

    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to resolve access state' },
      { status: 500 },
    );
  }
}
