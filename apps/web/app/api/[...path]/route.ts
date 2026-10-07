import { env } from "cloudflare:workers";

// Same-origin proxy: /api/* → API Worker via the `API` service binding. The original request
// (URL incl. https scheme + host, method, headers incl. Cookie, body) is forwarded as-is so the
// API sees the real protocol (Secure cookie flag); the response, incl. Set-Cookie, is returned
// unchanged. Fallback when no binding is available, dev only: http://localhost:8787; production
// without the binding fails closed (503).
const DEV_API = "http://localhost:8787";

async function proxy(request: Request): Promise<Response> {
  // Rebuild as (url, init): the route handler receives a NextRequest wrapper, which the
  // service-binding stub does not accept as a Request.
  // Body is streamed, not buffered: the Python client also uses this origin, and fallback-tier
  // checkpoint uploads (PUT /api/v1/uploads/:id/body) can be ~100 MB.
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    duplex: "half",
    redirect: "manual",
  };
  if (env.API) return env.API.fetch(request.url, init);
  if (!import.meta.env.DEV) {
    return Response.json({ error: { code: "api_unavailable", message: "API binding missing" } }, { status: 503 });
  }
  const url = new URL(request.url);
  return fetch(DEV_API + url.pathname + url.search, init);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
