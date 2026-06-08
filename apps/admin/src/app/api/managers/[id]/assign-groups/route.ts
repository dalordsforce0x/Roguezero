/**
 * POST /api/managers/[id]/assign-groups
 * Binds the given groups to this manager (group -> manager is 1:N).
 * Passing groupIds sets manager_id on those groups. To unbind groups,
 * use POST /api/managers/unassign-groups with their ids.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assignGroupsToManager, getManagerById, listManagers, usersTableReady } from '@/lib/db';

const normalizeIds = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  : [];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json() as { groupIds?: unknown };
    await usersTableReady();

    const manager = await getManagerById(id);
    if (!manager) {
      return NextResponse.json({ success: false, error: 'Manager not found' }, { status: 404 });
    }

    const groupIds = normalizeIds(body.groupIds);
    if (groupIds.length === 0) {
      return NextResponse.json({ success: false, error: 'groupIds is required' }, { status: 400 });
    }

    await assignGroupsToManager(id, groupIds);
    return NextResponse.json({ success: true, managers: await listManagers() });
  } catch (err) {
    console.error('[POST /api/managers/[id]/assign-groups]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
