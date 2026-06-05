import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';

export const ACCESS_TOKEN_COOKIE = 'rz_access_token';
export const DEVICE_ID_COOKIE = 'rz_device_id';
export const TEMP_GATE_COOKIE = 'rz_temp_gate';
export const ACCESS_TRUST_HOURS = 6;
export const TEMP_GATE_TTL_SECONDS = 30 * 60;
export const ACCESS_TTL_SECONDS = ACCESS_TRUST_HOURS * 60 * 60;

const getApiBaseUrls = () => {
  const candidates = [
    process.env.API_INTERNAL_URL,
    process.env.API_URL,
    process.env.NEXT_PUBLIC_API_URL,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const deduped = [...new Set(candidates)].map((value) => (
    value.endsWith('/') ? value.slice(0, -1) : value
  ));

  if (deduped.length === 0) {
    throw new Error('API_INTERNAL_URL (or API_URL / NEXT_PUBLIC_API_URL) must be set on the web service');
  }

  return deduped;
};

const getInternalSecret = () => {
  const secret = process.env.RZ_INTERNAL_SECRET?.trim() ?? '';
  if (!secret) {
    throw new Error('RZ_INTERNAL_SECRET must be configured on the web service');
  }
  return secret;
};

export const tempGatePassword = () => process.env.WEB_GATE_TEMP_PASSWORD?.trim() || '1121';

export const hashAccessValue = (value: string) => createHash('sha256').update(value).digest('hex');

export const createOpaqueToken = () => `${randomUUID()}-${randomBytes(24).toString('hex')}`;

export const readCookieValue = (request: NextRequest, cookieName: string) => request.cookies.get(cookieName)?.value ?? null;

export const getOrCreateDeviceId = (request: NextRequest) => {
  const existing = readCookieValue(request, DEVICE_ID_COOKIE);
  if (existing) {
    return { deviceId: existing, created: false };
  }

  return { deviceId: createOpaqueToken(), created: true };
};

export const getCookieBaseOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: maxAgeSeconds,
});

export const callInternalApi = async <T>(path: string, init?: {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}) => {
  const baseUrls = getApiBaseUrls();
  const internalSecret = getInternalSecret();
  let lastNetworkError: unknown = null;

  for (const baseUrl of baseUrls) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-rz-internal-secret': internalSecret,
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        cache: 'no-store',
      });

      const text = await response.text();
      let json: T | null = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text) as T;
        } catch {
          json = ({ error: text } as unknown) as T;
        }
      }

      return { response, json };
    } catch (error) {
      lastNetworkError = error;
    }
  }

  throw lastNetworkError instanceof Error
    ? lastNetworkError
    : new Error('All configured API base URLs failed');
};

export const buildTrustedUntilIso = () => new Date(Date.now() + (ACCESS_TTL_SECONDS * 1000)).toISOString();
