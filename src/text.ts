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

export const SNIPPET_LENGTH = 160;

/** The one-line preview shown in the list. Prefers the text part, falls back to stripped HTML. */
export function makeSnippet(text: string | null | undefined, html: string | null | undefined): string | null {
  const source = text?.trim() ? text : html ? htmlToText(html) : "";
  const flat = source.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > SNIPPET_LENGTH ? flat.slice(0, SNIPPET_LENGTH - 1) + "…" : flat;
}

/* ------------------------------------------------- verification codes */

/*
 * A one-time code is a number a human is meant to retype, and nearly every
 * other number in a mail is not: order and invoice numbers, totals, counts,
 * quantities, ticket references. Sitting near the word "code" used to be the
 * whole test, which is how "postal code 94103" and "your order confirmation.
 * Total: 4500" both came back as codes.
 *
 * So: the words are graded rather than pooled, the window around the number is
 * short, "code" in a compound that means something else does not count, and a
 * number that names itself as a reference or carries a unit is thrown out
 * before it is scored at all.
 */

// The nouns that actually name a one-time code. One of these has to appear
// somewhere in the mail before anything is a candidate.
const CODE_NOUN = /\b(?:code|passcode|otp|pin|token|password|one[- ]?time|2fa|two[- ]factor)\b/i;

// ...except in these compounds, where "code" is a different kind of code.
const NOT_A_CODE =
  /\b(?:postal|post|zip|area|country|dial|error|status|promo|promotional|discount|coupon|voucher|referral|invite|invitation|qr|bar|colou?r|dress|source|region|airport|iata|swift|sort|reason|product|sku|tracking|shipping|delivery|store|branch)[ -]codes?\b/gi;

// Words that make a code likelier without naming one. Worth a nudge, never
// enough on their own -- "enter" and "security" turn up in any mail at all.
const CODE_HINT =
  /\b(?:verification|verify|confirm(?:ation)?|authenticat\w*|security|enter|sign[- ]?in|log[- ]?in|activation|access)\b/i;

// A number introduced as a reference is a reference, however close "code" is.
// Matched against the text immediately before the digits.
const REFERENCE =
  /\b(?:order|invoice|receipt|ticket|reference|ref|no|nr|num|number|id|account|tracking|awb|item|sku|qty|quantity|total|amount|balance|due|subtotal|tax|vat|price|cost|fee|line|row|page|version|build|port|ext|extension|suite|apt|unit|room|floor|postcode)\b[\s.:#=-]{0,4}$/i;

// A number with a unit after it is a quantity.
const UNIT =
  /^\s{0,2}(?:%|usd|eur|gbp|cad|aud|kg|g|lbs?|oz|mb|gb|kb|tb|km|mi|ft|cm|mm|px|items?|users?|members?|points?|miles?|credits?|views?|likes?|followers?|messages?|emails?|days?|weeks?|months?|years?|hours?|minutes?|mins?|seconds?|secs?|people|guests?|seats?|tickets?|orders?|results?|reviews?|stars?)\b/i;

// 4–8 digits (or two groups of three) that aren't part of a longer number,
// a price, a time, a date, a phone number or a "#12345"-style reference.
const CANDIDATE = /(?<![\d#$€£]|\d[ .,:/-])(\d{3}[ -]\d{3}|\d{4,8})(?![ -]?\d|[.,]\d|[%:/-]|\s?(?:am|pm)\b)/gi;

// How far either side of the number the wording still counts for it. Long
// enough for "your verification code is", short enough that the code word from
// one sentence does not vouch for the numbers in the next.
const WINDOW = 40;

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
    const ends = position + raw.length;

    // Four-digit years are almost never codes.
    if (code.length === 4 && +code >= 1900 && +code <= 2099) continue;

    const before = haystack.slice(Math.max(0, position - WINDOW), position);
    const after = haystack.slice(ends, ends + WINDOW);
    if (REFERENCE.test(before) || UNIT.test(after)) continue;

    // Only the sentence the number is in gets to vouch for it: "Postal code
    // 94103. Your tracking code is on the way." had a code noun on either side
    // of a number that is neither. A newline is not a sentence break here --
    // a code on its own line under its label is exactly the layout to keep.
    const said = before.replace(/^[\s\S]*[.!?]\s/, "").replace(NOT_A_CODE, " ");
    const saidAfter = after.replace(/[.!?]\s[\s\S]*$/, "").replace(NOT_A_CODE, " ");

    let score = 0;
    // A code noun ahead of the number is the real signal. Behind it is weaker:
    // "Order 1234 confirmed. Your code: 987654" puts one behind every number
    // in the sentence, including the order number.
    if (CODE_NOUN.test(said)) score += 4;
    else if (CODE_NOUN.test(saidAfter)) score += 3;
    if (CODE_HINT.test(said) || CODE_HINT.test(saidAfter)) score += 1;
    if (inSubject) score += 2;
    if (code.length === 6) score += 2;
    else if (code.length >= 5) score += 1;

    // A number alone on its own line is usually the code itself. Measured from
    // the real line, not from the window, which would call any number a line
    // of its own as soon as the window happened to start after a newline.
    const lineStart = haystack.lastIndexOf("\n", position - 1) + 1;
    const lineBreak = haystack.indexOf("\n", ends);
    const lineEnd = lineBreak === -1 ? haystack.length : lineBreak;
    if (/^[ \t]*$/.test(haystack.slice(lineStart, position)) && /^[ \t]*$/.test(haystack.slice(ends, lineEnd))) score += 2;

    found.push({ code, score, position: inSubject ? position - 1_000_000 : position });
  }
  return found;
}

/** Best guess at a verification code in the mail, or null when there isn't one. */
export function extractCode(subject: string | null | undefined, text: string | null | undefined): string | null {
  const body = (text ?? "").slice(0, 5000);
  // Nothing names a code anywhere, so anything found would be a guess.
  if (!CODE_NOUN.test((subject ?? "").replace(NOT_A_CODE, " ")) && !CODE_NOUN.test(body.replace(NOT_A_CODE, " "))) return null;

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
