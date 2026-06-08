import { NextRequest, NextResponse } from 'next/server';
import {
  MANAGER_SESSION_COOKIE,
  MANAGER_SESSION_TTL_SECONDS,
  callInternalApi,
  createManagerSessionToken,
  getCookieBaseOptions,
} from '@/lib/accessServer';

type ManagerAuthResponse = {
  ok?: boolean;
  manager?: { id: string; name: string; expiryDate: string | null; accessEnabled: boolean };
  groups?: unknown[];
  users?: unknown[];
  groupCount?: number;
  userCount?: number;
  error?: string;
  details?: string;
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { managementKey?: unknown; licenseKey?: unknown };
  const managementKey = typeof body.managementKey === 'string'
    ? body.managementKey
    : typeof body.licenseKey === 'string'
      ? body.licenseKey
      : '';

  if (!managementKey) {
    return NextResponse.json({ error: 'management key is required' }, { status: 400 });
  }

  const authResult = await callInternalApi<ManagerAuthResponse>('/manager/license-auth', {
    method: 'POST',
    body: { managementKey },
  });

  if (!authResult.response.ok || !authResult.json?.manager) {
    return NextResponse.json(
      authResult.json ?? { error: 'Failed to validate management key' },
      { status: authResult.response.status },
    );
  }

  const manager = authResult.json.manager;
  const token = createManagerSessionToken(manager.id, manager.name);

  const response = NextResponse.json({
    ok: true,
    manager,
    groups: authResult.json.groups ?? [],
    users: authResult.json.users ?? [],
    groupCount: authResult.json.groupCount ?? 0,
    userCount: authResult.json.userCount ?? 0,
  });

  response.cookies.set(MANAGER_SESSION_COOKIE, token, getCookieBaseOptions(MANAGER_SESSION_TTL_SECONDS));
  return response;
}
