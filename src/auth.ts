/**
 * Passwords, sessions and the login throttle.
 *
 * One password guards the whole site. It comes from one of two places:
 *
 *   1. the AUTH_PASSWORD secret, when the owner has set one (this always wins), or
 *   2. a salted PBKDF2 hash in the settings table, created on the first-run
 *      setup screen. This is what makes the deploy button zero-config.
 *
 * A session is a signed cookie, "<expiry>.<hmac>". The HMAC key is a random
 * secret kept in the database, combined with a fingerprint of the current
 * password so that changing the password signs every device out.
 */

import type { Env } from "./index";
import { getSetting, setSetting, setSettingIfAbsent, SETTING_PASSWORD, SETTING_SESSION_SECRET } from "./db";

export const SESSION_COOKIE = "__Host-tm_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Enough to make offline guessing expensive, cheap enough (a few ms) to stay
// well inside the free plan's 10 ms CPU budget. The count is stored with each
// hash, so it can be raised later without invalidating existing passwords.
const PBKDF2_ITERATIONS = 10_000;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

const encoder = new TextEncoder();

/* ---------------------------------------------------------- primitives */

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

async function pbkdf2Hex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return hex(bits);
}

/** Compares two strings without leaking where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------ password */

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:sha256:${PBKDF2_ITERATIONS}:${hex(salt)}:${digest}`;
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const [scheme, digestName, iterationsText, saltHex, digest] = stored.split(":");
  const iterations = Number(iterationsText);
  const wellFormed =
    scheme === "pbkdf2" && digestName === "sha256" &&
    Number.isInteger(iterations) && iterations > 0 && !!saltHex && !!digest;
  if (!wellFormed) return false;
  return timingSafeEqual(await pbkdf2Hex(password, fromHex(saltHex), iterations), digest);
}

export type PasswordSource = "env" | "database" | "none";

/** Where the site password currently lives, if anywhere. */
export async function passwordSource(env: Env): Promise<PasswordSource> {
  if (env.AUTH_PASSWORD) return "env";
  return (await getSetting(env.DB, SETTING_PASSWORD)) ? "database" : "none";
}

/** A reason the candidate password can't be used, or null when it's fine. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

/** Checks a login attempt against whichever password is configured. */
export async function checkPassword(env: Env, attempt: string): Promise<boolean> {
  if (env.AUTH_PASSWORD) {
    // Hash both sides so the comparison is constant-time whatever the lengths.
    return timingSafeEqual(await sha256Hex(attempt), await sha256Hex(env.AUTH_PASSWORD));
  }
  const stored = await getSetting(env.DB, SETTING_PASSWORD);
  return stored ? verifyPasswordHash(attempt, stored) : false;
}

/** First-run setup. Returns false if someone else got there first. */
export async function createPassword(env: Env, password: string): Promise<boolean> {
  const created = await setSettingIfAbsent(env.DB, SETTING_PASSWORD, await hashPassword(password));
  signingKey = null;
  return created;
}

/** Replaces the stored password. Existing sessions stop working. */
export async function replacePassword(env: Env, password: string): Promise<void> {
  await setSetting(env.DB, SETTING_PASSWORD, await hashPassword(password));
  // Changing the password signs every device out, so it must also stop them
  // receiving pushed message content.
  await env.DB.prepare("DELETE FROM push_subscriptions").run();
  signingKey = null;
}

/* ------------------------------------------------------------- sessions */

interface SigningKey {
  secret: string;
  fingerprint: string;
}

// Cached per isolate. Re-read from the database when a cookie fails to verify,
// so a password change made on another isolate is noticed without a restart.
let signingKey: SigningKey | null = null;

async function loadSigningKey(env: Env): Promise<SigningKey | null> {
  const material = env.AUTH_PASSWORD ?? (await getSetting(env.DB, SETTING_PASSWORD));
  if (!material) return null; // no password yet, so nobody can have a session

  let secret = await getSetting(env.DB, SETTING_SESSION_SECRET);
  if (!secret) {
    // First writer wins, then every isolate reads back the same value.
    await setSettingIfAbsent(env.DB, SETTING_SESSION_SECRET, randomHex(32));
    secret = await getSetting(env.DB, SETTING_SESSION_SECRET);
    if (!secret) throw new Error("could not create the session secret");
  }
  signingKey = { secret, fingerprint: await sha256Hex("password:" + material) };
  return signingKey;
}

function sign(key: SigningKey, expiry: string): Promise<string> {
  return hmacHex(key.secret, `${expiry}.${key.fingerprint}`);
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function hasValidSession(request: Request, env: Env): Promise<boolean> {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot <= 0) return false;
  const expiry = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);
  const expiresAt = Number(expiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return false;

  const cached = signingKey;
  if (cached && (await stillCurrent(cached, env)) && timingSafeEqual(signature, await sign(cached, expiry))) {
    return true;
  }

  // Miss: maybe the password changed elsewhere. Look again before giving up.
  const fresh = await loadSigningKey(env);
  if (!fresh) return false;
  if (cached && fresh.secret === cached.secret && fresh.fingerprint === cached.fingerprint) return false;
  return timingSafeEqual(signature, await sign(fresh, expiry));
}

// With AUTH_PASSWORD the fingerprint is one cheap hash away, so never trust a stale one.
async function stillCurrent(key: SigningKey, env: Env): Promise<boolean> {
  return !env.AUTH_PASSWORD || key.fingerprint === (await sha256Hex("password:" + env.AUTH_PASSWORD));
}

/** Set-Cookie value for a fresh 30-day session. */
export async function sessionCookie(env: Env): Promise<string> {
  const key = await loadSigningKey(env);
  if (!key) throw new Error("no password configured");
  const expiry = String(Date.now() + SESSION_TTL_MS);
  const signature = await sign(key, expiry);
  return `${SESSION_COOKIE}=${expiry}.${signature}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;

/* ------------------------------------------------------- login throttle */

// Best effort and per isolate: five failures from one IP lock it out for 15
// minutes. Isolates come and go, so pair this with a WAF rate-limit rule if
// the site is exposed to a determined attacker (the README shows how).

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; lockedUntil: number }>();

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Seconds left on this IP's lockout, or 0 when it may try again. */
export function lockoutSecondsLeft(ip: string): number {
  const entry = failures.get(ip);
  if (!entry) return 0;
  if (entry.lockedUntil > Date.now()) return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
  if (entry.lockedUntil) failures.delete(ip); // the lockout has expired; start fresh
  return 0;
}

/** Records a wrong password. Says how many tries are left, or how long the lockout is. */
export function noteFailedLogin(ip: string): { attemptsLeft: number; lockedForSeconds: number } {
  if (failures.size > 1000) failures.clear(); // bound memory against spoofed floods
  const entry = failures.get(ip) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  failures.set(ip, entry);
  if (entry.count >= MAX_FAILURES) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    return { attemptsLeft: 0, lockedForSeconds: LOCKOUT_MS / 1000 };
  }
  return { attemptsLeft: MAX_FAILURES - entry.count, lockedForSeconds: 0 };
}

export function clearFailedLogins(ip: string): void {
  failures.delete(ip);
}
