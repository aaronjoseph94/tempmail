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
  timingSafeEqual,
} from "./auth";
import {
  deleteAttachmentsFor, deleteSetting, getSetting, idChunks, setLabel, setSetting,
  SETTING_ATTACHMENT_MB, SETTING_GLOBAL_CAP, SETTING_BRAND_NAME, SETTING_MAIL_DOMAIN, SETTING_PER_ADDRESS,
  SETTING_RAW_MB, SETTING_RETENTION_DAYS, SETTING_MAIL_DOMAINS, SETTING_SCREENER,
  SETTING_JUNK_TRAINED_HAM, SETTING_JUNK_TRAINED_JUNK, getSettings,
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
import { BOXES, isBox, isVerdict, type Box } from "./classify";
import { JUNK_MIN_TRAINED, junkTokens, trainTokens } from "./junk";
import { MAX_RULES, MAX_RULE_VALUE, RULE_ACTIONS, RULE_FIELDS, isRuleAction, isRuleField, needsValue } from "./rules";
import { htmlToText } from "./text";
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

/**
 * The name the site goes by. A fork should not have to edit five files and a
 * manifest to stop calling itself someone else's inbox.
 */
export const BRAND_DEFAULT = "Temp Email";
const MAX_BRAND_LENGTH = 40;

async function brandName(env: Env): Promise<string> {
  return (await getSetting(env.DB, SETTING_BRAND_NAME)) || BRAND_DEFAULT;
}

/**
 * What the sign-in page needs: is anyone signed in, is there a password, and
 * what should the page call itself.
 *
 * The brand rides along here rather than on an endpoint of its own because
 * login.js already calls this before any session exists, and the sign-in
 * screen has to render the name too.
 */
async function status(request: Request, env: Env): Promise<Response> {
  const source = await passwordSource(env);
  return json({
    authed: source !== "none" && (await hasValidSession(request, env)),
    setupRequired: source === "none",
    passwordSource: source,
    brandName: await brandName(env),
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
  route("GET", "/api/addresses/:address/subscriptions", listSubscriptions),
  route("POST", "/api/unsubscribe", unsubscribeMany),
  route("GET", "/api/rules", listRules),
  route("PUT", "/api/rules", putRules),
  route("POST", "/api/junk", markJunk),
  route("DELETE", "/api/junk", forgetJunk),
  route("GET", "/api/senders", listSenders),
  route("POST", "/api/senders/:address", decideSender),
];

function route(method: string, path: string, handler: Handler) {
  // "/api/messages/:id" becomes /^\/api\/messages\/(?<id>[^/]+)$/
  //
  // The path is escaped first, so a literal dot in a route -- "/api/x.mbox" --
  // matches a dot rather than any character. Neither ":" nor a word character
  // is a metacharacter, so the placeholder substitution still sees what it
  // expects afterwards.
  const literal = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^" + literal.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
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

/** At most this many domains. The picker is a list, not a directory. */
export const MAX_DOMAINS = 10;

/**
 * Every domain this inbox offers, most-preferred first.
 *
 * Reading is where the single-domain past is folded in, so no migration has to
 * run: a database that only ever had `mail_domain` reads as a one-item list,
 * and the first save of a list writes both rows.
 */
async function storedDomains(db: D1Database): Promise<string[]> {
  const raw = await getSetting(db, SETTING_MAIL_DOMAINS);
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter((d): d is string => typeof d === "string" && !!d);
    } catch { /* a corrupt row falls back to the single domain below */ }
  }
  const one = await getSetting(db, SETTING_MAIL_DOMAIN);
  return one ? [one] : [];
}

/**
 * The domains to show and generate against, and where they came from.
 *
 * MAIL_DOMAIN wins when it is set, because that variable is the one thing here
 * that also decides what mail is accepted (domainAccepted in src/email.ts):
 * offering an address at a domain the Worker would bounce is worse than not
 * offering it. Otherwise the owner's list, and failing that whatever has
 * actually been receiving mail.
 */
async function resolveDomains(env: Env): Promise<{ domains: string[]; source: string | null }> {
  const allowed = allowedDomains(env);
  if (allowed.length) return { domains: allowed.slice(0, MAX_DOMAINS), source: "env" };
  const stored = await storedDomains(env.DB);
  if (stored.length) return { domains: stored.slice(0, MAX_DOMAINS), source: "settings" };
  const observed = await observedDomains(env.DB);
  return { domains: observed.slice(0, MAX_DOMAINS), source: observed.length ? "observed" : null };
}

/** Everything the front-end needs to describe this instance. */
async function buildConfig(env: Env) {
  const allowed = allowedDomains(env);
  const observed = await observedDomains(env.DB);
  const limits = await resolveLimits(env.DB);
  const { domains, source } = await resolveDomains(env);
  return {
    brandName: await brandName(env),
    mailDomain: domains[0] ?? null,
    mailDomains: domains,
    domainSource: source,
    maxDomains: MAX_DOMAINS,
    allowedDomains: allowed,
    observedDomains: observed,
    passwordSource: await passwordSource(env),
    screener: (await getSetting(env.DB, SETTING_SCREENER)) === "1",
    junk: await junkTraining(env.DB),
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

  if ("brandName" in body) {
    const name = String(body.brandName ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_BRAND_LENGTH);
    writes.push({ key: SETTING_BRAND_NAME, value: name || null });
  }

  /*
   * One list, first entry is the default. `mailDomain` on its own is the old
   * single-domain call and still means "this is the default now": it moves the
   * domain to the front, adding it if the list had never heard of it, so an
   * older cached client cannot silently drop the other domains.
   */
  if ("mailDomains" in body || "mailDomain" in body) {
    let list = await storedDomains(env.DB);
    if ("mailDomains" in body) {
      if (!Array.isArray(body.mailDomains)) return json({ error: "mailDomains must be a list" }, 400);
      if (body.mailDomains.length > MAX_DOMAINS) return json({ error: `At most ${MAX_DOMAINS} domains.` }, 400);
      list = [];
      for (const entry of body.mailDomains) {
        const domain = normalizeDomain(entry);
        if (!domain) return json({ error: `"${String(entry).slice(0, 60)}" doesn't look like a domain name.` }, 400);
        if (!list.includes(domain)) list.push(domain);
      }
    }
    if ("mailDomain" in body) {
      const domain = normalizeDomain(body.mailDomain);
      if (domain === null) return json({ error: "That doesn't look like a domain name." }, 400);
      if (!domain) list = [];
      else {
        list = [domain, ...list.filter((d) => d !== domain)];
        if (list.length > MAX_DOMAINS) return json({ error: `At most ${MAX_DOMAINS} domains.` }, 400);
      }
    }
    writes.push({ key: SETTING_MAIL_DOMAINS, value: list.length ? JSON.stringify(list) : null });
    writes.push({ key: SETTING_MAIL_DOMAIN, value: list[0] ?? null });
  }

  /*
   * Turning the Screener on for the first time vouches for every sender the
   * owner has already been living with. Without that, the morning it is
   * switched on the entire inbox is held and the feature reads as broken.
   */
  if ("screener" in body) {
    const on = body.screener === true || body.screener === "1";
    if (on) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO senders (from_address, verdict, decided_at, first_seen_at)
           SELECT lower(from_address), 'allowed', ?1, MIN(received_at) FROM messages
            WHERE deleted_at IS NULL AND box = 'inbox' GROUP BY lower(from_address)`
      ).bind(Date.now()).run();
    }
    writes.push({ key: SETTING_SCREENER, value: on ? "1" : null });
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
/**
 * How many addresses the rail will render.
 *
 * The mail side is a catch-all, so anyone who guesses addresses at the domain
 * creates a row per guess. Without a ceiling one afternoon of that renders tens
 * of thousands of rail rows into the page and the app stops being usable.
 */
export const MAX_RAIL_ADDRESSES = 500;

async function listAddresses({ env }: Ctx): Promise<Response> {
  const now = Date.now();
  const [{ results: rows }, { results: senders }] = await Promise.all([
    env.DB.prepare(
      // Every address with a row or with mail: a burner made a minute ago
      // and an address that only ever received mail both belong here.
      `SELECT u.address, a.label, COALESCE(a.mode, 'permanent') AS mode, a.expires_at, a.owner_domain,
              COALESCE(a.created_at, m.first_received_at) AS created_at, a.first_seen_at,
              m.count, m.unread, m.starred, m.last_received_at
         FROM (SELECT address FROM addresses UNION SELECT address FROM messages WHERE deleted_at IS NULL AND box = 'inbox') u
         LEFT JOIN addresses a ON a.address = u.address
         LEFT JOIN (SELECT address, COUNT(*) AS count, SUM(read = 0) AS unread, SUM(starred) AS starred,
                           MAX(received_at) AS last_received_at, MIN(received_at) AS first_received_at
                      FROM messages WHERE deleted_at IS NULL AND box = 'inbox' GROUP BY address) m ON m.address = u.address
        ORDER BY COALESCE(m.last_received_at, a.created_at) DESC
        LIMIT ?1`
    ).bind(MAX_RAIL_ADDRESSES + 1).all<AddressListRow>(),
    env.DB.prepare(
      // Bounded for the same reason as the rail above: one pair per
      // address-and-sender-domain is unbounded on a catch-all.
      `SELECT address, substr(from_address, instr(from_address, '@') + 1) AS domain, COUNT(*) AS n, MAX(received_at) AS last
         FROM messages WHERE deleted_at IS NULL GROUP BY address, domain
        ORDER BY last DESC LIMIT 5000`
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

  const truncated = rows.length > MAX_RAIL_ADDRESSES;
  if (truncated) rows.length = MAX_RAIL_ADDRESSES;

  return json({
    boxes: await boxCounts(env.DB),
    truncated,
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

/**
 * How much mail is waiting in each box other than the inbox, so the rail can
 * show its pinned rows without a second round trip. Boxes with nothing in them
 * are still reported, as zero: the rail decides what to show, not this.
 */
async function boxCounts(db: D1Database): Promise<Record<string, { count: number; unread: number }>> {
  const { results } = await db
    .prepare(
      `SELECT box, COUNT(*) AS count, SUM(read = 0) AS unread
         FROM messages WHERE deleted_at IS NULL AND box != 'inbox' GROUP BY box`
    )
    .all<{ box: string; count: number; unread: number }>();
  const out: Record<string, { count: number; unread: number }> = {};
  for (const box of BOXES) if (box !== "inbox") out[box] = { count: 0, unread: 0 };
  for (const row of results) out[row.box] = { count: row.count, unread: row.unread ?? 0 };
  return out;
}

const ADDRESS_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * RFC 5321's ceilings: 64 octets before the @, 254 for the address as a whole.
 * Shape alone let a single PUT write a five-thousand-character primary key for
 * an address Email Routing could never deliver to.
 */
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

/** Why this address cannot be stored, or null when it can. */
function addressProblem(address: string): string | null {
  if (!ADDRESS_SHAPE.test(address)) return "That is not an address";
  if (address.length > MAX_ADDRESS_LENGTH) return `An address is at most ${MAX_ADDRESS_LENGTH} characters`;
  if (address.indexOf("@") > MAX_LOCAL_LENGTH) return `The part before the @ is at most ${MAX_LOCAL_LENGTH} characters`;
  return null;
}

/**
 * PUT /api/addresses/:address  { mode?, ttlHours?, expiresAt?, ownerDomain?, label? }
 * Creates or updates an address's lifecycle. Block and unblock are just
 * mode "blocked" and mode "permanent".
 */
async function putAddress({ request, env, params }: Ctx): Promise<Response> {
  const address = params.address.trim().toLowerCase();
  const bad = addressProblem(address);
  if (bad) return json({ error: bad }, 400);
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

  // Made here, so the Screener knows it is an address the owner is using
  // rather than one the catch-all invented when mail turned up for it.
  await env.DB.prepare("INSERT OR IGNORE INTO addresses (address, mode, created_at, origin) VALUES (?1, 'permanent', ?2, 'owner')").bind(address, now).run();
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
  const bad = addressProblem(address);
  if (bad) return json({ error: bad }, 400);
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

/**
 * Whether the only place this row matched was inside the message.
 *
 * Worked out here rather than in SQL because everything it needs is already in
 * the row. It is what lets the list say "found in the message" instead of
 * showing a result with no visible reason to be there.
 */
function matchedOnlyInBody(row: ListRow, query: string): boolean {
  const needle = query.toLowerCase();
  const shown = [row.subject, row.from_name, row.from_address, row.address, row.snippet];
  return !shown.some((value) => (value ?? "").toLowerCase().includes(needle));
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
 * GET /api/messages?address=&q=&cursor=&limit=&unread=1&starred=1&box=
 * Newest first. Search is a case-insensitive substring match over the
 * subject, sender, recipient and snippet.
 *
 * Every list is scoped to one box. Leaving `box` off means the inbox, so mail
 * the Screener is holding or the junk filter caught never turns up in a list
 * that did not ask for it -- including the lists older clients ask for.
 */
async function listMessages({ env, url }: Ctx): Promise<Response> {
  const address = url.searchParams.get("address")?.trim().toLowerCase() || null;
  const boxParam = url.searchParams.get("box");
  if (boxParam !== null && !isBox(boxParam)) return json({ error: "Unknown box" }, 400);
  const box: Box = boxParam ?? "inbox";
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const limit = clampPageSize(url.searchParams.get("limit"), PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const cursorText = url.searchParams.get("cursor");
  const cursor = parseCursor(cursorText);
  if (cursorText && !cursor) return json({ error: "Bad cursor" }, 400);

  const where: string[] = ["deleted_at IS NULL"];
  const binds: unknown[] = [];
  where.push(`box = ?${binds.push(box)}`);
  if (address) where.push(`address = ?${binds.push(address)}`);
  if (url.searchParams.get("unread") === "1") where.push("read = 0");
  if (url.searchParams.get("starred") === "1") where.push("starred = 1");
  if (query) {
    const like = "%" + query.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    const n = binds.push(like);
    // search_text last: the metadata columns are short and settle most
    // queries, and SQLite stops at the first term that matches.
    where.push(
      `(subject LIKE ?${n} ESCAPE '\\' OR from_name LIKE ?${n} ESCAPE '\\' OR from_address LIKE ?${n} ESCAPE '\\'` +
        ` OR address LIKE ?${n} ESCAPE '\\' OR snippet LIKE ?${n} ESCAPE '\\' OR search_text LIKE ?${n} ESCAPE '\\')`
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
    messages: rows.map((row) => ({ ...toListItem(row), foundInBody: query ? matchedOnlyInBody(row, query) : false })),
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
  box: Box; box_reason: string | null;
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
    box: row.box,
    boxReason: row.box_reason,
  });
}

/* ---------------------------------------------------------------- rules */

/**
 * GET /api/rules — the rules in the order they run, with the vocabulary the
 * editor needs so the client never has to hardcode a list the server checks.
 */
async function listRules({ env }: Ctx): Promise<Response> {
  const { results } = await env.DB
    .prepare("SELECT id, position, enabled, field, value, action FROM rules ORDER BY position")
    .all<{ id: string; position: number; enabled: number; field: string; value: string; action: string }>();
  return json({
    rules: results.map((row) => ({ ...row, enabled: !!row.enabled })),
    fields: RULE_FIELDS,
    actions: RULE_ACTIONS,
    max: MAX_RULES,
  });
}

/**
 * PUT /api/rules  { rules: [...] }
 *
 * Replaces the whole ordered list rather than offering create, update, delete
 * and reorder. Order is part of a rule's meaning here, so every edit is really
 * an edit of the list; sending it whole means the client cannot half-apply a
 * reorder and there is no id to keep in step.
 */
async function putRules({ request, env }: Ctx): Promise<Response> {
  const body = await readJson(request);
  if (!Array.isArray(body.rules)) return json({ error: "rules must be a list" }, 400);
  if (body.rules.length > MAX_RULES) return json({ error: `At most ${MAX_RULES} rules.` }, 400);

  const now = Date.now();
  const rows: { id: string; field: string; value: string; action: string; enabled: number }[] = [];
  for (const raw of body.rules) {
    const rule = (raw ?? {}) as Record<string, unknown>;
    if (!isRuleField(rule.field)) return json({ error: "Unknown rule field" }, 400);
    if (!isRuleAction(rule.action)) return json({ error: "Unknown rule action" }, 400);
    const value = String(rule.value ?? "").trim().slice(0, MAX_RULE_VALUE);
    if (needsValue(rule.field) && !value) return json({ error: "That rule needs something to match on." }, 400);
    rows.push({
      id: typeof rule.id === "string" && rule.id ? rule.id.slice(0, 64) : crypto.randomUUID(),
      field: rule.field,
      value,
      action: rule.action,
      enabled: rule.enabled === false ? 0 : 1,
    });
  }

  // Written as one batch, so a half-saved list is not a state anything sees.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rules"),
    ...rows.map((row, position) =>
      env.DB
        .prepare("INSERT INTO rules (id, position, enabled, field, value, action, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
        .bind(row.id, position, row.enabled, row.field, row.value, row.action, now)
    ),
  ]);
  return listRules({ env } as Ctx);
}

/* ----------------------------------------------------------------- junk */

/** How many messages one call retrains on. The client sends them in slices. */
const JUNK_BATCH = 25;
/** How much of a body is read back to work out its words again. */
const JUNK_READ_CHARS = 4000;

/** What the filter has been taught, and whether that is enough to act on. */
async function junkTraining(db: D1Database): Promise<{ junk: number; ham: number; ready: boolean; needed: number }> {
  const rows = await getSettings(db, [SETTING_JUNK_TRAINED_JUNK, SETTING_JUNK_TRAINED_HAM]);
  const junk = Number(rows.get(SETTING_JUNK_TRAINED_JUNK) ?? 0) || 0;
  const ham = Number(rows.get(SETTING_JUNK_TRAINED_HAM) ?? 0) || 0;
  return { junk, ham, ready: junk >= JUNK_MIN_TRAINED && ham >= JUNK_MIN_TRAINED, needed: JUNK_MIN_TRAINED };
}

interface JunkRow {
  id: string;
  subject: string | null;
  from_address: string;
  text_body: string | null;
  html_body: string | null;
  attachments: string | null;
  list_unsubscribe: string | null;
  auth_summary: string | null;
  trained: string | null;
}

/**
 * POST /api/junk  { ids, junk }
 *
 * Marks messages junk, or takes it back. Both directions teach the filter, and
 * a message counts exactly once however many times the button is pressed --
 * `messages.trained` remembers what it already contributed, so a change of mind
 * takes the old evidence back before adding the new.
 *
 * The words are worked out again from the stored body rather than kept
 * anywhere, which is why junkTokens() has to be deterministic.
 */
async function markJunk({ request, env }: Ctx): Promise<Response> {
  const body = await readJson(request);
  const ids = idsFrom(body).slice(0, JUNK_BATCH);
  if (!ids.length) return json({ error: "No messages given" }, 400);
  const junk = body.junk !== false;
  const want = junk ? "junk" : "ham";
  const now = Date.now();

  const holes = ids.map((_, n) => `?${n + 1}`).join(",");
  const { results } = await env.DB
    .prepare(
      `SELECT id, subject, from_address, attachments, list_unsubscribe, auth_summary, trained,
              substr(text_body, 1, ${JUNK_READ_CHARS}) AS text_body,
              substr(html_body, 1, ${JUNK_READ_CHARS * 5}) AS html_body
         FROM messages WHERE id IN (${holes})`
    )
    .bind(...ids)
    .all<JunkRow>();
  if (!results.length) return json({ error: "Message not found" }, 404);

  // Aggregated across the whole batch, so twenty-five messages cost two
  // statements rather than a statement per word per message.
  const add = new Map<string, number>();
  const take = new Map<string, number>();
  let addedJunk = 0, addedHam = 0, tookJunk = 0, tookHam = 0;

  for (const row of results) {
    if (row.trained === want) continue;               // already counted
    const tokens = junkTokens({
      from: row.from_address,
      subject: row.subject ?? "",
      plain: row.text_body ?? (row.html_body ? htmlToText(row.html_body) : null),
      hasAttachment: !!row.attachments && row.attachments !== "[]",
      listUnsubscribe: row.list_unsubscribe,
      auth: row.auth_summary ? (JSON.parse(row.auth_summary) as AuthSummary) : null,
    });
    for (const token of tokens) {
      add.set(token, (add.get(token) ?? 0) + 1);
      if (row.trained) take.set(token, (take.get(token) ?? 0) - 1);
    }
    if (want === "junk") addedJunk++; else addedHam++;
    if (row.trained === "junk") tookJunk++;
    if (row.trained === "ham") tookHam++;
  }

  await trainTokens(env.DB, add, want);
  if (take.size) await trainTokens(env.DB, take, want === "junk" ? "ham" : "junk");

  for (const chunk of idChunks(ids, 3)) {
    const spots = chunk.map((_, n) => `?${n + 4}`).join(",");
    await env.DB
      .prepare(`UPDATE messages SET box = ?1, box_reason = ?2, trained = ?3 WHERE id IN (${spots})`)
      .bind(junk ? "junk" : "inbox", junk ? "You marked this junk" : null, want, ...chunk)
      .run();
  }

  const counts = await junkTraining(env.DB);
  const nextJunk = Math.max(0, counts.junk + addedJunk - tookJunk);
  const nextHam = Math.max(0, counts.ham + addedHam - tookHam);
  await setSetting(env.DB, SETTING_JUNK_TRAINED_JUNK, String(nextJunk));
  await setSetting(env.DB, SETTING_JUNK_TRAINED_HAM, String(nextHam));

  return json({ ok: true, moved: results.length, junk: await junkTraining(env.DB), at: now });
}

/**
 * DELETE /api/junk — forget everything the filter has learned.
 *
 * Every message keeps its box; only the training goes. Teaching it the wrong
 * thing should be recoverable without also undoing the filing the owner did by
 * hand, and starting over is the honest fix for a filter that has learned
 * something silly.
 */
async function forgetJunk({ env }: Ctx): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM junk_tokens"),
    env.DB.prepare("UPDATE messages SET trained = NULL WHERE trained IS NOT NULL"),
  ]);
  await deleteSetting(env.DB, SETTING_JUNK_TRAINED_JUNK);
  await deleteSetting(env.DB, SETTING_JUNK_TRAINED_HAM);
  return json({ ok: true, junk: await junkTraining(env.DB) });
}

/**
 * GET /api/senders — who is waiting in the Screener, newest first.
 *
 * Grouped by sender rather than listed per message: the decision the owner is
 * being asked for is about the sender, and four messages from one stranger is
 * one question, not four.
 */
async function listSenders({ env }: Ctx): Promise<Response> {
  const { results } = await env.DB
    .prepare(
      `SELECT from_address, MAX(from_name) AS from_name, COUNT(*) AS held,
              MAX(received_at) AS last_at, MIN(received_at) AS first_at,
              SUM(read = 0) AS unread
         FROM messages WHERE box = 'screener' AND deleted_at IS NULL
         GROUP BY from_address ORDER BY last_at DESC LIMIT 200`
    )
    .all<{ from_address: string; from_name: string | null; held: number; last_at: number; first_at: number; unread: number }>();
  return json({
    senders: results.map((row) => ({
      address: row.from_address,
      name: row.from_name,
      held: row.held,
      unread: row.unread ?? 0,
      lastAt: row.last_at,
      firstAt: row.first_at,
    })),
  });
}

/**
 * POST /api/senders/:address  { verdict, ids? }
 *
 * "allowed" lets every message this sender has waiting into the inbox and every
 * later one straight through; "binned" trashes them, where the usual undo
 * window applies. "unknown" is the undo for either, and takes the ids the
 * decision returned so it puts back exactly what that decision moved rather
 * than everything this sender has ever sent.
 */
async function decideSender({ request, env, params }: Ctx): Promise<Response> {
  const sender = params.address.trim().toLowerCase();
  if (!sender || sender.length > MAX_ADDRESS_LENGTH) return json({ error: "That is not an address" }, 400);
  const body = await readJson(request);
  if (!isVerdict(body.verdict)) return json({ error: "Unknown verdict" }, 400);
  const now = Date.now();

  if (body.verdict === "unknown") {
    const ids = idsFrom(body);
    await env.DB.prepare("DELETE FROM senders WHERE from_address = ?1").bind(sender).run();
    for (const chunk of idChunks(ids, 1)) {
      const holes = chunk.map((_, n) => `?${n + 2}`).join(",");
      await env.DB
        .prepare(`UPDATE messages SET box = 'screener', deleted_at = NULL, box_reason = ?1 WHERE id IN (${holes})`)
        .bind("First message from this sender", ...chunk)
        .run();
    }
    return json({ ok: true, verdict: "unknown", ids });
  }

  // The ids are read before the write so the undo can be exact.
  const { results } = await env.DB
    .prepare("SELECT id FROM messages WHERE from_address = ?1 AND box = 'screener' AND deleted_at IS NULL")
    .bind(sender)
    .all<{ id: string }>();
  const ids = results.map((row) => row.id);

  await env.DB
    .prepare(
      `INSERT INTO senders (from_address, verdict, decided_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(from_address) DO UPDATE SET verdict = excluded.verdict, decided_at = excluded.decided_at`
    )
    .bind(sender, body.verdict, now)
    .run();

  if (body.verdict === "allowed") {
    await env.DB
      .prepare("UPDATE messages SET box = 'inbox', box_reason = NULL WHERE from_address = ?1 AND box = 'screener'")
      .bind(sender)
      .run();
  } else {
    await env.DB
      .prepare("UPDATE messages SET deleted_at = ?2, box_reason = ?3 WHERE from_address = ?1 AND box = 'screener' AND deleted_at IS NULL")
      .bind(sender, now, "You binned this sender")
      .run();
  }
  return json({ ok: true, verdict: body.verdict, ids });
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
  const result = await runUnsubscribe(row);
  if (result.method === "none") return json({ error: result.detail }, result.status ?? 400);
  if (result.method === "post") {
    return json({ ok: result.done, method: "post", status: result.status, url: result.url }, result.done ? 200 : 502);
  }
  return json({ ok: true, method: result.method, url: result.url });
}

/** What one unsubscribe attempt came to. */
interface UnsubscribeResult {
  /** post: we asked. open/mailto: the reader has to. none: there is no way. */
  method: "post" | "open" | "mailto" | "none";
  /** Only ever true for "post": the other two have not unsubscribed anybody. */
  done: boolean;
  url?: string;
  detail?: string;
  status?: number;
}

/**
 * Unsubscribes from one message's list, as far as it can be done from here.
 *
 * Shared by the single-message action and the bulk one so the two cannot drift
 * apart on what counts as having unsubscribed. That distinction matters more
 * than it looks: only the RFC 8058 one-click POST actually tells anyone
 * anything. "open" and "mailto" hand the job back to the reader, and recording
 * either as done would be the app claiming credit for work nobody did.
 */
async function runUnsubscribe(row: MessageRow): Promise<UnsubscribeResult> {
  const links = parseListUnsubscribe(row.list_unsubscribe);
  if (!links) return { method: "none", done: false, detail: "This message has no unsubscribe link", status: 404 };

  const url = publicHttpsUrl(links.https);
  if (links.https && !url) {
    // A link this inbox will not call: private address, plain http, something
    // odd. The mailto is a real alternative; nothing else is.
    if (links.mailto) return { method: "mailto", done: false, url: links.mailto };
    return { method: "none", done: false, detail: "The unsubscribe link points somewhere this inbox will not call", status: 400 };
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
      return { method: "post", done, status: res.status, url: url.toString(), detail: done ? undefined : `The list answered ${res.status}` };
    } catch (err) {
      console.warn("unsubscribe request failed", err);
      return { method: "post", done: false, status: 502, url: url.toString(), detail: "The sender's unsubscribe service did not answer" };
    }
  }
  if (url) return { method: "open", done: false, url: url.toString() };
  return { method: "mailto", done: false, url: links.mailto ?? undefined };
}

/** How many lists one bulk request handles. The client drives the rest. */
const UNSUBSCRIBE_BATCH = 5;

/**
 * A list's name, as something a person would recognise.
 *
 * A List-ID is written "<offers.shop.example>" or 'The Offers List
 * <offers.shop.example>', so only the delimiters come off -- taking the whole
 * bracketed part leaves nothing at all and every list ends up named after
 * whichever address happened to send it.
 */
function listName(row: { list_id: string | null; from_name: string | null; from_address: string }): string {
  const id = (row.list_id ?? "").replace(/[<>"']/g, "").trim();
  return id || row.from_name || row.from_address;
}

/**
 * GET /api/addresses/:address/subscriptions
 *
 * What this address is actually signed up to, grouped by list. One company
 * often runs several, so the sender alone is the wrong grain: leaving the
 * offers list is not leaving the receipts one.
 */
async function listSubscriptions({ env, params }: Ctx): Promise<Response> {
  const address = params.address.trim().toLowerCase();
  const { results } = await env.DB
    .prepare(
      // SQLite gives the bare columns from the same row as the MAX(), so these
      // are the newest message's unsubscribe details rather than a mixture.
      `SELECT COALESCE(trim(list_id, '<>'), from_address) AS list_key, list_id, from_name, from_address,
              id, list_unsubscribe, list_unsubscribe_post, COUNT(*) AS held, MAX(received_at) AS last_at
         FROM messages
        WHERE address = ?1 AND deleted_at IS NULL AND list_unsubscribe IS NOT NULL
        GROUP BY list_key
        ORDER BY last_at DESC LIMIT 50`
    )
    .bind(address)
    .all<{ list_key: string; list_id: string | null; from_name: string | null; from_address: string; id: string;
           list_unsubscribe: string | null; list_unsubscribe_post: string | null; held: number; last_at: number }>();

  const done = new Map<string, { status: string; detail: string | null; at: number }>();
  if (results.length) {
    for (const chunk of idChunks(results.map((row) => row.list_key))) {
      const holes = chunk.map((_, n) => `?${n + 1}`).join(",");
      const { results: rows } = await env.DB
        .prepare(`SELECT list_key, status, detail, at FROM unsubscribes WHERE list_key IN (${holes})`)
        .bind(...chunk)
        .all<{ list_key: string; status: string; detail: string | null; at: number }>();
      for (const row of rows) done.set(row.list_key, { status: row.status, detail: row.detail, at: row.at });
    }
  }

  return json({
    address,
    batch: UNSUBSCRIBE_BATCH,
    subscriptions: results.map((row) => ({
      key: row.list_key,
      name: listName(row),
      from: row.from_address,
      count: row.held,
      lastAt: row.last_at,
      oneClick: isOneClick(row.list_unsubscribe_post) && !!parseListUnsubscribe(row.list_unsubscribe)?.https,
      already: done.get(row.list_key) ?? null,
    })),
  });
}

/**
 * POST /api/unsubscribe  { address, keys }
 *
 * Works through a handful of lists per call and reports each one. Small on
 * purpose: every one is an outbound request with its own eight-second timeout,
 * and a request that tries forty of them is one that hangs and then tells the
 * reader nothing about which of the forty worked.
 */
async function unsubscribeMany({ request, env }: Ctx): Promise<Response> {
  const body = await readJson(request);
  const address = String(body.address ?? "").trim().toLowerCase();
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string").slice(0, UNSUBSCRIBE_BATCH) : [];
  if (!address || !keys.length) return json({ error: "Say which address and which lists" }, 400);

  const now = Date.now();
  const done: { key: string; method: string; ok: boolean; url?: string; detail?: string }[] = [];
  for (const key of keys) {
    const row = await env.DB
      .prepare(
        `SELECT * FROM messages
          WHERE address = ?1 AND deleted_at IS NULL AND list_unsubscribe IS NOT NULL
            AND COALESCE(trim(list_id, '<>'), from_address) = ?2
          ORDER BY received_at DESC LIMIT 1`
      )
      .bind(address, key)
      .first<MessageRow>();
    if (!row) {
      done.push({ key, method: "none", ok: false, detail: "Nothing from this list is here any more" });
      continue;
    }
    const result = await runUnsubscribe(row);
    done.push({ key, method: result.method, ok: result.done, url: result.url, detail: result.detail });

    // Only a request that actually went out is recorded. "open" and "mailto"
    // are still the reader's job, and writing them down as done would make the
    // list say it had left something it had not.
    if (result.done) {
      await env.DB
        .prepare(
          `INSERT INTO unsubscribes (list_key, address, status, detail, at) VALUES (?1, ?2, 'done', NULL, ?3)
             ON CONFLICT(list_key) DO UPDATE SET status = 'done', detail = NULL, at = excluded.at, address = excluded.address`
        )
        .bind(key, address, now)
        .run();
    }
  }
  return json({ ok: true, results: done });
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

/**
 * POST /api/read-all?address=x marks one address read; without it, everything.
 * Only the inbox: "mark all read" must not quietly clear the Screener's badge
 * for mail nobody has looked at.
 */
async function markAllRead({ env, url }: Ctx): Promise<Response> {
  const raw = url.searchParams.get("address");
  // "?address=" is a caller that meant to scope the call and lost the value;
  // treating it as "no address" would silently clear the entire inbox.
  if (raw !== null && !raw.trim()) return json({ error: "No address given" }, 400);
  const address = raw?.trim().toLowerCase();
  if (address) {
    await env.DB.prepare("UPDATE messages SET read = 1 WHERE address = ?1 AND read = 0 AND deleted_at IS NULL AND box = 'inbox'").bind(address).run();
  } else {
    await env.DB.prepare("UPDATE messages SET read = 1 WHERE read = 0 AND deleted_at IS NULL AND box = 'inbox'").run();
  }
  return json({ ok: true });
}

/* -------------------------------------------------------- attachments */

/**
 * Content types ?inline=1 may reflect back.
 *
 * Inline exists for one thing: rendering a cid: image inside the message
 * frame, whose own CSP (img-src 'self' data: blob:) can load nothing else.
 * Echoing the sender's declared type served their HTML as text/html from this
 * origin, leaving the app's CSP as the only thing between an emailed file and
 * same-origin script. Anything not on this list downloads instead.
 *
 * image/svg+xml is deliberately absent: an SVG can carry script, and it buys
 * nothing here that a raster image does not.
 */
const INLINE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
  "image/avif", "image/bmp", "image/tiff", "image/x-icon", "image/vnd.microsoft.icon",
]);

/**
 * A Content-Disposition header for a filename that may be anything at all.
 *
 * Quotes, backslashes and newlines are stripped so the header cannot be broken
 * out of, and a non-ASCII name is carried by RFC 6266's filename* alongside a
 * flattened ASCII fallback -- a raw UTF-8 filename= is read as Latin-1 by some
 * browsers, which turns an ordinary Japanese or emoji filename into mojibake.
 */
function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_") || "attachment";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

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
  const declared = meta.content_type.replace(/[^\w.+/-]/g, "").toLowerCase();
  const inline = url.searchParams.get("inline") === "1" && INLINE_TYPES.has(declared);
  return withSecurityHeaders(
    new Response(stream, {
      headers: {
        "content-type": inline ? declared : "application/octet-stream",
        "content-length": String(meta.size),
        "content-disposition": contentDisposition(inline ? "inline" : "attachment", meta.filename),
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
        "content-disposition": contentDisposition("attachment", `${name}.txt`),
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
  const offered = request.headers.get("x-ingest-key");
  if (!env.INGEST_KEY || offered === null || !timingSafeEqual(offered, env.INGEST_KEY)) {
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
