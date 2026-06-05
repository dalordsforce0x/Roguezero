/**
 * GET  /api/users         — list all users in the admin dashboard
 * POST /api/users         — create a new user (username + wallet + duration)
 */
import { NextRequest, NextResponse } from 'next/server';
import { usersTableReady, listUsers, createUser } from '@/lib/db';

export async function GET() {
  try {
    await usersTableReady();
    const users = await listUsers();
    return NextResponse.json({ success: true, users });
  } catch (err) {
    console.error('[GET /api/users]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { username, walletAddress, duration, maxWalletUsd, groupId } = await req.json() as {
      username?: string;
      walletAddress?: string;
      duration?: string;
      maxWalletUsd?: number;
      groupId?: string | null;
    };

    if (!username || !walletAddress || !duration) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: username, walletAddress, duration' },
        { status: 400 }
      );
    }

    if (!Number.isFinite(maxWalletUsd) || Number(maxWalletUsd) <= 0) {
      return NextResponse.json(
        { success: false, error: 'maxWalletUsd must be a positive number' },
        { status: 400 }
      );
    }

    await usersTableReady();
    const user = await createUser(username, walletAddress, duration, Math.floor(Number(maxWalletUsd)), groupId ?? null);
    return NextResponse.json({ success: true, user }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/users]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
