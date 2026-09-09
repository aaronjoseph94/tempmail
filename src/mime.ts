/**
 * Rebuilding a message as RFC 822, for export.
 *
 * The original bytes are not kept. That is deliberate and not an oversight: raw
 * mail runs to 25 MB, bodies are clipped at 250 000 characters on the way in,
 * and a catch-all inbox that kept every original would fill a D1 database in a
 * week. So an export is a reconstruction from what was stored -- sender,
 * recipient, date, subject, both bodies, the threading headers and the
 * attachment bytes -- and the app says so rather than implying otherwise.
 *
 * What comes back is a message any mail client will open. What does not come
 * back is the sender's exact MIME arrangement and the headers nobody kept.
 */

const CRLF = "\r\n";

export interface ExportAttachment {
  filename: string;
  contentType: string;
  /** base64, already in the pieces it was stored as. */
  chunks: string[];
}

export interface ExportMessage {
  id: string;
  address: string;
  from_name: string | null;
  from_address: string;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  received_at: number;
  sent_at: number | null;
  message_id: string | null;
  in_reply_to: string | null;
  references_hdr: string | null;
  reply_to: string | null;
  list_unsubscribe: string | null;
  auth_results: string | null;
  box: string;
  starred: number;
}

/** ASCII only, and nothing that could end a header line early. */
function isHeaderSafe(value: string): boolean {
  return !/[^\x20-\x7e\t]/.test(value);
}

/**
 * ASCII, allowing the line breaks a body is made of.
 *
 * Separate from the header test on purpose: a newline is exactly what ends a
 * header and exactly what a body is full of. Sharing one predicate meant every
 * message with two lines in it was base64-encoded for no reason, which is
 * valid and unreadable -- and an archive someone may open in a text editor is
 * the last place to encode things that did not need it.
 */
function isPlainBody(value: string): boolean {
  return !/[^\x20-\x7e\t\r\n]/.test(value);
}

/**
 * A header value, encoded if it has to be.
 *
 * RFC 2047 in base64, split so no line runs past the 76 characters the
 * standard allows, because a subject in Japanese or with an emoji is ordinary
 * and a client that meets an over-long line may simply give up on the message.
 */
export function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (isHeaderSafe(clean)) return clean;
  const bytes = new TextEncoder().encode(clean);
  // 45 bytes encodes to 60 base64 characters, leaving room for the wrapper.
  const words: string[] = [];
  for (let i = 0; i < bytes.length; i += 45) {
    words.push(`=?UTF-8?B?${base64(bytes.subarray(i, i + 45))}?=`);
  }
  return words.join(`${CRLF} `);
}

/** "Name <address>", with the name encoded or quoted as needed. */
export function formatAddress(name: string | null, address: string): string {
  const safe = sanitiseAddress(address);
  if (!name) return safe;
  const encoded = encodeHeaderValue(name);
  // A quoted string cannot hold an encoded word, so only plain names are quoted.
  return isHeaderSafe(name) ? `"${name.replace(/["\\]/g, "")}" <${safe}>` : `${encoded} <${safe}>`;
}

/**
 * An address with anything that is not one taken out.
 *
 * This is attacker-controlled: it arrived in a message from a stranger. It ends
 * up in a "From " separator line, which is what tells the reading client where
 * one message stops and the next begins, so a newline or a space in it would
 * let a sender forge message boundaries inside the archive.
 */
export function sanitiseAddress(address: string): string {
  const clean = (address || "").replace(/[^\x21-\x7e]/g, "").replace(/[<>,;]/g, "");
  return clean || "MAILER-DAEMON";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

/** base64 in the 76-character lines the standard asks for. */
function wrapBase64(data: string): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += 76) lines.push(data.slice(i, i + 76));
  return lines.join(CRLF);
}

/**
 * One body part, encoded so it survives the trip.
 *
 * base64 whenever the text is not plain ASCII or has a line long enough to be
 * folded by something in the middle. Quoted-printable would be prettier in a
 * text editor and is a great deal more code to get right; base64 is never
 * wrong.
 */
