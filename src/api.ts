/**
 * The JSON API behind the inbox.
 *
 * handlePublicApi() serves the few endpoints that work before sign-in
 * (status, login, setup, logout). handleApi() serves everything else and is
 * only reached once index.ts has verified the session cookie.
 */

import {
  CLEAR_SESSION_COOKIE, checkPassword, clearFailedLogins, clientIp, createPassword, hasValidSession,
  lockoutSecondsLeft, noteFailedLogin, passwordProblem, passwordSource, replacePassword, sessionCookie,
} from "./auth";
import {
  deleteAttachmentsFor, deleteSetting, getSetting, idChunks, setLabel, setSetting,
  SETTING_ATTACHMENT_MB, SETTING_GLOBAL_CAP, SETTING_MAIL_DOMAIN, SETTING_PER_ADDRESS,
  SETTING_RAW_MB, SETTING_RETENTION_DAYS,
} from "./db";
import { afterIngest, allowedDomains, storeInboundEmail, type StoredAttachment } from "./email";
import { hubStub } from "./live";
import { getVapidKeys } from "./push";
import { json, readJson, sleep, withSecurityHeaders } from "./http";
import type { Env } from "./index";
import {
  ATTACHMENT_CHUNKS_PER_READ, LIMIT_RANGES, MAX_PAGE_SIZE, PAGE_SIZE, resolveLimits,
} from "./limits";
import { normalizeDomain, SNIPPET_LENGTH } from "./text";
import { isAddressMode, isDead, relatedDomain, type AddressRow } from "./addresses";
import { isOneClick, parseListUnsubscribe, publicHttpsUrl, type AuthSummary } from "./headers";

interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<Response>;

/* ------------------------------------------------------- public routes */

export async function handlePublicApi(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response | null> {
  const key = `${request.method} ${url.pathname}`;
  if (key === "GET /api/status") return status(request, env);
  if (key === "POST /api/login") return login(request, env);
  if (key === "POST /api/setup") return setup(request, env);
  if (key === "POST /api/logout") return json({ ok: true }, 200, { "set-cookie": CLEAR_SESSION_COOKIE });
  if (key === "POST /api/dev/ingest") return devIngest(request, env, url, ctx); // guarded by its own key
  return null;
}

/** What the sign-in page needs: is anyone signed in, and is there a password? */
async function status(request: Request, env: Env): Promise<Response> {
  const source = await passwordSource(env);
  return json({
    authed: source !== "none" && (await hasValidSession(request, env)),
    setupRequired: source === "none",
    passwordSource: source,
  });
}

function describeWait(seconds: number): string {
  return seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
}

async function login(request: Request, env: Env): Promise<Response> {
  const ip = clientIp(request);
  const locked = lockoutSecondsLeft(ip);
  if (locked > 0) return json({ error: `Too many attempts. Try again in ${describeWait(locked)}.` }, 429);

  if ((await passwordSource(env)) === "none") {
    return json({ error: "No password has been set up yet.", setupRequired: true }, 409);
  }

  const body = await readJson(request);
  if (!(await checkPassword(env, String(body.password ?? "")))) {
    const { attemptsLeft, lockedForSeconds } = noteFailedLogin(ip);
    await sleep(500); // keeps online guessing slow even if the lockout map resets
    const error = lockedForSeconds
      ? `Wrong password. Locked out for ${describeWait(lockedForSeconds)}.`
      : `Wrong password. ${attemptsLeft} ${attemptsLeft === 1 ? "attempt" : "attempts"} left.`;
    return json({ error }, 401);
  }

  clearFailedLogins(ip);
  return json({ ok: true }, 200, { "set-cookie": await sessionCookie(env) });
}

/** First run: create the password (and optionally the mail domain), then sign in. */
async function setup(request: Request, env: Env): Promise<Response> {
  if ((await passwordSource(env)) !== "none") return json({ error: "This inbox is already set up." }, 409);

  const body = await readJson(request);
  const problem = passwordProblem(body.password);
  if (problem) return json({ error: problem }, 400);
  const domain = normalizeDomain(body.mailDomain);
  if (domain === null) return json({ error: "That doesn't look like a domain name." }, 400);

  if (!(await createPassword(env, body.password as string))) {
    return json({ error: "This inbox is already set up." }, 409);
  }
  if (domain) await setSetting(env.DB, SETTING_MAIL_DOMAIN, domain);
  return json({ ok: true }, 200, { "set-cookie": await sessionCookie(env) });
}

/* ----------------------------------------------------- signed-in routes */

const ROUTES = [
  route("GET", "/api/config", getConfig),
  route("GET", "/api/live", live),
  route("GET", "/api/push/key", pushKey),
  route("GET", "/api/push/subscriptions", pushStatus),
  route("POST", "/api/push/subscriptions", pushSubscribe),
  route("DELETE", "/api/push/subscriptions", pushUnsubscribe),
  route("PUT", "/api/settings", updateSettings),
  route("POST", "/api/password", changePassword),
  route("GET", "/api/addresses", listAddresses),
  route("PUT", "/api/addresses/:address/label", putLabel),
  route("PUT", "/api/addresses/:address", putAddress),
  route("DELETE", "/api/addresses/:address", forgetAddress),
  route("GET", "/api/messages", listMessages),
  route("DELETE", "/api/messages", deleteMessages),
  route("PATCH", "/api/messages", patchMessages),
  route("POST", "/api/read-all", markAllRead),
  route("POST", "/api/messages/restore", restoreMessages),
  route("POST", "/api/messages/:id/restore", restoreMessage),
  route("GET", "/api/messages/:id", getMessage),
  route("PATCH", "/api/messages/:id", updateMessage),
  route("DELETE", "/api/messages/:id", deleteMessage),
  route("GET", "/api/messages/:id/attachments/:idx", downloadAttachment),
  route("GET", "/api/messages/:id/export", exportMessage),
  route("POST", "/api/messages/:id/unsubscribe", unsubscribe),
];

function route(method: string, path: string, handler: Handler) {
  // "/api/messages/:id" becomes /^\/api\/messages\/(?<id>[^/]+)$/
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
  return { method, pattern, handler };
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  for (const { method, pattern, handler } of ROUTES) {
    if (method !== request.method) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(match.groups ?? {})) {
      try {
        params[name] = decodeURIComponent(value);
      } catch {
        return json({ error: "Malformed URL" }, 400);
      }
    }
    return handler({ request, env, url, params });
  }
  return null;
}

