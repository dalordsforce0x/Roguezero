import { NextRequest, NextResponse } from 'next/server';
import { updateSessionStrategyControls } from '@/lib/db';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const session = await updateSessionStrategyControls(id, body ?? {});
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      session,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[PATCH /api/sessions/[id]/strategy-controls]', err);
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
