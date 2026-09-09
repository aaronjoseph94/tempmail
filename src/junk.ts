/**
 * The junk filter: a small word-scoring model trained only on the owner's own
 * Junk and Not-junk taps.
 *
 * Nothing is sent anywhere. There is no library — `script-src 'self'` rules out
 * a CDN one and a Worker has a CPU budget per message — so this is a few
 * hundred lines of arithmetic over a table of words. That is enough: a
 * throwaway inbox's junk is not subtle, and a filter the owner can be told the
 * reasons for is worth more here than one they cannot.
 *
 * The maths is Robinson's, not Graham's. Summing log-odds over fifteen words
 * reaches ±69 and the sigmoid of that is 0 or 1 for practically every message,
 * which makes the "confidence" a decoration and any threshold built on it
 * meaningless. Robinson combines the same evidence as a geometric mean, so the
 * nth root keeps the result spread across the range and a threshold means
 * something:
 *
 *   P = 1 - (∏(1 - f))^(1/n)      how ham-like the evidence is, inverted
 *   Q = 1 - (∏f)^(1/n)            how junk-like it is, inverted
 *   S = (1 + (P - Q) / (P + Q)) / 2
 *
 * Computed in log space, because the products underflow at fifteen terms.
 */

import { idChunks } from "./db";
import { senderDomain } from "./addresses";
import type { AuthSummary } from "./headers";

/** Distinct tokens kept from one message. */
export const JUNK_MAX_TOKENS = 150;
/** How much of the body is read. Junk gives itself away in the first screen. */
const JUNK_BODY_CHARS = 4000;
/** The most telling tokens actually scored. */
const JUNK_SCORE_TOKENS = 15;
/** Messages of each kind before the filter says anything at all. */
export const JUNK_MIN_TRAINED = 5;
/** Known words a message must contain before it is worth scoring. */
const JUNK_MIN_EVIDENCE = 5;
/** Robinson's prior: strength, and the probability to fall back on. */
const PRIOR_STRENGTH = 1;
const PRIOR = 0.5;
/**
 * How sure it has to be before it files anything.
 *
 * 0.85 rather than a rounder 0.9 because of where the smoothing puts the
 * ceiling: a word seen in all five of five junk messages and no good ones
 * scores (0.5 + 5) / 6 = 0.92, not 1, and a message made entirely of such
 * words therefore tops out around 0.92 -- so a 0.9 bar means the filter
 * reports itself "on" the moment it is trained and then never fires, which is
 * a worse lie than a slightly keener filter. It grows more confident on its
 * own as the counts rise.
 *
 * Not a setting. A number nobody can interpret, attached to a slider, is a
 * decoration; the honest controls are Junk, Not junk and Forget everything.
 */
export const JUNK_THRESHOLD = 0.85;
/** Rows kept in the word table; the nightly sweep trims to this. */
export const JUNK_MAX_ROWS = 20_000;

export interface JunkTraining {
  junk: number;
  ham: number;
}

export interface JunkInput {
  from: string;
  subject: string;
  plain: string | null;
  hasAttachment: boolean;
  listUnsubscribe?: string | null;
  auth?: AuthSummary | null;
}

/**
 * The words and facts one message contributes.
 *
 * Deterministic, because untraining has to be able to recompute exactly what
 * training added -- otherwise marking something Not junk leaves half its words
 * behind and the filter slowly poisons itself.
 *
 * The structured tokens go in first and are never crowded out by the body:
 * who sent it and whether it passed SPF, DKIM and DMARC are the cheapest real
 * signal there is, and on a catch-all they are often the only honest one.
 */
