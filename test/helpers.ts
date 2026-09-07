/**
 * Shared test plumbing. Tests call the Worker's handlers directly with the
 * real bindings from the vitest pool (a local D1 and the static assets).
 */

import { createExecutionContext, env as testEnv, waitOnExecutionContext } from "cloudflare:test";
import worker, { type Env } from "../src/index";
import { bootstrapSchema } from "../src/db";

export const ORIGIN = "https://mail.example.test";
export const env = testEnv as unknown as Env;

export interface CallOptions {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  cookie?: string;
  ip?: string;
  env?: Partial<Env>;
}

/** Sends one request through the Worker's fetch handler. */
export async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  headers.set("cf-connecting-ip", options.ip ?? "203.0.113.1");
  const request = new Request(ORIGIN + path, {
    method: options.method ?? (options.json !== undefined ? "POST" : "GET"),
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, ...options.env }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** The "name=value" part of the session cookie a response set. */
export function cookieFrom(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Wipes every table between tests (the schema itself stays). */
export async function freshDatabase(): Promise<void> {
  await bootstrapSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachment_chunks"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM address_labels"),
    env.DB.prepare("DELETE FROM addresses"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
}

/** Runs first-time setup and returns a signed-in session cookie. */
export async function signIn(password = "correct horse battery"): Promise<string> {
  const res = await call("/api/setup", { json: { password } });
  if (res.status !== 200) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  return cookieFrom(res);
}

let ipCounter = 0;
/** A distinct IP per caller so login lockouts don't bleed between tests. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

export interface MailAttachment {
  name: string;
  type: string;
  bytes: Uint8Array;
  inline?: boolean;
  cid?: string;
}

export interface MailOptions {
  from?: string;
  to?: string;
  subject?: string;
  text?: string | null;
  html?: string;
  attachments?: MailAttachment[];
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Builds a raw RFC 822 message: multipart/alternative for text+html, multipart/mixed around attachments. */
export function buildMail(options: MailOptions = {}): string {
  const {
    from = "Alice Example <alice@example.org>",
    to = "someone@mail.example.test",
    subject = "Hello",
    text = "Hi there",
    html,
    attachments = [],
  } = options;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@example.org>`,
    "MIME-Version: 1.0",
  ];
  const CRLF = "\r\n";

  // A "part" is its own headers plus body; multipart() wraps parts in a boundary.
  const textPart = text != null ? ["Content-Type: text/plain; charset=utf-8", "", text].join(CRLF) : null;
  const htmlPart = html ? ["Content-Type: text/html; charset=utf-8", "", html].join(CRLF) : null;
  const multipart = (subtype: string, parts: string[]): string => {
    const boundary = `b-${crypto.randomUUID()}`;
    const body = parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF) + `${CRLF}--${boundary}--${CRLF}`;
    return [`Content-Type: multipart/${subtype}; boundary="${boundary}"`, "", body].join(CRLF);
  };

  let content: string;
  if (textPart && htmlPart) content = multipart("alternative", [textPart, htmlPart]);
  else content = htmlPart ?? textPart ?? ["Content-Type: text/plain; charset=utf-8", "", ""].join(CRLF);

  if (attachments.length) {
    const attachmentParts = attachments.map((a) => [
      `Content-Type: ${a.type}; name="${a.name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: ${a.inline ? "inline" : "attachment"}; filename="${a.name}"`,
      ...(a.cid ? [`Content-ID: <${a.cid}>`] : []),
      "",
      base64(a.bytes),
    ].join(CRLF));
    content = multipart("mixed", [content, ...attachmentParts]);
  }
  return headers.join(CRLF) + CRLF + content;
}

/**
 * Delivers a raw message the way Email Routing would, through the Worker's
 * email handler. Returns the rejection reasons (empty when accepted).
 */
export async function deliver(raw: string, to: string, options: { from?: string; env?: Partial<Env> } = {}): Promise<string[]> {
  const bytes = new TextEncoder().encode(raw);
  const rejected: string[] = [];
  const message = {
    from: options.from ?? "alice@example.org",
    to,
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.length,
    headers: new Headers(),
    setReject(reason: string) { rejected.push(reason); },
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
  await worker.email(message, { ...env, ...options.env }, createExecutionContext());
  return rejected;
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
