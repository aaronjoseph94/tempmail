/**
 * The inbound mail pipeline. Email Routing hands us the raw message; we parse
 * it, trim it to sensible sizes and store it.
 *
 * Attachment bytes go into their own table, base64 and split across rows,
 * because D1 refuses any single value much over 2 MB. That is what lets a
 * 25 MB message keep a downloadable attachment instead of just its name.
 */

import PostalMime, { type Email } from "postal-mime";
import type { Env } from "./index";
import { addressVerdict, recordArrival, senderDomain } from "./addresses";
import { deleteMessagesByIds } from "./db";
import { headerValue, parseAuthResults, parseSentAt } from "./headers";
import { pokeHub } from "./live";
import { anySubscriptions, sendPush } from "./push";
import { ATTACHMENT_CHUNK_CHARS, ATTACHMENT_CHUNKS_PER_WRITE, MAX_BODY_CHARS, resolveLimits } from "./limits";
import { extractCode, htmlToText, makeSnippet } from "./text";

export interface StoredAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Content-ID for inline images, without the angle brackets. */
  contentId?: string;
  inline?: boolean;
  /** False when the content was too large to keep, so only metadata exists. */
  stored: boolean;
}

export interface InboundMail {
  to: string;
  from: string;
  raw: ArrayBuffer | ReadableStream | Uint8Array;
  /** Size in bytes when the caller knows it up front (Email Routing does). */
  rawSize?: number;
}

export type IngestResult =
  | { ok: true; id: string; address: string; code: string | null; from: string; subject: string }
  | { ok: false; reason: string };

/**
 * Domains this instance accepts mail for, from MAIL_DOMAIN. An empty list
 * means "anything Email Routing sends us", which is the right default: the
 * routing rules already limit that to the owner's own zones.
 */
export function allowedDomains(env: Env): string[] {
  return (env.MAIL_DOMAIN ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .map((domain) => domain.replace(/^@/, ""))
    .filter((domain) => domain && domain !== "yourdomain.com"); // the old template placeholder
}

export function domainAccepted(address: string, allowed: string[]): boolean {
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) return false;
  if (allowed.length === 0) return true;
  const domain = address.slice(at + 1);
  return allowed.some((allowedDomain) => domain === allowedDomain || domain.endsWith("." + allowedDomain));
}

/** Entry point for Cloudflare Email Routing. */
export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx?: ExecutionContext): Promise<void> {
  const result = await storeInboundEmail(env, {
    to: message.to,
    from: message.from,
    raw: message.raw,
    rawSize: message.rawSize,
  });
  // Bounce rather than silently drop, so the sender learns what happened.
  if (!result.ok) {
    message.setReject(result.reason);
    return;
  }
  afterIngest(env, ctx, result);
}

/**
 * Everything that follows a stored message but must not delay or fail the
 * ingest itself: telling open browsers, and (later) pushing to phones.
 */
export function afterIngest(env: Env, ctx: ExecutionContext | undefined, stored: Extract<IngestResult, { ok: true }>): void {
  const live = pokeHub(env, { type: "new", address: stored.address, id: stored.id, code: stored.code, at: Date.now() });
  const push = anySubscriptions(env)
    .then((any) => (any ? sendPush(env, { id: stored.id, address: stored.address, code: stored.code, from: stored.from, subject: stored.subject.slice(0, 80) }) : undefined))
    .catch((err) => console.warn("push failed", err));
  if (ctx) {
    ctx.waitUntil(live);
    ctx.waitUntil(push);
  }
}

export async function storeInboundEmail(env: Env, mail: InboundMail): Promise<IngestResult> {
  const to = mail.to.trim().toLowerCase();
  const limits = await resolveLimits(env.DB);

  // RFC 5321 caps a path at 256 octets and a local part at 64. Nothing longer
  // is a deliverable address, and storing it would write the whole string as a
  // primary key.
  if (to.length > 254 || to.indexOf("@") > 64) {
    console.log("rejecting mail for an over-long address", `(${to.length} chars)`);
    return { ok: false, reason: "No such mailbox" };
  }
  if (!domainAccepted(to, allowedDomains(env))) {
    console.log("rejecting mail for", to, "(domain not accepted)");
    return { ok: false, reason: "No such mailbox" };
  }
  if (mail.rawSize && mail.rawSize > limits.rawBytes) {
    console.log("rejecting oversized mail for", to, `(${mail.rawSize} bytes)`);
    return { ok: false, reason: "Message too large" };
  }
  // Expired and blocked addresses bounce before the body is even read.
  const now = Date.now();
  const verdict = await addressVerdict(env.DB, to, now);
  if (!verdict.accept) {
    console.log("rejecting mail for", to, "(address no longer accepts mail)");
    return { ok: false, reason: verdict.reason };
  }

  const raw = await new Response(mail.raw).arrayBuffer();
  if (raw.byteLength > limits.rawBytes) return { ok: false, reason: "Message too large" };

  const parsed = await parseLeniently(raw);
  const sender = parsed.from?.address
    ? { name: parsed.from.name, address: parsed.from.address }
    : { name: parsed.from?.name ?? "", address: mail.from };
  const text = clip(parsed.text);
  const html = clip(parsed.html);
  const subject = clip(parsed.subject)?.trim() || "(no subject)";
  const code = extractCode(subject, text ?? (html ? htmlToText(html) : null));
  const id = crypto.randomUUID();
  const authResults = headerValue(parsed.headers, "authentication-results");
  const authSummary = parseAuthResults(authResults);

  // Metadata first, so the row is written even if an attachment write fails.
  const attachments = describeAttachments(parsed, limits.attachmentBytes);

  await env.DB.prepare(
    `INSERT INTO messages
       (id, address, from_name, from_address, subject, snippet, code, text_body, html_body, attachments, received_at, read, starred,
        message_id, in_reply_to, references_hdr, reply_to, sent_at, list_unsubscribe, list_unsubscribe_post, auth_results, auth_summary)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`
  )
    .bind(
      id,
      to,
      sender.name || null,
      sender.address,
      subject,
      makeSnippet(text, html),
      code,
      text,
      html,
      JSON.stringify(attachments),
      now,
      clipHeader(parsed.messageId),
      clipHeader(parsed.inReplyTo),
      clipHeader(parsed.references),
      clipHeader(parsed.replyTo?.[0]?.address),
      parseSentAt(parsed.date),
      clipHeader(headerValue(parsed.headers, "list-unsubscribe")),
      clipHeader(headerValue(parsed.headers, "list-unsubscribe-post")),
      clipHeader(authResults),
      authSummary ? JSON.stringify(authSummary) : null
    )
    .run();

  await writeAttachments(env.DB, id, parsed, attachments);
  // The first sender becomes the address's owner; later ones may be leaks.
  await recordArrival(env.DB, to, senderDomain(sender.address), now);

  // Keep only the newest N per address, so a flood to one address cannot fill
  // the database. Starred mail is never pruned.
  const stale = await env.DB.prepare(
    `SELECT id FROM messages
      WHERE address = ?1 AND starred = 0 AND id NOT IN
        (SELECT id FROM messages WHERE address = ?1 ORDER BY received_at DESC, id DESC LIMIT ?2)`
  )
    .bind(to, limits.perAddress)
    .all<{ id: string }>();
  await deleteMessagesByIds(env.DB, stale.results.map((row) => row.id));

  console.log("stored mail for", to, "subject:", subject);
  return { ok: true, id, address: to, code, from: sender.name || sender.address, subject };
}