export function junkTokens(input: JunkInput): string[] {
  const tokens = new Set<string>();
  const from = input.from.toLowerCase();
  tokens.add(`from:${from}`);
  const domain = senderDomain(from);
  if (domain) tokens.add(`dom:${domain}`);
  for (const [name, verdict] of Object.entries(input.auth ?? {})) {
    if (verdict) tokens.add(`${name}:${verdict}`);
  }
  if (input.listUnsubscribe) tokens.add("has:unsubscribe");
  if (input.hasAttachment) tokens.add("has:attachment");

  const text = `${input.subject} ${(input.plain ?? "").slice(0, JUNK_BODY_CHARS)}`.toLowerCase();
  // "$" and "!" are kept on purpose: they are half the vocabulary of junk.
  for (const word of text.split(/[^a-z0-9$£€'!-]+/)) {
    if (tokens.size >= JUNK_MAX_TOKENS) break;
    if (word.length < 3 || word.length > 20) continue;
    // Order numbers, reference codes and the verification codes extractCode()
    // has already reasoned about: every one is unique, so every one would be
    // a word seen exactly once, which is noise wearing a hat.
    if (/^[0-9-]{5,}$/.test(word)) continue;
    tokens.add(word);
  }
  return [...tokens];
}

interface TokenRow {
  token: string;
  junk: number;
  ham: number;
}

/**
 * How junk-like this message looks, from 0 to 1, or null when the filter has
 * no business having an opinion.
 *
 * Null rather than a number in the middle, so the caller cannot accidentally
 * treat "I do not know" as "probably fine". Returns early, before touching the
 * word table at all, when it has not been trained -- an instance whose owner
 * has never pressed Junk pays nothing for this at ingest.
 */
export async function junkScore(db: D1Database, tokens: string[], trained: JunkTraining): Promise<number | null> {
  if (trained.junk < JUNK_MIN_TRAINED || trained.ham < JUNK_MIN_TRAINED) return null;
  if (!tokens.length) return null;

  // One round trip. 150 tokens is two statements at D1's 100-bind ceiling.
  const chunks = idChunks(tokens);
  const reads = await db.batch<TokenRow>(
    chunks.map((chunk) =>
      db
        .prepare(`SELECT token, junk, ham FROM junk_tokens WHERE token IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})`)
        .bind(...chunk)
    )
  );
  const rows = reads.flatMap((read) => read.results);
  if (rows.length < JUNK_MIN_EVIDENCE) return null;

  const scores = rows.map((row) => {
    // Normalised by how many messages of each kind were trained on, not by raw
    // counts: 200 junk and 10 good messages would otherwise make every word
    // look junk-like on volume alone.
    const junkRate = row.junk / trained.junk;
    const hamRate = row.ham / trained.ham;
    const raw = junkRate + hamRate === 0 ? PRIOR : junkRate / (junkRate + hamRate);
    const seen = row.junk + row.ham;
    // Pulled towards the prior by how little the word has been seen, so one
    // sighting cannot claim 0.99.
    const smoothed = (PRIOR_STRENGTH * PRIOR + seen * raw) / (PRIOR_STRENGTH + seen);
    return Math.min(0.99, Math.max(0.01, smoothed));
  });

  // The most telling words, whichever way they point.
  scores.sort((a, b) => Math.abs(b - 0.5) - Math.abs(a - 0.5));
  const top = scores.slice(0, JUNK_SCORE_TOKENS);
  const n = top.length;
  const lnP = top.reduce((sum, f) => sum + Math.log(1 - f), 0) / n;
  const lnQ = top.reduce((sum, f) => sum + Math.log(f), 0) / n;
  const p = 1 - Math.exp(lnP);
  const q = 1 - Math.exp(lnQ);
  if (p + q === 0) return null;
  return (1 + (p - q) / (p + q)) / 2;
}

/**
 * The words a scored message was filed on, most telling first, for the strip
 * that tells the reader why. Recomputed from the same rows rather than carried
 * along, because the answer is only wanted when a message is actually opened.
 */
export async function junkReasons(db: D1Database, tokens: string[], limit = 4): Promise<string[]> {
  const chunks = idChunks(tokens);
  const reads = await db.batch<TokenRow>(
    chunks.map((chunk) =>
      db
        .prepare(`SELECT token, junk, ham FROM junk_tokens WHERE token IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})`)
        .bind(...chunk)
    )
  );
  return reads
    .flatMap((read) => read.results)
    .filter((row) => row.junk > row.ham)
    .sort((a, b) => b.junk - a.junk)
    .slice(0, limit)
    .map((row) => row.token);
}

/**
 * Adds (or, with a negative delta, takes back) one message's worth of evidence.
 *
 * Counted per message and not per occurrence -- a word repeated forty times in
 * one mail is one message's evidence, not forty -- which junkTokens() already
 * guarantees by returning a set.
 *
 * Written as one batch of multi-row upserts rather than a statement per word:
 * marking twenty-five messages junk at once is an ordinary thing to do, and a
 * statement each would be thousands of them.
 */
export async function trainTokens(db: D1Database, counts: Map<string, number>, kind: "junk" | "ham"): Promise<void> {
  if (!counts.size) return;
  const now = Date.now();
  const entries = [...counts.entries()];
  const PER_ROW = 4;
  const perStatement = Math.floor(100 / PER_ROW);
  const statements = [];
  for (let i = 0; i < entries.length; i += perStatement) {
    const slice = entries.slice(i, i + perStatement);
    const values = slice.map((_, n) => `(?${n * PER_ROW + 1}, ?${n * PER_ROW + 2}, ?${n * PER_ROW + 3}, ?${n * PER_ROW + 4})`).join(",");
    const binds = slice.flatMap(([token, delta]) => [
      token,
      kind === "junk" ? delta : 0,
      kind === "ham" ? delta : 0,
      now,
    ]);
    statements.push(
      db
        .prepare(
          `INSERT INTO junk_tokens (token, junk, ham, seen_at) VALUES ${values}
             ON CONFLICT(token) DO UPDATE SET
               junk = MAX(0, junk_tokens.junk + excluded.junk),
               ham  = MAX(0, junk_tokens.ham  + excluded.ham),
               seen_at = excluded.seen_at`
        )
        .bind(...binds)
    );
  }
  await db.batch(statements);
}

/**
 * Trims the word table.
 *
 * Words seen once and never again are the bulk of it and carry almost nothing,
 * so they go first; after that it is oldest-first. Runs from the nightly cron,
 * never from the ingest path.
 */
export async function sweepJunkTokens(db: D1Database): Promise<void> {
  await db
    .prepare(
      `DELETE FROM junk_tokens WHERE token NOT IN (
         SELECT token FROM junk_tokens ORDER BY (junk + ham) DESC, seen_at DESC LIMIT ?1)`
    )
    .bind(JUNK_MAX_ROWS)
    .run();
}
