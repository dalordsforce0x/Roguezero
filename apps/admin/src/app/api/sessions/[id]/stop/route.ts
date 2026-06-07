/**
 * POST /api/sessions/[id]/stop — disabled by user-only stop invariant.
 */
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return NextResponse.json({
      success: false,
      id,
      error: 'Admin force-stop is disabled. Only the user can stop a trading session.',
    }, { status: 403 });
  } catch (err) {
    console.error('[POST /api/sessions/[id]/stop]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
