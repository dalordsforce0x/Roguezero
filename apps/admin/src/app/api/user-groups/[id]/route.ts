import { NextRequest, NextResponse } from 'next/server';
import { assignUsersToGroup, updateUserGroup, usersTableReady } from '@/lib/db';

const normalizeUserIds = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  : [];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json() as {
      name?: string;
      botLimit?: number;
      addUserIds?: unknown;
      removeUserIds?: unknown;
    };

    const name = body.name?.trim();
    const botLimit = Number(body.botLimit ?? 1);
    if (!name) {
      return NextResponse.json({ success: false, error: 'Group name is required' }, { status: 400 });
    }
    if (!Number.isFinite(botLimit) || botLimit <= 0) {
      return NextResponse.json({ success: false, error: 'botLimit must be a positive number' }, { status: 400 });
    }

    await usersTableReady();
    const group = await updateUserGroup(id, name, Math.floor(botLimit));
    const addUserIds = normalizeUserIds(body.addUserIds);
    const removeUserIds = normalizeUserIds(body.removeUserIds);
    if (addUserIds.length > 0) await assignUsersToGroup(id, addUserIds);
    if (removeUserIds.length > 0) await assignUsersToGroup(null, removeUserIds);

    return NextResponse.json({ success: true, group });
  } catch (err) {
    console.error('[PATCH /api/user-groups/[id]]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
