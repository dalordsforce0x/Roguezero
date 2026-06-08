/**
 * POST /api/managers/unassign-groups
 * Unbinds the given groups from whatever manager they belong to
 * (sets manager_id = NULL). Used when reassigning or releasing groups.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assignGroupsToManager, listManagers, usersTableReady } from '@/lib/db';

const normalizeIds = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  : [];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { groupIds?: unknown };
    await usersTableReady();

    const groupIds = normalizeIds(body.groupIds);
    if (groupIds.length === 0) {
      return NextResponse.json({ success: false, error: 'groupIds is required' }, { status: 400 });
    }

    await assignGroupsToManager(null, groupIds);
    return NextResponse.json({ success: true, managers: await listManagers() });
  } catch (err) {
    console.error('[POST /api/managers/unassign-groups]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