function bodyPart(contentType: string, text: string): string {
  const needsEncoding = !isPlainBody(text) || text.split(/\r?\n/).some((line) => line.length > 990);
  if (!needsEncoding) {
    return [
      `Content-Type: ${contentType}; charset=utf-8`,
      "Content-Transfer-Encoding: 7bit",
      "",
      text.replace(/\r?\n/g, CRLF),
    ].join(CRLF);
  }
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(base64(new TextEncoder().encode(text))),
  ].join(CRLF);
}

function attachmentPart(attachment: ExportAttachment): string {
  const name = encodeHeaderValue(attachment.filename.replace(/["\\]/g, ""));
  return [
    `Content-Type: ${attachment.contentType.replace(/[\r\n;]+/g, " ").trim() || "application/octet-stream"}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${name}"`,
    "",
    wrapBase64(attachment.chunks.join("")),
  ].join(CRLF);
}

let boundarySeed = 0;

/** Rebuilds one message as RFC 822 text. */
export function buildMessage(message: ExportMessage, attachments: ExportAttachment[]): string {
  const when = new Date(message.sent_at ?? message.received_at);
  const headers = [
    `From: ${formatAddress(message.from_name, message.from_address)}`,
    `To: ${sanitiseAddress(message.address)}`,
    `Subject: ${encodeHeaderValue(message.subject ?? "(no subject)")}`,
    `Date: ${when.toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
  ];
  if (message.message_id) headers.push(`Message-ID: ${encodeHeaderValue(message.message_id)}`);
  if (message.in_reply_to) headers.push(`In-Reply-To: ${encodeHeaderValue(message.in_reply_to)}`);
  if (message.references_hdr) headers.push(`References: ${encodeHeaderValue(message.references_hdr)}`);
  if (message.reply_to) headers.push(`Reply-To: ${encodeHeaderValue(message.reply_to)}`);
  if (message.list_unsubscribe) headers.push(`List-Unsubscribe: ${encodeHeaderValue(message.list_unsubscribe)}`);
  if (message.auth_results) headers.push(`Authentication-Results: ${encodeHeaderValue(message.auth_results)}`);
  // Where it was and whether it was kept: this is the app's own note, so it is
  // an X- header rather than a pretence that the sender wrote it.
  headers.push(`X-Tempmail-Box: ${message.box}${message.starred ? "; starred" : ""}`);
  headers.push("X-Tempmail-Rebuilt: yes");

  const text = message.text_body;
  const html = message.html_body;
  let body: string;

  const alternative = () => {
    if (text != null && html != null) return multipart("alternative", [bodyPart("text/plain", text), bodyPart("text/html", html)]);
    if (html != null) return bodyPart("text/html", html);
    return bodyPart("text/plain", text ?? "");
  };

  if (attachments.length) {
    // Flat multipart/mixed. The sender's original nesting is not recorded, and
    // inventing a multipart/related around images that may not be related
    // would be a guess dressed up as fidelity.
    body = multipart("mixed", [alternative(), ...attachments.map(attachmentPart)]);
  } else {
    body = alternative();
  }

  return headers.join(CRLF) + CRLF + body + CRLF;
}

function multipart(subtype: string, parts: string[]): string {
  const boundary = `--=_tempmail_${(boundarySeed++).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const inner = parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF);
  return [`Content-Type: multipart/${subtype}; boundary="${boundary}"`, "", inner, `--${boundary}--`, ""].join(CRLF);
}

/**
 * One message as an mbox entry, in the mboxrd flavour.
 *
 * The separator is a line beginning "From " and nothing else may, so any line
 * in the body that starts with "From " -- or with ">From ", or ">>From " -- is
 * given one more ">". mboxrd is the variant that can be undone exactly, which
 * matters if this archive is ever read back.
 */
export function toMboxEntry(message: ExportMessage, attachments: ExportAttachment[]): string {
  const stamp = new Date(message.received_at).toUTCString().replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) ([\d:]+) GMT$/, "$1 $3 $2 $5 $4");
  const separator = `From ${sanitiseAddress(message.from_address)} ${stamp}`;
  const quoted = buildMessage(message, attachments).replace(/^(>*From )/gm, ">$1");
  return `${separator}${CRLF}${quoted}${CRLF}`;
}
