/**
 * tempmail — a private catch-all inbox on Cloudflare Workers.
 *
 * One Worker does everything:
 *   fetch()      serves the site and its JSON API, behind a password
 *   email()      receives mail from Email Routing and stores it in D1
 *   scheduled()  nightly housekeeping: retention and the global cap
 */

import { handleApi, handlePublicApi } from "./api";
import { hasValidSession } from "./auth";
import { deleteMessagesByIds, ensureSchema, sweepOrphanAttachments } from "./db";
import { handleEmail } from "./email";
import type { InboxHub } from "./live";

export { InboxHub } from "./live";
import { json, withSecurityHeaders } from "./http";
import { BURNER_GRACE_MS, resolveLimits, TRASH_TTL_MS } from "./limits";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** The Durable Object that pushes arrivals to open browsers. */
  INBOX_HUB: DurableObjectNamespace<InboxHub>;
  /**
   * Optional allow-list of mail domains, comma separated. Leave it unset to
   * accept everything Email Routing sends here (the usual case).
   */
  MAIL_DOMAIN?: string;
  /**
   * Optional. Set it as a secret to manage the password outside the app;
   * otherwise the first visitor creates one on the setup screen.
   */
  AUTH_PASSWORD?: string;
  /** Optional. Enables POST /api/dev/ingest for local testing. */
  INGEST_KEY?: string;
}

/**
 * Files the sign-in page needs before anyone is signed in.
 *
 * The fonts are here because style.css asks for them: anything missing from
 * this set falls through to the app shell, so the browser would receive
 * login.html with a text/html type where it expected a woff2, and the sign-in
 * screen alone would silently render in the fallback face.
 */
const PUBLIC_FILES = new Set([
  "/style.css", "/theme.js", "/login.js", "/icon.svg", "/manifest.webmanifest", "/sw.js",
  "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png",
  "/fonts/geist-latin.woff2", "/fonts/geist-latin-ext.woff2",
]);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      await ensureSchema(env.DB);

      if (request.method === "OPTIONS") return withSecurityHeaders(new Response(null, { status: 204 }));
      if (isCrossSiteWrite(request, url)) return json({ error: "Cross-site requests are not allowed" }, 403);

      const publicResponse = await handlePublicApi(request, env, url, ctx);
      if (publicResponse) return publicResponse;

      if (!(await hasValidSession(request, env))) {
        if (url.pathname.startsWith("/api/")) return json({ error: "Unauthorized" }, 401);
        if (PUBLIC_FILES.has(url.pathname)) return serveAsset(env, url, url.pathname, request);
        // Every other page shows the sign-in (or first-run setup) screen.
        return serveAsset(env, url, "/login.html", request);
      }

      const apiResponse = await handleApi(request, env, url);
      if (apiResponse) return apiResponse;
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

      if (url.pathname === "/login" || url.pathname === "/login.html") {
        return withSecurityHeaders(Response.redirect(url.origin + "/", 302));
      }
      return serveAsset(env, url, url.pathname, request);
    } catch (err) {
      console.error("request failed", err);
      return json({ error: "Internal error" }, 500);
    }
  },

  // Called by Cloudflare Email Routing for every message the catch-all rule sends here.
  // This works whether or not anyone has signed in to the site.
  async email(message, env, ctx): Promise<void> {
    await ensureSchema(env.DB);
    await handleEmail(message, env, ctx);
  },

  // Nightly housekeeping. Starred mail is exempt from both sweeps, so anything
  // worth keeping survives however long it sits here.
  async scheduled(_controller, env): Promise<void> {
    await ensureSchema(env.DB);
    const limits = await resolveLimits(env.DB);
    const cutoff = Date.now() - limits.retentionDays * 24 * 60 * 60 * 1000;

    // Trashed mail past its undo window goes first, starred or not.
    await purge(env, "SELECT id FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ?1", [Date.now() - TRASH_TTL_MS]);
    await purge(env, "SELECT id FROM messages WHERE received_at < ?1 AND starred = 0", [cutoff]);
    await purge(
      env,
      `SELECT id FROM messages WHERE starred = 0 AND id NOT IN
         (SELECT id FROM messages ORDER BY ${KEEP_ORDER} LIMIT ?1)`,
      [limits.total]
    );

    // Burners that expired a week ago, were never named and hold no mail
    // have nothing left to say; drop the rows.
    await env.DB.prepare(
      `DELETE FROM addresses WHERE mode = 'expires' AND expires_at < ?1 AND label IS NULL
         AND address NOT IN (SELECT address FROM messages)`
    ).bind(Date.now() - BURNER_GRACE_MS).run();

    // Catches anything a failed delete left behind earlier.
    await sweepOrphanAttachments(env.DB);
  },
} satisfies ExportedHandler<Env>;

/**
 * What survives the global cap, most worth keeping first.
 *
 * Starred mail first, because that is the owner saying so. Then junk last of
 * all, because it is the one box whose contents they have already been told
 * are worth nothing -- without that, a run of junk evicts real mail on age
 * alone. Everything else falls back to newest-first.
 */
export const KEEP_ORDER = "starred DESC, (box = 'junk') ASC, received_at DESC, id DESC";

/** Deletes the messages a query selects, along with their attachment rows. */
async function purge(env: Env, sql: string, binds: unknown[]): Promise<void> {
  const { results } = await env.DB.prepare(sql).bind(...binds).all<{ id: string }>();
  await deleteMessagesByIds(env.DB, results.map((row) => row.id));
}


/**
 * Whether an unsafe request came from somewhere other than this site.
 *
 * "cross-site" alone is not enough: the session cookie is SameSite=Lax, which
 * still sends it for same-site requests, so a sibling subdomain of a custom
 * domain could forge writes. Anything but same-origin is refused, and an Origin
 * header that disagrees with the request's own origin is refused outright for
 * browsers that send it without Sec-Fetch-Site.
 */
function isCrossSiteWrite(request: Request, url: URL): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return true;
  const site = request.headers.get("sec-fetch-site");
  return site != null && site !== "same-origin" && site !== "none";
}

/**
 * Serves a file from the static assets binding.
 *
 * The binding may answer with a redirect of its own (for example
 * "/login.html" → "/login" under the default html_handling). We follow those
 * here so the browser never sees them and can't end up looping between the
 * asset layer and our sign-in routing.
 */
async function serveAsset(env: Env, url: URL, path: string, original: Request): Promise<Response> {
  const headers = new Headers();
  for (const name of ["accept", "accept-encoding", "if-none-match", "if-modified-since"]) {
    const value = original.headers.get(name);
    if (value) headers.set(name, value);
  }

  let res = await env.ASSETS.fetch(new Request(url.origin + path, { headers }));
  for (let hops = 0; hops < 3 && [301, 302, 307, 308].includes(res.status); hops++) {
    const location = res.headers.get("location");
    if (!location) break;
    res = await env.ASSETS.fetch(new Request(new URL(location, url.origin), { headers }));
  }

  // Unknown page URLs fall back to the app shell; unknown files stay 404.
  if (res.status === 404 && path !== "/" && headers.get("accept")?.includes("text/html")) {
    return serveAsset(env, url, "/", original);
  }
  return withSecurityHeaders(res);
}