/** Header values are kept whole but never past a few KB. */
function clipHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 4000) : null;
}

/** Parses the MIME message, falling back to a bare record if it is malformed. */
async function parseLeniently(raw: ArrayBuffer): Promise<Email> {
  try {
    return await PostalMime.parse(raw);
  } catch (err) {
    console.error("could not parse message, keeping the raw text", err);
    return {
      headers: [],
      headerLines: [],
      attachments: [],
      subject: "(unreadable message)",
      text: new TextDecoder().decode(raw.slice(0, 20_000)),
    };
  }
}

/** Works out what will be kept, without doing any encoding yet. */
function describeAttachments(parsed: Email, budget: number): StoredAttachment[] {
  const out: StoredAttachment[] = [];
  let spent = 0;
  for (const att of parsed.attachments ?? []) {
    const size = att.content != null ? byteLength(att.content) : 0;
    const fits = size > 0 && spent + size <= budget;
    if (fits) spent += size;
    const entry: StoredAttachment = {
      filename: att.filename || "attachment",
      contentType: att.mimeType || "application/octet-stream",
      size,
      stored: fits,
    };
    const contentId = att.contentId?.replace(/^<|>$/g, "");
    if (contentId) entry.contentId = contentId;
    if (att.disposition === "inline" || att.related) entry.inline = true;
    out.push(entry);
  }
  return out;
}

/** Writes the metadata rows, then the content in base64 chunks. */
async function writeAttachments(
  db: D1Database,
  messageId: string,
  parsed: Email,
  described: StoredAttachment[]
): Promise<void> {
  const list = parsed.attachments ?? [];
  if (!list.length) return;

  for (let idx = 0; idx < list.length; idx++) {
    const meta = described[idx];
    const chunks = meta.stored ? toBase64Chunks(asBytes(list[idx].content)) : [];

    await db
      .prepare(
        `INSERT INTO attachments (message_id, idx, filename, content_type, size, content_id, inline, chunks)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(messageId, idx, meta.filename, meta.contentType, meta.size, meta.contentId ?? null, meta.inline ? 1 : 0, chunks.length)
      .run();

    // A few rows per batch keeps each D1 call comfortably small.
    for (let i = 0; i < chunks.length; i += ATTACHMENT_CHUNKS_PER_WRITE) {
      await db.batch(
        chunks.slice(i, i + ATTACHMENT_CHUNKS_PER_WRITE).map((data, n) =>
          db
            .prepare("INSERT INTO attachment_chunks (message_id, idx, seq, data) VALUES (?1, ?2, ?3, ?4)")
            .bind(messageId, idx, i + n, data)
        )
      );
    }
  }
}

function clip(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}

function byteLength(content: string | ArrayBuffer | Uint8Array): number {
  if (typeof content === "string") return new TextEncoder().encode(content).length;
  return content instanceof Uint8Array ? content.length : content.byteLength;
}

function asBytes(content: string | ArrayBuffer | Uint8Array | undefined): Uint8Array {
  if (content == null) return new Uint8Array();
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/**
 * Base64-encodes the bytes and cuts the result into row-sized pieces.
 *
 * Each piece is a whole number of 4-character base64 groups, so it decodes on
 * its own when the download is streamed back.
 */
export function toBase64Chunks(bytes: Uint8Array): string[] {
  // 3 bytes in, 4 base64 characters out, so this many bytes fills one chunk.
  const bytesPerChunk = (ATTACHMENT_CHUNK_CHARS / 4) * 3;
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += bytesPerChunk) {
    chunks.push(base64(bytes.subarray(start, start + bytesPerChunk)));
  }
  return chunks;
}

function base64(bytes: Uint8Array): string {
  // fromCharCode has an argument limit, so build the binary string in slices,
  // then encode once: base64 cannot be concatenated piecemeal.
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
