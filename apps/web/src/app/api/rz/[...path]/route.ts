import { NextRequest, NextResponse } from 'next/server';

const getApiBaseUrl = () => {
  const fromEnv = process.env.API_INTERNAL_URL ?? process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!fromEnv) {
    throw new Error('API_INTERNAL_URL (or API_URL / NEXT_PUBLIC_API_URL) must be set on the web service');
  }
  return fromEnv.endsWith('/') ? fromEnv.slice(0, -1) : fromEnv;
};

const getInternalSecret = () => process.env.RZ_INTERNAL_SECRET ?? '';

const buildTargetUrl = (request: NextRequest, path: string[]) => {
  const base = getApiBaseUrl();
  const pathname = path.join('/');
  const suffix = request.nextUrl.search || '';
  return `${base}/${pathname}${suffix}`;
};

const proxy = async (request: NextRequest, path: string[]) => {
  const internalSecret = getInternalSecret();
  if (!internalSecret) {
    return NextResponse.json(
      { error: 'RZ_INTERNAL_SECRET is not configured on web service' },
      { status: 500 },
    );
  }

  const targetUrl = buildTargetUrl(request, path);
  const incomingHeaders = new Headers(request.headers);

  // Forward only safe headers.
  incomingHeaders.delete('host');
  incomingHeaders.delete('connection');
  incomingHeaders.delete('content-length');
  incomingHeaders.set('x-rz-internal-secret', internalSecret);

  const method = request.method.toUpperCase();
  const hasBody = !['GET', 'HEAD'].includes(method);

  const upstreamResponse = await fetch(targetUrl, {
    method,
    headers: incomingHeaders,
    body: hasBody ? await request.text() : undefined,
    cache: 'no-store',
  });

  const bodyText = await upstreamResponse.text();
  const responseHeaders = new Headers();
  const contentType = upstreamResponse.headers.get('content-type');
  if (contentType) {
    responseHeaders.set('content-type', contentType);
  }

  return new NextResponse(bodyText, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
};

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function OPTIONS(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}