/* ------------------------------------------------------------- config */

async function observedDomains(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT substr(address, instr(address, '@') + 1) AS domain, COUNT(*) AS n
         FROM messages WHERE deleted_at IS NULL GROUP BY domain ORDER BY n DESC LIMIT 10`
    )
    .all<{ domain: string }>();
  return results.map((row) => row.domain);
}

/** Everything the front-end needs to describe this instance. */
async function buildConfig(env: Env) {
  const allowed = allowedDomains(env);
  const chosen = await getSetting(env.DB, SETTING_MAIL_DOMAIN);
  const observed = await observedDomains(env.DB);
  const limits = await resolveLimits(env.DB);
  return {
    mailDomain: allowed[0] ?? chosen ?? observed[0] ?? null,
    domainSource: allowed[0] ? "env" : chosen ? "settings" : observed[0] ? "observed" : null,
    allowedDomains: allowed,
    observedDomains: observed,
    passwordSource: await passwordSource(env),
    retentionDays: limits.retentionDays,
    limits: {
      perAddress: limits.perAddress,
      total: limits.total,
      rawBytes: limits.rawBytes,
      attachmentBytes: limits.attachmentBytes,
    },
    ranges: LIMIT_RANGES,
  };
}

async function getConfig({ env }: Ctx): Promise<Response> {
  return json(await buildConfig(env));
}

/**
 * Numeric setting: works out what the write should be without performing it,
 * so a form with one bad field can be rejected whole. Returns a complaint, a
 * write to run, or null when the field was not sent at all.
 */
type Write = { key: string; value: string | null };
function planNumber(
  body: Record<string, unknown>, field: string, key: string,
  range: { min: number; max: number }
): { error: string } | { write: Write } | null {
  if (!(field in body)) return null;
  const raw = body[field];
  if (raw === null || raw === "") return { write: { key, value: null } };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < range.min || n > range.max) {
    return { error: `${field} must be between ${range.min} and ${range.max}.` };
  }
  return { write: { key, value: String(n) } };
}

/**
 * Settings save all-or-nothing. Every field is checked first and only then
 * written, because the form sends them together: validating and writing in one
 * pass meant a rejected `total` still left a changed `retentionDays` behind,
 * and the 400 told the reader nothing had been saved.
 */
async function updateSettings({ request, env }: Ctx): Promise<Response> {
  const body = await readJson(request);
  const writes: Write[] = [];

  if ("mailDomain" in body) {
    const domain = normalizeDomain(body.mailDomain);
    if (domain === null) return json({ error: "That doesn't look like a domain name." }, 400);
    writes.push({ key: SETTING_MAIL_DOMAIN, value: domain || null });
  }

  for (const [field, key, range] of [
    ["retentionDays", SETTING_RETENTION_DAYS, LIMIT_RANGES.retentionDays],
    ["perAddress", SETTING_PER_ADDRESS, LIMIT_RANGES.perAddress],
    ["total", SETTING_GLOBAL_CAP, LIMIT_RANGES.total],
    ["rawMb", SETTING_RAW_MB, LIMIT_RANGES.rawMb],
    ["attachmentMb", SETTING_ATTACHMENT_MB, LIMIT_RANGES.attachmentMb],
  ] as const) {
    const planned = planNumber(body, field, key, range);
    if (planned && "error" in planned) return json({ error: planned.error }, 400);
    if (planned) writes.push(planned.write);
  }

  for (const w of writes) {
    if (w.value === null) await deleteSetting(env.DB, w.key);
    else await setSetting(env.DB, w.key, w.value);
  }
  return json(await buildConfig(env));
}

async function changePassword({ request, env }: Ctx): Promise<Response> {
  if (env.AUTH_PASSWORD) {
    return json({ error: "The password is set by the AUTH_PASSWORD secret. Change it in the Cloudflare dashboard." }, 400);
  }
  const ip = clientIp(request);
  // A mistyped current password must not lock this IP out of signing in.
  const locked = lockoutSecondsLeft(ip, "password-change");
  if (locked > 0) return json({ error: `Too many attempts. Try again in ${describeWait(locked)}.` }, 429);

  const body = await readJson(request);
  if (!(await checkPassword(env, String(body.currentPassword ?? "")))) {
    noteFailedLogin(ip, "password-change");
    await sleep(500);
    return json({ error: "The current password is wrong." }, 401);
  }
  const problem = passwordProblem(body.newPassword);
  if (problem) return json({ error: problem }, 400);

  await replacePassword(env, body.newPassword as string);
  clearFailedLogins(ip, "password-change");
  // Every other device is now signed out; keep this one signed in.
  return json({ ok: true }, 200, { "set-cookie": await sessionCookie(env) });
}

/* ---------------------------------------------------------- addresses */

const MAX_LABEL_LENGTH = 40;

interface AddressListRow extends AddressRow {
  count: number | null;
  unread: number | null;
  starred: number | null;
  last_received_at: number | null;
}

/**
 * GET /api/addresses — every address with its counts, lifecycle and leaks.
 * Addresses without mail (fresh burners) are listed too.
 */
async function listAddresses({ env }: Ctx): Promise<Response> {
  const now = Date.now();
  const [{ results: rows }, { results: senders }] = await Promise.all([
    env.DB.prepare(
      // Every address with a row or with mail: a burner made a minute ago
      // and an address that only ever received mail both belong here.
      `SELECT u.address, a.label, COALESCE(a.mode, 'permanent') AS mode, a.expires_at, a.owner_domain,
              COALESCE(a.created_at, m.first_received_at) AS created_at, a.first_seen_at,
              m.count, m.unread, m.starred, m.last_received_at
         FROM (SELECT address FROM addresses UNION SELECT address FROM messages WHERE deleted_at IS NULL) u
         LEFT JOIN addresses a ON a.address = u.address
         LEFT JOIN (SELECT address, COUNT(*) AS count, SUM(read = 0) AS unread, SUM(starred) AS starred,
                           MAX(received_at) AS last_received_at, MIN(received_at) AS first_received_at
                      FROM messages WHERE deleted_at IS NULL GROUP BY address) m ON m.address = u.address
        ORDER BY COALESCE(m.last_received_at, a.created_at) DESC`
    ).all<AddressListRow>(),
    env.DB.prepare(
      `SELECT address, substr(from_address, instr(from_address, '@') + 1) AS domain, COUNT(*) AS n, MAX(received_at) AS last
         FROM messages WHERE deleted_at IS NULL GROUP BY address, domain`
    ).all<{ address: string; domain: string; n: number; last: number }>(),
  ]);

  const owners = new Map(rows.map((row) => [row.address, row.owner_domain]));
  const leaksFor = new Map<string, { domain: string; count: number; last: number }[]>();
  for (const sender of senders) {
    const owner = owners.get(sender.address);
    if (!owner || !sender.domain || relatedDomain(sender.domain, owner)) continue;
    const list = leaksFor.get(sender.address) ?? [];
    list.push({ domain: sender.domain.toLowerCase(), count: sender.n, last: sender.last });
    leaksFor.set(sender.address, list);
  }

  return json({
    addresses: rows.map((row) => ({
      address: row.address,
      label: row.label ?? null,
      count: row.count ?? 0,
      unread: row.unread ?? 0,
      starred: row.starred ?? 0,
      lastReceivedAt: row.last_received_at ?? null,
      mode: row.mode,
      expiresAt: row.expires_at ?? null,
      ownerDomain: row.owner_domain ?? null,
      firstSeenAt: row.first_seen_at ?? null,
      createdAt: row.created_at,
      expired: row.mode === "expires" && row.expires_at != null && row.expires_at <= now,
      dead: isDead(row, now),
      leaks: (leaksFor.get(row.address) ?? []).sort((a, b) => b.last - a.last),
    })),
  });
}

const ADDRESS_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * PUT /api/addresses/:address  { mode?, ttlHours?, expiresAt?, ownerDomain?, label? }
 * Creates or updates an address's lifecycle. Block and unblock are just
 * mode "blocked" and mode "permanent".
 */
async function putAddress({ request, env, params }: Ctx): Promise<Response> {
  const address = params.address.trim().toLowerCase();
  if (!ADDRESS_SHAPE.test(address)) return json({ error: "That is not an address" }, 400);
  const body = await readJson(request);
  const now = Date.now();

  const sets: string[] = [];
  const binds: unknown[] = [];
  let mode: string | null = null;
  if (body.mode !== undefined) {
    if (!isAddressMode(body.mode)) return json({ error: "Unknown mode" }, 400);
    mode = body.mode;
  }
  let expiresAt: number | null = null;
  if (mode === "expires") {
    const { min, max } = LIMIT_RANGES.burnerHours;
    if (typeof body.ttlHours === "number") {
      if (!Number.isFinite(body.ttlHours) || body.ttlHours < min || body.ttlHours > max) {
        return json({ error: `ttlHours must be between ${min} and ${max}` }, 400);
      }
      expiresAt = now + body.ttlHours * 60 * 60 * 1000;
    } else if (typeof body.expiresAt === "number") {
      if (body.expiresAt <= now) return json({ error: "The expiry must be in the future" }, 400);
      if (body.expiresAt > now + max * 60 * 60 * 1000) return json({ error: `A burner can live at most ${max} hours` }, 400);
      expiresAt = Math.round(body.expiresAt);
    } else {
      return json({ error: "An expiring address needs ttlHours or expiresAt" }, 400);
    }
  }
  if (mode) {
    sets.push(`mode = ?${binds.push(mode)}`);
    sets.push(`expires_at = ?${binds.push(expiresAt)}`);
  }
  if (body.ownerDomain !== undefined) {
    const owner = normalizeDomain(body.ownerDomain);
    if (owner === null) return json({ error: "That is not a domain" }, 400);
    sets.push(`owner_domain = ?${binds.push(owner || null)}`);
  }
  if (body.label !== undefined) {
    const label = String(body.label ?? "").trim().slice(0, MAX_LABEL_LENGTH);
    sets.push(`label = ?${binds.push(label || null)}`);
  }
  if (!sets.length) return json({ error: "Nothing to change" }, 400);

  await env.DB.prepare("INSERT OR IGNORE INTO addresses (address, mode, created_at) VALUES (?1, 'permanent', ?2)").bind(address, now).run();
  await env.DB.prepare(`UPDATE addresses SET ${sets.join(", ")} WHERE address = ?${binds.push(address)}`).bind(...binds).run();

  const row = await env.DB.prepare("SELECT * FROM addresses WHERE address = ?1").bind(address).first<AddressRow>();
  // Deleting the inbox in another tab between the write above and this read
  // leaves nothing to describe; say so instead of throwing on a null row.
  if (!row) return json({ error: "That address no longer exists" }, 404);
  return json({
    ok: true,
    address: row.address,
    label: row.label ?? null,
    mode: row.mode,
    expiresAt: row.expires_at ?? null,
    ownerDomain: row.owner_domain ?? null,
    dead: isDead(row, now),
  });
}

/** DELETE /api/addresses/:address forgets the lifecycle row; its mail stays. */
async function forgetAddress({ env, params }: Ctx): Promise<Response> {
  const result = await env.DB.prepare("DELETE FROM addresses WHERE address = ?1").bind(params.address.trim().toLowerCase()).run();
  return json({ ok: true, forgotten: result.meta.changes });
}


async function putLabel({ request, env, params }: Ctx): Promise<Response> {
  // Without this, any path segment became an addresses row: PUT
  // /api/addresses/../label wrote a lifecycle for the literal string "..".
  const address = params.address.trim().toLowerCase();
  if (!ADDRESS_SHAPE.test(address)) return json({ error: "That is not an address" }, 400);
  const body = await readJson(request);
  const label = String(body.label ?? "").trim().slice(0, MAX_LABEL_LENGTH);
  await setLabel(env.DB, address, label);
  return json({ ok: true, label: label || null });
}

/* ----------------------------------------------------------- messages */

interface ListRow {
  id: string;
  address: string;
  from_name: string | null;
  from_address: string;
  subject: string | null;
  snippet: string | null;
  code: string | null;
  received_at: number;
  read: number;
  starred: number;
  has_attachments: number;
}

function toListItem(row: ListRow) {
  return {
    id: row.id,
    address: row.address,
    fromName: row.from_name,
    fromAddress: row.from_address,
    subject: row.subject,
    snippet: row.snippet,
    code: row.code,
    receivedAt: row.received_at,
    read: !!row.read,
    starred: !!row.starred,
    hasAttachments: !!row.has_attachments,
  };
}

/** A ?limit= from the query string, or the default when it is absent or junk. */
function clampPageSize(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Cursors are "<receivedAt>:<id>" of the last row on the previous page. */
function parseCursor(value: string | null): { receivedAt: number; id: string } | null {
  if (!value) return null;
  const colon = value.indexOf(":");
  const receivedAt = Number(value.slice(0, colon));
  const id = value.slice(colon + 1);
  return colon > 0 && Number.isSafeInteger(receivedAt) && id ? { receivedAt, id } : null;
}

/**
 * GET /api/messages?address=&q=&cursor=&limit=&unread=1&starred=1
 * Newest first. Search is a case-insensitive substring match over the
 * subject, sender, recipient and snippet.
 */
async function listMessages({ env, url }: Ctx): Promise<Response> {
  const address = url.searchParams.get("address")?.trim().toLowerCase() || null;
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const limit = clampPageSize(url.searchParams.get("limit"), PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const cursorText = url.searchParams.get("cursor");
  const cursor = parseCursor(cursorText);
  if (cursorText && !cursor) return json({ error: "Bad cursor" }, 400);

  const where: string[] = ["deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (address) where.push(`address = ?${binds.push(address)}`);
  if (url.searchParams.get("unread") === "1") where.push("read = 0");
  if (url.searchParams.get("starred") === "1") where.push("starred = 1");
  if (query) {
    const like = "%" + query.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    const n = binds.push(like);
    where.push(
      `(subject LIKE ?${n} ESCAPE '\\' OR from_name LIKE ?${n} ESCAPE '\\' OR from_address LIKE ?${n} ESCAPE '\\'` +
        ` OR address LIKE ?${n} ESCAPE '\\' OR snippet LIKE ?${n} ESCAPE '\\')`
    );
  }
  if (cursor) {
    const t = binds.push(cursor.receivedAt);
    const i = binds.push(cursor.id);
    where.push(`(received_at < ?${t} OR (received_at = ?${t} AND id < ?${i}))`);
  }
  const lim = binds.push(limit + 1); // one extra row tells us whether there is another page

  const sql =
    `SELECT id, address, from_name, from_address, subject,
            COALESCE(snippet, substr(text_body, 1, ${SNIPPET_LENGTH})) AS snippet, code, received_at, read, starred,
            (attachments IS NOT NULL AND attachments != '[]') AS has_attachments
       FROM messages` +
    ` WHERE ${where.join(" AND ")}` +
    ` ORDER BY received_at DESC, id DESC LIMIT ?${lim}`;

  const { results } = await env.DB.prepare(sql).bind(...binds).all<ListRow>();
  const hasMore = results.length > limit;
  const rows = hasMore ? results.slice(0, limit) : results;
  const last = rows[rows.length - 1];
  return json({
    messages: rows.map(toListItem),
    hasMore,
    nextCursor: hasMore && last ? `${last.received_at}:${last.id}` : null,
  });
}

interface MessageRow {
  id: string; address: string; from_name: string | null; from_address: string; subject: string | null;
  code: string | null; text_body: string | null; html_body: string | null; attachments: string | null;
  received_at: number; read: number; starred: number;
  message_id: string | null; in_reply_to: string | null; references_hdr: string | null; reply_to: string | null;
  sent_at: number | null; list_unsubscribe: string | null; list_unsubscribe_post: string | null;
  auth_results: string | null; auth_summary: string | null;
}

function authOf(row: MessageRow): AuthSummary | null {
  if (!row.auth_summary) return null;
  try { return JSON.parse(row.auth_summary) as AuthSummary; } catch { return null; }
}

/** What the reader needs to offer an Unsubscribe action, or null. */
function unsubscribeOf(row: MessageRow) {
  const links = parseListUnsubscribe(row.list_unsubscribe);
  if (!links) return null;
  return { oneClick: isOneClick(row.list_unsubscribe_post) && !!links.https, https: links.https, mailto: links.mailto };
}

/** The attachment list for a message, preferring the table over the old column. */
async function attachmentsFor(db: D1Database, row: MessageRow): Promise<StoredAttachment[]> {
  const { results } = await db
    .prepare("SELECT idx, filename, content_type, size, content_id, inline, chunks FROM attachments WHERE message_id = ?1 ORDER BY idx")
    .bind(row.id)
    .all<{ idx: number; filename: string; content_type: string; size: number; content_id: string | null; inline: number; chunks: number }>();

  if (results.length) {
    return results.map((a) => ({
      filename: a.filename,
      contentType: a.content_type,
      size: a.size,
      contentId: a.content_id ?? undefined,
      inline: !!a.inline,
      stored: a.chunks > 0,
    }));
  }

  // Messages stored before attachments moved into their own table.
  try {
    const legacy = row.attachments ? JSON.parse(row.attachments) : [];
    return Array.isArray(legacy)
      ? legacy.map((a: any) => ({
          filename: a.filename, contentType: a.contentType, size: a.size,
          contentId: a.contentId, inline: a.inline, stored: !!a.base64,
        }))
      : [];
  } catch {
    return [];
  }
}

/** GET /api/messages/:id — the full message. Opening it marks it read. */
async function getMessage({ env, params }: Ctx): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?1 AND deleted_at IS NULL").bind(params.id).first<MessageRow>();
  if (!row) return json({ error: "Message not found" }, 404);
  if (!row.read) await env.DB.prepare("UPDATE messages SET read = 1 WHERE id = ?1").bind(row.id).run();

  return json({
    id: row.id,
    address: row.address,
    fromName: row.from_name,
    fromAddress: row.from_address,
    subject: row.subject,
    code: row.code,
    textBody: row.text_body,
    htmlBody: row.html_body,
    attachments: await attachmentsFor(env.DB, row),
    receivedAt: row.received_at,
    starred: !!row.starred,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    replyTo: row.reply_to,
    sentAt: row.sent_at,
    auth: authOf(row),
    unsubscribe: unsubscribeOf(row),
  });
}

/**
 * POST /api/messages/:id/unsubscribe
 * With a List-Unsubscribe-Post promise and an https link, the Worker makes
 * the RFC 8058 one-click request itself. Otherwise the client is told what to
 * open. Only public https hosts are ever contacted.
 */
async function unsubscribe({ env, params }: Ctx): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?1 AND deleted_at IS NULL").bind(params.id).first<MessageRow>();
  if (!row) return json({ error: "Message not found" }, 404);
  const links = parseListUnsubscribe(row.list_unsubscribe);
  if (!links) return json({ error: "This message has no unsubscribe link" }, 404);

  const url = publicHttpsUrl(links.https);
  if (links.https && !url) {
    if (links.mailto) return json({ ok: true, method: "mailto", url: links.mailto });
    return json({ error: "The unsubscribe link points somewhere this inbox will not call" }, 400);
  }
  if (url && isOneClick(row.list_unsubscribe_post)) {
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "tempmail-unsubscribe" },
        body: "List-Unsubscribe=One-Click",
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      const done = res.status >= 200 && res.status < 400;
      return json({ ok: done, method: "post", status: res.status, url: url.toString() }, done ? 200 : 502);
    } catch (err) {
      console.warn("unsubscribe request failed", err);
      return json({ ok: false, method: "post", error: "The sender's unsubscribe service did not answer", url: url.toString() }, 502);
    }
  }
  if (url) return json({ ok: true, method: "open", url: url.toString() });
  return json({ ok: true, method: "mailto", url: links.mailto });
}

/**
 * The SET clauses for a read/starred PATCH, appending their values to `binds`.
 * Shared so the single-message and bulk routes cannot drift apart on what a
 * PATCH is allowed to change.
 */
function readStarredSets(body: Record<string, unknown>, binds: unknown[]): string[] {
  const sets: string[] = [];
  if (typeof body.read === "boolean") sets.push(`read = ?${binds.push(body.read ? 1 : 0)}`);
  if (typeof body.starred === "boolean") sets.push(`starred = ?${binds.push(body.starred ? 1 : 0)}`);
  return sets;
}

/** PATCH /api/messages/:id  { read?: boolean, starred?: boolean } */
async function updateMessage({ request, env, params }: Ctx): Promise<Response> {
  const body = await readJson(request);
  const binds: unknown[] = [];
  const sets = readStarredSets(body, binds);
  if (!sets.length) return json({ error: "Nothing to update" }, 400);

  const result = await env.DB.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?${binds.push(params.id)} AND deleted_at IS NULL`)
    .bind(...binds)
    .run();
  if (result.meta.changes === 0) return json({ error: "Message not found" }, 404);
  return json({ ok: true });
}

