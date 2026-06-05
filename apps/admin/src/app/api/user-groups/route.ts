import { NextRequest, NextResponse } from 'next/server';
import { assignUsersToGroup, createUser, createUserGroup, listUserGroups, usersTableReady } from '@/lib/db';

const normalizeUserIds = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  : [];

export async function GET() {
  try {
    await usersTableReady();
    const groups = await listUserGroups();
    return NextResponse.json({ success: true, groups });
  } catch (err) {
    console.error('[GET /api/user-groups]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      name?: string;
      botLimit?: number;
      existingUserIds?: unknown;
      newUsers?: Array<{ username?: string; walletAddress?: string; duration?: string; maxWalletUsd?: number }>;
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
    const group = await createUserGroup(name, Math.floor(botLimit));
    const existingUserIds = normalizeUserIds(body.existingUserIds);
    if (existingUserIds.length > 0) {
      await assignUsersToGroup(group.id, existingUserIds);
    }

    for (const newUser of body.newUsers ?? []) {
      const username = newUser.username?.trim();
      const walletAddress = newUser.walletAddress?.trim();
      const duration = newUser.duration ?? '1month';
      const maxWalletUsd = Number(newUser.maxWalletUsd ?? 10000);
      if (!username || !walletAddress || !Number.isFinite(maxWalletUsd) || maxWalletUsd <= 0) continue;
      await createUser(username, walletAddress, duration, Math.floor(maxWalletUsd), group.id);
    }

    return NextResponse.json({ success: true, group, groups: await listUserGroups() }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/user-groups]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
