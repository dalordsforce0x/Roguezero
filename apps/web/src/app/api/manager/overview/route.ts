import { NextRequest, NextResponse } from 'next/server';
import {
  MANAGER_SESSION_COOKIE,
  callInternalApi,
  readCookieValue,
  verifyManagerSessionToken,
} from '@/lib/accessServer';

type ManagerOverviewResponse = {
  manager?: unknown;
  groups?: unknown[];
  users?: unknown[];
  groupCount?: number;
  userCount?: number;
  error?: string;
};

export async function GET(request: NextRequest) {
  const session = verifyManagerSessionToken(readCookieValue(request, MANAGER_SESSION_COOKIE));
  if (!session) {
    return NextResponse.json({ error: 'manager session required' }, { status: 401 });
  }

  const result = await callInternalApi<ManagerOverviewResponse>(
    `/manager/${encodeURIComponent(session.managerId)}/overview`,
    { method: 'GET' },
  );

  if (!result.response.ok) {
    return NextResponse.json(result.json ?? { error: 'Failed to load overview' }, { status: result.response.status });
  }

  return NextResponse.json(result.json ?? {});
}