/**
 * DELETE /api/messages/:id moves the message to the trash. The row and its
 * attachments stay for TRASH_TTL_MS so the delete can be undone; the nightly
 * cron removes them for real.
 */
async function deleteMessage({ env, params }: Ctx): Promise<Response> {
  const result = await env.DB.prepare("UPDATE messages SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL")
    .bind(Date.now(), params.id)
    .run();
  if (result.meta.changes === 0) return json({ error: "Message not found" }, 404);
  return json({ ok: true });
}

/** POST /api/messages/:id/restore brings one message back from the trash. */
async function restoreMessage({ env, params }: Ctx): Promise<Response> {
  const result = await env.DB.prepare("UPDATE messages SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL")
    .bind(params.id)
    .run();
  if (result.meta.changes === 0) return json({ error: "Nothing to restore" }, 404);
  return json({ ok: true });
}

/** POST /api/messages/restore { ids } restores many at once. */
async function restoreMessages({ request, env }: Ctx): Promise<Response> {
  const ids = idsFrom(await readJson(request));
  if (!ids.length) return json({ error: "No message ids given" }, 400);
  let restored = 0;
  for (const chunk of idChunks(ids)) {
    const holes = chunk.map((_, n) => `?${n + 1}`).join(",");
    const result = await env.DB.prepare(`UPDATE messages SET deleted_at = NULL WHERE id IN (${holes}) AND deleted_at IS NOT NULL`)
      .bind(...chunk)
      .run();
    restored += result.meta.changes;
  }
  return json({ ok: true, restored });
}



