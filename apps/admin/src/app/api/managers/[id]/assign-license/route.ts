/**
 * POST /api/managers/[id]/assign-license
 * Generates a manager (access-management) license key via KeyAuth using the
 * manager mask, stores it against the manager, sets expiry, and enables access.
 */
import { NextRequest, NextResponse } from 'next/server';
import { usersTableReady, getManagerById, assignManagerLicense } from '@/lib/db';
import { generateManagerLicense, expiryDateFromDuration } from '@/lib/keyauth';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await usersTableReady();

    const manager = await getManagerById(id);
    if (!manager) {
      return NextResponse.json({ success: false, error: 'Manager not found' }, { status: 404 });
    }

    const duration = manager.duration ?? '1month';
    const managementKey = await generateManagerLicense(duration);
    const expiryDate = expiryDateFromDuration(duration);
    const updated = await assignManagerLicense(id, managementKey, expiryDate);

    return NextResponse.json({ success: true, manager: updated });
  } catch (err) {
    console.error('[POST /api/managers/[id]/assign-license]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
