import { NextRequest, NextResponse } from 'next/server';
import { deleteManager, getManagerById, toggleManagerAccess, updateManagerName, usersTableReady } from '@/lib/db';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json() as { name?: string; accessEnabled?: boolean };
    await usersTableReady();

    const existing = await getManagerById(id);
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Manager not found' }, { status: 404 });
    }

    let manager = existing;
    if (typeof body.name === 'string' && body.name.trim().length > 0) {
      manager = await updateManagerName(id, body.name.trim());
    }
    if (typeof body.accessEnabled === 'boolean') {
      manager = await toggleManagerAccess(id, body.accessEnabled);
    }

    return NextResponse.json({ success: true, manager });
  } catch (err) {
    console.error('[PATCH /api/managers/[id]]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await usersTableReady();
    await deleteManager(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/managers/[id]]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