/** Reads an ids array from a body, capped so one call cannot run away. */
function idsFrom(body: Record<string, unknown>): string[] {
  const raw = body.ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 200);
}

/**
 * PATCH /api/messages  { ids: [...], read?, starred? }
 * Bulk version of the single-message patch.
 */
async function patchMessages({ request, env }: Ctx): Promise<Response> {
  const body = await readJson(request);
  const ids = idsFrom(body);
  if (!ids.length) return json({ error: "No message ids given" }, 400);

  const values: unknown[] = [];
  const sets = readStarredSets(body, values);
  if (!sets.length) return json({ error: "Nothing to update" }, 400);

  let updated = 0;
  for (const chunk of idChunks(ids, values.length)) {
    const holes = chunk.map((_, n) => `?${values.length + n + 1}`).join(",");
    const result = await env.DB.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id IN (${holes}) AND deleted_at IS NULL`)
      .bind(...values, ...chunk)
      .run();
    updated += result.meta.changes;
  }
  return json({ ok: true, updated });
}

/**
 * DELETE /api/messages
 *   ?address=x  wipes one address
 *   ?all=1      wipes everything
 *   body {ids}  deletes just those
 * Starred mail is only removed when explicitly selected or when the whole
 * inbox is wiped.
 */
async function deleteMessages({ request, env, url }: Ctx): Promise<Response> {
  const address = url.searchParams.get("address")?.trim().toLowerCase();

  if (request.headers.get("content-type")?.includes("json")) {
    const ids = idsFrom(await readJson(request));
    if (ids.length) {
      // Selected messages go to the trash, like a single delete.
      const now = Date.now();
      let deleted = 0;
      for (const chunk of idChunks(ids, 1)) {
        const holes = chunk.map((_, n) => `?${n + 2}`).join(",");
        const result = await env.DB.prepare(`UPDATE messages SET deleted_at = ?1 WHERE id IN (${holes}) AND deleted_at IS NULL`)
          .bind(now, ...chunk)
          .run();
        deleted += result.meta.changes;
      }
      return json({ ok: true, deleted });
    }
  }

  if (address) {
    const { results } = await env.DB.prepare("SELECT id FROM messages WHERE address = ?1").bind(address).all<{ id: string }>();
    await deleteAttachmentsFor(env.DB, results.map((r) => r.id));
    const result = await env.DB.prepare("DELETE FROM messages WHERE address = ?1").bind(address).run();
    return json({ ok: true, deleted: result.meta.changes });
  }

  if (url.searchParams.get("all") === "1") {
    const result = await env.DB.prepare("DELETE FROM messages").run();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM attachment_chunks"),
      env.DB.prepare("DELETE FROM attachments"),
    ]);
    return json({ ok: true, deleted: result.meta.changes });
  }

  return json({ error: "Say which address to wipe, pass all=1, or send ids" }, 400);
}

/** POST /api/read-all?address=x marks one address read; without it, everything. */
async function markAllRead({ env, url }: Ctx): Promise<Response> {
  const raw = url.searchParams.get("address");
  // "?address=" is a caller that meant to scope the call and lost the value;
  // treating it as "no address" would silently clear the entire inbox.
  if (raw !== null && !raw.trim()) return json({ error: "No address given" }, 400);
  const address = raw?.trim().toLowerCase();
  if (address) {
    await env.DB.prepare("UPDATE messages SET read = 1 WHERE address = ?1 AND read = 0 AND deleted_at IS NULL").bind(address).run();
  } else {
    await env.DB.prepare("UPDATE messages SET read = 1 WHERE read = 0 AND deleted_at IS NULL").run();
  }
  return json({ ok: true });
}

/* -------------------------------------------------------- attachments */

/**
 * GET /api/messages/:id/attachments/:idx
 *
 * Streams the attachment back, pulling a few base64 chunks per query and
 * decoding them as it goes, so a 25 MB file never sits in memory whole.
 */
async function downloadAttachment({ env, params, url }: Ctx): Promise<Response> {
  const idx = Number(params.idx);
  if (!Number.isInteger(idx) || idx < 0) return json({ error: "Bad attachment index" }, 400);

  const meta = await env.DB
    .prepare(
      `SELECT a.filename, a.content_type, a.size, a.chunks FROM attachments a
         JOIN messages m ON m.id = a.message_id AND m.deleted_at IS NULL
        WHERE a.message_id = ?1 AND a.idx = ?2`
    )
    .bind(params.id, idx)
    .first<{ filename: string; content_type: string; size: number; chunks: number }>();
  if (!meta) return json({ error: "Attachment not found" }, 404);
  // No chunks and a non-zero size means the bytes were dropped at delivery for
  // being over the limit. No chunks and no size is simply an empty file.
  if (meta.chunks === 0 && meta.size > 0) return json({ error: "This attachment was too large to keep" }, 410);

  let seq = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (seq >= meta.chunks) {
        controller.close();
        return;
      }
      const { results } = await env.DB
        .prepare("SELECT data FROM attachment_chunks WHERE message_id = ?1 AND idx = ?2 AND seq >= ?3 ORDER BY seq LIMIT ?4")
        .bind(params.id, idx, seq, ATTACHMENT_CHUNKS_PER_READ)
        .all<{ data: string }>();
      if (!results.length) {
        controller.close();
        return;
      }
      for (const row of results) {
        const binary = atob(row.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        controller.enqueue(bytes);
      }
      seq += results.length;
    },
  });

  // Inline images render in the message frame; everything else downloads.
  const inline = url.searchParams.get("inline") === "1";
  const safeType = meta.content_type.replace(/[^\w.+/-]/g, "") || "application/octet-stream";
  return withSecurityHeaders(
    new Response(stream, {
      headers: {
        "content-type": inline ? safeType : "application/octet-stream",
        "content-length": String(meta.size),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${meta.filename.replace(/["\\\r\n]/g, "_")}"`,
        "cache-control": "private, max-age=3600",
      },
    })
  );
}

