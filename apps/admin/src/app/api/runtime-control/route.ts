import { NextRequest, NextResponse } from 'next/server';
import {
  getLiveRuntimeControlSnapshot,
  setLiveRuntimeEntriesEnabled,
  setLiveRuntimeMode,
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
    const body = await req.json().catch(() => ({})) as {
      speedProfile?: unknown;
      modeSource?: unknown;
      entriesEnabled?: unknown;
      maintenanceReason?: unknown;
    };

    if (typeof body.entriesEnabled === 'boolean') {
      const snapshot = await setLiveRuntimeEntriesEnabled(body.entriesEnabled, body.maintenanceReason);
      return NextResponse.json(snapshot);
    }

    // Returning to auto hands fleet throttle control back to the worker.
    if (body.modeSource === 'auto') {
      const snapshot = await setLiveRuntimeMode('auto');
      return NextResponse.json(snapshot);
    }

    // Selecting a profile pins the fleet to that mode (manual).
    const speedProfile = typeof body.speedProfile === 'string' ? body.speedProfile : '';
    const snapshot = await setLiveRuntimeSpeedProfile(speedProfile);
    return NextResponse.json(snapshot);
  } catch (err) {
    console.error('[PATCH /api/runtime-control]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
