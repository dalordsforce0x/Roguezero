import { NextResponse } from 'next/server';
import { getTokenUniverseOverview } from '@/lib/db';

export async function GET() {
  try {
    const overview = await getTokenUniverseOverview();
    return NextResponse.json(overview);
  } catch (err) {
    console.error('[GET /api/token-universe]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