/** GET /api/messages/:id/export — the message as a plain .txt file. */
async function exportMessage({ env, params }: Ctx): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?1 AND deleted_at IS NULL").bind(params.id).first<MessageRow>();
  if (!row) return json({ error: "Message not found" }, 404);

  const attachments = await attachmentsFor(env.DB, row);
  const body = [
    `From: ${row.from_name ? `${row.from_name} <${row.from_address}>` : row.from_address}`,
    `To: ${row.address}`,
    `Date: ${new Date(row.sent_at ?? row.received_at).toUTCString()}`,
    `Subject: ${row.subject ?? "(no subject)"}`,
    row.message_id ? `Message-ID: ${row.message_id}` : null,
    row.auth_summary ? `Authentication: ${Object.entries(authOf(row) ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")}` : null,
    attachments.length ? `Attachments: ${attachments.map((a) => `${a.filename} (${a.size} bytes)`).join(", ")}` : null,
    "",
    row.text_body ?? (row.html_body ? "(HTML only — open it in the app to read it)" : "(empty message)"),
  ]
    .filter((line) => line !== null)
    .join("\n");

  const name = (row.subject ?? "message").replace(/[^\w -]+/g, "").trim().slice(0, 60) || "message";
  return withSecurityHeaders(
    new Response(body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${name}.txt"`,
      },
    })
  );
}

