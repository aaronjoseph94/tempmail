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
 * Whether the Worker may call this URL itself. Only public https hosts on the
 * default port, so nothing here can be pointed at the Worker's own network.
 *
 * IP literals are refused outright rather than range-checked. Range-checking
 * them is a trap: `new URL("https://[::ffff:127.0.0.1]/")` reports its host as
 * `[::ffff:7f00:1]`, so a filter written against the dotted-quad spelling
 * silently passes loopback and link-local addresses. Real services that accept
 * an unsubscribe POST or a push have names.
 */
export function publicHttpsUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  // Any IP literal: bracketed IPv6, bare IPv6, or all-digits-and-dots IPv4.
  if (host.startsWith("[") || host.includes(":") || /^[\d.]+$/.test(host)) return null;
  // Names that never leave the local network.
  if (host === "localhost" || /\.(localhost|local|internal|home|lan|corp|intranet)$/.test(host)) return null;
  // A public name has a dot and a real TLD; "metadata" or "router" do not.
  if (!/\.[a-z]{2,}$/.test(host)) return null;
  return url;
}

/** Sender's own Date header as a timestamp, when it parses. */
export function parseSentAt(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
