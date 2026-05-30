import { NextRequest, NextResponse } from 'next/server';
import {
  getLiveRuntimeControlSnapshot,
  setLiveRuntimeSpeedProfile,
} from '@/lib/db';

export async function GET() {
  try {
    const snapshot = await getLiveRuntimeControlSnapshot();
    return NextResponse.json(snapshot);
  } catch (err) {
    console.error('[GET /api/runtime-control]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as { speedProfile?: unknown };
    const speedProfile = typeof body.speedProfile === 'string' ? body.speedProfile : '';
    const snapshot = await setLiveRuntimeSpeedProfile(speedProfile);
    return NextResponse.json(snapshot);
  } catch (err) {
    console.error('[PATCH /api/runtime-control]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
