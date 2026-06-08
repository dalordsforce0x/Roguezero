import { NextRequest, NextResponse } from 'next/server';
import { createManager, listManagers, usersTableReady } from '@/lib/db';

export async function GET() {
  try {
    await usersTableReady();
    const managers = await listManagers();
    return NextResponse.json({ success: true, managers });
  } catch (err) {
    console.error('[GET /api/managers]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { name?: string; duration?: string };
    const name = body.name?.trim();
    const duration = body.duration ?? '1month';
    if (!name) {
      return NextResponse.json({ success: false, error: 'Manager name is required' }, { status: 400 });
    }

    await usersTableReady();
    const manager = await createManager(name, duration);
    return NextResponse.json({ success: true, manager, managers: await listManagers() }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/managers]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
