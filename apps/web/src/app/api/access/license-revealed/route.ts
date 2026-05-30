import { NextRequest, NextResponse } from 'next/server';
import { callInternalApi } from '@/lib/accessServer';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { userId?: unknown };
  const userId = typeof body.userId === 'string' ? body.userId : '';

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  const result = await callInternalApi('/access/license-revealed', {
    method: 'POST',
    body: { userId },
  });

  return NextResponse.json(result.json ?? { ok: result.response.ok }, { status: result.response.status });
}
