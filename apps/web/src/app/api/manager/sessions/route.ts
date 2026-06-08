import { NextRequest, NextResponse } from 'next/server';
import {
  MANAGER_SESSION_COOKIE,
  callInternalApi,
  readCookieValue,
  verifyManagerSessionToken,
} from '@/lib/accessServer';

type ManagerSessionsResponse = {
  sessions?: unknown[];
  count?: number;
  error?: string;
};

export async function GET(request: NextRequest) {
  const session = verifyManagerSessionToken(readCookieValue(request, MANAGER_SESSION_COOKIE));
  if (!session) {
    return NextResponse.json({ error: 'manager session required' }, { status: 401 });
  }

  const status = request.nextUrl.searchParams.get('status');
  const suffix = status ? `?status=${encodeURIComponent(status)}` : '';

  const result = await callInternalApi<ManagerSessionsResponse>(
    `/manager/${encodeURIComponent(session.managerId)}/sessions${suffix}`,
    { method: 'GET' },
  );

  if (!result.response.ok) {
    return NextResponse.json(result.json ?? { error: 'Failed to load sessions' }, { status: result.response.status });
  }

  return NextResponse.json(result.json ?? {});
}
