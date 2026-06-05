/**
 * PATCH  /api/users/[id]  — toggle trading access on or off for a user
 * DELETE /api/users/[id]  — permanently remove a user from the admin list
 */
import { NextRequest, NextResponse } from 'next/server';
import { toggleAccess, deleteUser, updateUserProfile } from '@/lib/db';
import { expiryDateFromDuration } from '@/lib/keyauth';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { accessEnabled, maxWalletUsd, username, walletAddress, duration, groupId, refreshExpiry } = await req.json() as {
      accessEnabled?: boolean;
      maxWalletUsd?: number;
      username?: string;
      walletAddress?: string;
      duration?: string;
      groupId?: string | null;
      refreshExpiry?: boolean;
    };

    if (
      username !== undefined
      || walletAddress !== undefined
      || duration !== undefined
      || maxWalletUsd !== undefined
      || groupId !== undefined
    ) {
      if (maxWalletUsd !== undefined && (!Number.isFinite(maxWalletUsd) || Number(maxWalletUsd) <= 0)) {
        return NextResponse.json({ success: false, error: 'maxWalletUsd must be a positive number' }, { status: 400 });
      }
      if (username !== undefined && username.trim().length === 0) {
        return NextResponse.json({ success: false, error: 'username cannot be blank' }, { status: 400 });
      }
      if (walletAddress !== undefined && walletAddress.trim().length === 0) {
        return NextResponse.json({ success: false, error: 'walletAddress cannot be blank' }, { status: 400 });
      }

      const user = await updateUserProfile(id, {
        username: username?.trim(),
        walletAddress: walletAddress?.trim(),
        duration,
        maxWalletUsd: maxWalletUsd === undefined ? undefined : Math.floor(Number(maxWalletUsd)),
        groupId,
        expiryDate: duration && refreshExpiry ? expiryDateFromDuration(duration) : undefined,
      });
      return NextResponse.json({ success: true, user });
    }

    if (typeof accessEnabled !== 'boolean') {
      return NextResponse.json({ success: false, error: 'accessEnabled must be a boolean' }, { status: 400 });
    }

    const user = await toggleAccess(id, accessEnabled);
    return NextResponse.json({ success: true, user });
  } catch (err) {
    console.error('[PATCH /api/users/[id]]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteUser(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/users/[id]]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