/**
 * POST /api/dev/ingest?to=&from= with the raw RFC 822 message as the body.
 * Simulates Email Routing for local development. Needs no session, only the
 * INGEST_KEY variable (see .dev.vars.example); without that it doesn't exist.
 */
async function devIngest(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  if (!env.INGEST_KEY || request.headers.get("x-ingest-key") !== env.INGEST_KEY) {
    return json({ error: "Not found" }, 404);
  }
  const result = await storeInboundEmail(env, {
    to: url.searchParams.get("to") ?? "",
    from: url.searchParams.get("from") ?? "unknown@unknown.invalid",
    raw: await request.arrayBuffer(),
  });
  if (result.ok) afterIngest(env, ctx, result);
  return result.ok ? json(result) : json(result, 422);
}

/* ----------------------------------------------------------------- push */

/** GET /api/push/key — the VAPID public key a browser subscribes with. */
async function pushKey({ env }: Ctx): Promise<Response> {
  return json({ key: (await getVapidKeys(env)).publicKey });
}

/** GET /api/push/subscriptions?endpoint= — how many devices, and whether this one is among them. */
async function pushStatus({ env, url }: Ctx): Promise<Response> {
  const endpoint = url.searchParams.get("endpoint");
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
  const mine = endpoint
    ? await env.DB.prepare("SELECT 1 AS one FROM push_subscriptions WHERE endpoint = ?1").bind(endpoint).first()
    : null;
  return json({ devices: count?.n ?? 0, registered: !!mine });
}

