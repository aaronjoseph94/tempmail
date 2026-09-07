/**
 * Response helpers shared by the router and the API handlers.
 */

/**
 * Sent with every response. The CSP is strict for our own pages; note that the
 * message iframe (a srcdoc frame) inherits it, so img-src stays open here and
 * the per-message policy injected by the front-end decides what actually loads.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src * data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "media-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

/** Copies the response and stamps the security headers on it. */
export function withSecurityHeaders(res: Response): Response {
  // Responses from bindings have immutable headers, so build a fresh one.
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
    })
  );
}

/** Parses a JSON object body. Anything that isn't an object becomes {}. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
