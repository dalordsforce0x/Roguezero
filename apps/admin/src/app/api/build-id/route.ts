import { NextResponse } from "next/server";

const DEPLOY_CANARY = "rz-canary-2026-06-01-01";

export async function GET() {
  return NextResponse.json({
    service: "admin",
    deployCanary: DEPLOY_CANARY,
    timestamp: new Date().toISOString(),
  });
}
