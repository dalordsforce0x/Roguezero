import { NextRequest, NextResponse } from 'next/server';
import {
  DEVICE_ID_COOKIE,
  TEMP_GATE_COOKIE,
  getCookieBaseOptions,
  getOrCreateDeviceId,
  tempGatePassword,
} from '@/lib/accessServer';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { password?: unknown };
  const password = typeof body.password === 'string' ? body.password : '';

  if (password !== tempGatePassword()) {
    return NextResponse.json({ error: 'wrong password' }, { status: 401 });
  }

  const { deviceId, created } = getOrCreateDeviceId(request);
  const response = NextResponse.json({ ok: true, state: 'temporary_unlocked' });

  response.cookies.set(TEMP_GATE_COOKIE, '1', getCookieBaseOptions(30 * 60));
  if (created) {
    response.cookies.set(DEVICE_ID_COOKIE, deviceId, getCookieBaseOptions(60 * 60 * 24 * 365));
  }

  return response;
}
