/**
 * The few message headers worth keeping, and what to make of them.
 *
 * Cloudflare checks SPF, DKIM and DMARC on the way in and records the
 * verdicts in an Authentication-Results header above anything the sender
 * wrote. Only that topmost header is trusted; a forged one further down is
 * ignored. List-Unsubscribe (RFC 2369) and List-Unsubscribe-Post (RFC 8058)
 * let the inbox unsubscribe on the reader's behalf with one request.
 */

import type { Header } from "postal-mime";

export type AuthVerdict = "pass" | "fail" | "none" | "neutral" | "softfail" | "temperror" | "permerror" | "policy";
export interface AuthSummary { spf?: AuthVerdict; dkim?: AuthVerdict; dmarc?: AuthVerdict }
export interface ListUnsubscribe { https: string | null; mailto: string | null }

/** The first (topmost) value of a header, or null. */
export function headerValue(headers: Header[] | undefined, key: string): string | null {
  const wanted = key.toLowerCase();
  const found = headers?.find((h) => h.key === wanted);
  return found ? found.value.trim() : null;
}

const VERDICT = /\b(spf|dkim|dmarc)\s*=\s*(pass|fail|none|neutral|softfail|temperror|permerror|policy)\b/gi;

/** "mx.cloudflare.net; dkim=pass header.d=…; spf=pass …; dmarc=pass" → { dkim, spf, dmarc }. */
export function parseAuthResults(value: string | null): AuthSummary | null {
  if (!value) return null;
  const summary: AuthSummary = {};
  for (const match of value.matchAll(VERDICT)) {
    const method = match[1].toLowerCase() as keyof AuthSummary;
    if (!summary[method]) summary[method] = match[2].toLowerCase() as AuthVerdict;
  }
  return Object.keys(summary).length ? summary : null;
}

/** "<https://x/unsub?u=1>, <mailto:leave@x>" → the first https and the first mailto link. */
export function parseListUnsubscribe(value: string | null): ListUnsubscribe | null {
  if (!value) return null;
  const out: ListUnsubscribe = { https: null, mailto: null };
  for (const part of value.split(",")) {
    const link = part.trim().replace(/^<|>$/g, "").trim();
    if (!out.https && /^https:\/\//i.test(link)) out.https = link;
    else if (!out.mailto && /^mailto:/i.test(link)) out.mailto = link;
  }
  return out.https || out.mailto ? out : null;
}

/** RFC 8058: the sender promised a one-click POST works. */
export function isOneClick(listUnsubscribePost: string | null): boolean {
  return /List-Unsubscribe=One-Click/i.test(listUnsubscribePost ?? "");
}

/**
 * Whether the Worker may call this unsubscribe URL itself. Only public
 * https hosts on the default port: nothing that could reach the Worker's
 * own network, and no credentials in the URL.
 */
export function safeUnsubscribeUrl(raw: string | null): URL | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || host.includes(":")) {
    if (privateIp(host.replace(/^\[|\]$/g, ""))) return null;
  }
  return url;
}

function privateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    // loopback, unspecified, unique-local, link-local, and v4-mapped forms of the same
    if (v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80")) return true;
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateIp(mapped[1]) : false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Sender's own Date header as a timestamp, when it parses. */
export function parseSentAt(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
