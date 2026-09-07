/**
 * Text helpers for the mail pipeline: HTML stripping, list snippets,
 * verification-code detection and a domain check.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™",
};

function decodeEntity(entity: string): string {
  if (entity[0] === "#") {
    const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
  }
  return NAMED_ENTITIES[entity.toLowerCase()] ?? " ";
}

/** Rough but dependable HTML-to-text: drops markup, keeps the line breaks that matter. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|table|pre)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => decodeEntity(entity))
    .replace(/[ \t\r\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SNIPPET_LENGTH = 160;

/** The one-line preview shown in the list. Prefers the text part, falls back to stripped HTML. */
export function makeSnippet(text: string | null | undefined, html: string | null | undefined): string | null {
  const source = text?.trim() ? text : html ? htmlToText(html) : "";
  const flat = source.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > SNIPPET_LENGTH ? flat.slice(0, SNIPPET_LENGTH - 1) + "…" : flat;
}

/* ------------------------------------------------- verification codes */

// Words that tend to sit next to a one-time code.
const CODE_WORDS =
  /\b(code|passcode|one[- ]?time|otp|verification|verify|confirm(?:ation)?|pin|token|2fa|two[- ]factor|authenticat\w*|security|enter)\b/i;

// 4–8 digits (or two groups of three) that aren't part of a longer number,
// a price, a time, a date, a phone number or a "#12345"-style reference.
const CANDIDATE = /(?<![\d#$€£]|\d[ .,:/-])(\d{3}[ -]\d{3}|\d{4,8})(?![ -]?\d|[.,]\d|[%:/-]|\s?(?:am|pm)\b)/gi;

interface Candidate {
  code: string;
  score: number;
  position: number;
}

function findCandidates(haystack: string, inSubject: boolean): Candidate[] {
  const found: Candidate[] = [];
  for (const match of haystack.matchAll(CANDIDATE)) {
    const raw = match[1];
    const code = raw.replace(/[ -]/g, "");
    const position = match.index ?? 0;

    // Four-digit years are almost never codes.
    if (code.length === 4 && +code >= 1900 && +code <= 2099) continue;

    const before = haystack.slice(Math.max(0, position - 80), position);
    const after = haystack.slice(position + raw.length, position + raw.length + 40);

    let score = 0;
    if (CODE_WORDS.test(before) || CODE_WORDS.test(after)) score += 4;
    if (inSubject) score += 2;
    if (code.length === 6) score += 2;
    else if (code.length >= 5) score += 1;
    // A number sitting alone on its own line is usually the code itself.
    if (/(^|\n)[ \t]*$/.test(before) && /^[ \t]*(\n|$)/.test(after)) score += 2;

    found.push({ code, score, position: inSubject ? position - 1_000_000 : position });
  }
  return found;
}

/** Best guess at a verification code in the mail, or null when there isn't one. */
export function extractCode(subject: string | null | undefined, text: string | null | undefined): string | null {
  const body = (text ?? "").slice(0, 5000);
  // Without any code-like wording anywhere we'd only be guessing.
  if (!CODE_WORDS.test(subject ?? "") && !CODE_WORDS.test(body)) return null;

  let best: Candidate | null = null;
  for (const candidate of [...findCandidates(subject ?? "", true), ...findCandidates(body, false)]) {
    if (candidate.score < 4) continue;
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.position < best.position)) {
      best = candidate;
    }
  }
  return best?.code ?? null;
}

/* ------------------------------------------------------------ domains */

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * Normalises user input like " Mail.Example.com " to "mail.example.com".
 * Returns "" for empty input and null when it doesn't look like a domain.
 */
export function normalizeDomain(input: unknown): string | null {
  if (input == null) return "";
  if (typeof input !== "string") return null;
  const trimmed = input.trim().replace(/^@/, "");
  if (!trimmed) return "";
  // Email Routing addresses domains by their A-label, and so does the regex
  // below, so an internationalised name is punycoded first: "münchen.de"
  // becomes "xn--mnchen-3ya.de" rather than being rejected as non-ASCII.
  let domain: string;
  try {
    domain = new URL(`https://${trimmed}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!domain) return null;
  return DOMAIN.test(domain) ? domain : null;
}