/** POST /api/push/subscriptions — the browser's PushSubscription.toJSON(). */
async function pushSubscribe({ request, env }: Ctx): Promise<Response> {
  const body = await readJson(request);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys.auth === "string" ? keys.auth : "";
  if (endpoint.length > 2000 || !p256dh || !auth) return json({ error: "That is not a push subscription" }, 400);
  // The Worker POSTs here on every arrival, so it must not be able to reach
  // inside the network: same host rules as an unsubscribe link.
  if (!publicHttpsUrl(endpoint)) return json({ error: "That push endpoint is not a public https address" }, 400);
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, user_agent) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`
  ).bind(endpoint, p256dh, auth, Date.now(), request.headers.get("user-agent")?.slice(0, 200) ?? null).run();
  return json({ ok: true });
}

/** DELETE /api/push/subscriptions { endpoint } */
async function pushUnsubscribe({ request, env }: Ctx): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.endpoint !== "string") return json({ error: "Which endpoint?" }, 400);
  const result = await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(body.endpoint).run();
  return json({ ok: true, removed: result.meta.changes });
}

/**
 * GET /api/live — upgrades to a WebSocket that announces new mail.
 * The session gate has already run. Browsers always send Origin on a
 * WebSocket handshake, so a foreign page cannot open one with our cookie.
 * The Durable Object's 101 response goes back untouched: rebuilding it
 * would drop the socket.
 */
async function live({ request, env, url }: Ctx): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
  if (request.headers.get("origin") !== url.origin) return json({ error: "Wrong origin" }, 403);
  return hubStub(env).fetch(request);
}
