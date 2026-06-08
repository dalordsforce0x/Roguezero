import { NextResponse } from 'next/server';
import { MANAGER_SESSION_COOKIE } from '@/lib/accessServer';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(MANAGER_SESSION_COOKIE);
  return response;
}
