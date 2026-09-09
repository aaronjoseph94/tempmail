/**
 * What happens to a message between the parse and the insert.
 *
 * Three features want a say in where new mail lands — the rules the owner
 * wrote, the Screener that holds strangers, and the junk filter that learns
 * from their taps. Running them as three passes over the same message invites
 * exactly the bug where two of them disagree and the last one to write wins, so
 * they are one ordered pipeline instead, with a single verdict.
 *
 * Precedence, most authoritative first:
 *
 *   1. Rules      — the owner said so explicitly. Nothing overrules that.
 *   2. Screener   — a sender nobody has vouched for waits to be let in.
 *   3. Junk       — learned from their own marks, and only when it is sure.
 *
 * The Screener sits above the junk filter on purpose: there is no sense scoring
 * mail from someone nobody has vouched for, and a held message is a question
 * rather than a verdict.
 *
 * This runs inside the Email Routing handler, where a throw would bounce mail
 * that was otherwise perfectly deliverable. So the whole thing is wrapped: any
 * failure here delivers to the inbox and logs. A message in the wrong place is
 * a nuisance; a message that never arrived is data loss.
 *
 * Everything it needs is read in one batch, so the pipeline costs the ingest
 * path a single round trip however many stages end up hanging off it.
 */

import { relatedDomain, senderDomain, type AddressRow } from "./addresses";
import { SETTING_JUNK_TRAINED_HAM, SETTING_JUNK_TRAINED_JUNK, SETTING_SCREENER } from "./db";
import type { AuthSummary } from "./headers";
import { JUNK_THRESHOLD, junkScore, junkTokens } from "./junk";

/** Where a message lives. The trash is `deleted_at`, not a box. */
export const BOXES = ["inbox", "screener", "junk"] as const;
export type Box = (typeof BOXES)[number];

export function isBox(value: unknown): value is Box {
  return typeof value === "string" && (BOXES as readonly string[]).includes(value);
}

/** What the owner has decided about a sender. */
export const VERDICTS = ["allowed", "binned", "unknown"] as const;
export type SenderVerdict = (typeof VERDICTS)[number];

export function isVerdict(value: unknown): value is SenderVerdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

/** Everything the pipeline is allowed to look at. */
export interface Candidate {
  /** The recipient, lower-cased. */
  to: string;
  /** The sender's address, lower-cased. */
  from: string;
  fromName: string | null;
  subject: string;
  /** The message as readable text, whatever it arrived as. */
  plain: string | null;
  /** The verification code the message carries, if any. */
  code: string | null;
  hasAttachment: boolean;
  /** Cloudflare's SPF/DKIM/DMARC verdicts, when it said.  */
  auth: AuthSummary | null;
  /** The List-Unsubscribe header, verbatim, when there was one. */
  listUnsubscribe: string | null;
  /** The address's row, when the inbox already knew about it. */
  addressRow: AddressRow | null;
}

export interface Verdict {
  box: Box;
  /** Straight to the trash, where the usual undo window applies. */
  trash: boolean;
  star: boolean;
  read: boolean;
  /** One short phrase the reader can be shown: why the message is here. */
  reason: string | null;
}

/** The verdict for mail nothing had an opinion about. */
export function deliver(): Verdict {
  return { box: "inbox", trash: false, star: false, read: false, reason: null };
}

interface SenderRow {
  from_address: string;
  verdict: string;
  decided_at: number | null;
  first_seen_at: number | null;
}

/**
 * Decides where one message goes. Never throws and never rejects: the caller
 * has already accepted the mail at SMTP time, so the only question left is
 * which box it lands in.
 */
export async function classify(db: D1Database, candidate: Candidate): Promise<Verdict> {
  try {
    return await decide(db, candidate);
  } catch (err) {
    console.error("classification failed; delivering to the inbox", err);
    return deliver();
  }
}

async function decide(db: D1Database, candidate: Candidate): Promise<Verdict> {
  const verdict = deliver();

  // One round trip for every stage's inputs. Rules join this batch too rather
  // than adding a round trip of their own.
  const keys = [SETTING_SCREENER, SETTING_JUNK_TRAINED_JUNK, SETTING_JUNK_TRAINED_HAM];
  const [flags, senders] = await db.batch<Record<string, string> | SenderRow>([
    db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map((_, n) => `?${n + 1}`).join(",")})`).bind(...keys),
    db.prepare("SELECT * FROM senders WHERE from_address = ?1").bind(candidate.from),
  ]);
  const setting = new Map(
    (flags.results as { key: string; value: string }[]).map((row) => [row.key, row.value])
  );
  const sender = (senders.results as SenderRow[])[0] ?? null;

  if (setting.get(SETTING_SCREENER) === "1") screen(verdict, candidate, sender);

  // Only mail that is otherwise on its way to the inbox. There is nothing to
  // be gained by scoring a message that is already being held or binned.
  if (verdict.box === "inbox" && !verdict.trash) {
    await sift(db, verdict, candidate, {
      junk: Number(setting.get(SETTING_JUNK_TRAINED_JUNK) ?? 0) || 0,
      ham: Number(setting.get(SETTING_JUNK_TRAINED_HAM) ?? 0) || 0,
    });
  }
  return verdict;
}

/**
 * The junk filter, which only ever speaks when it is sure.
 *
 * Reads nothing at all until the owner has taught it both kinds of message, so
 * an instance whose owner has never pressed Junk pays nothing for this on the
 * ingest path.
 */
async function sift(db: D1Database, verdict: Verdict, candidate: Candidate, trained: { junk: number; ham: number }): Promise<void> {
  const address = candidate.addressRow;
  // Never the service an address was made for. The owner asked to hear from
  // them, so a false positive there is the most expensive mistake available --
  // it is the order confirmation and the password reset.
  if (address && relatedDomain(senderDomain(candidate.from), address.owner_domain)) return;

  const score = await junkScore(
    db,
    junkTokens({
      from: candidate.from,
      subject: candidate.subject,
      plain: candidate.plain,
      hasAttachment: candidate.hasAttachment,
      listUnsubscribe: candidate.listUnsubscribe,
      auth: candidate.auth,
    }),
    trained
  );
  if (score == null || score < JUNK_THRESHOLD) return;
  verdict.box = "junk";
  verdict.reason = `Looks like junk you have marked before (${Math.round(score * 100)}% sure)`;
}

/**
 * The Screener: mail from a sender nobody has vouched for waits to be let in.
 *
 * This is the answer to the one thing the README warns about — the mail side is
 * a true catch-all, so anyone who guesses an address at the domain reaches the
 * inbox. Holding the first message from an unknown sender turns that from a
 * problem into a question.
 *
 * The exemptions are what stop it being infuriating, and each one is a case
 * where holding the message would be actively wrong.
 */
function screen(verdict: Verdict, candidate: Candidate, sender: SenderRow | null): void {
  if (sender?.verdict === "allowed") return;
  if (sender?.verdict === "binned") {
    verdict.trash = true;
    verdict.reason = "You binned this sender";
    return;
  }

  const address = candidate.addressRow;

  // The service the address was made for. This is the same test the Leaks view
  // uses, from the other side: a sender that matches owner_domain is the one
  // company that is supposed to be writing here.
  if (address && relatedDomain(senderDomain(candidate.from), address.owner_domain)) return;

  // A burner the owner made and no mail has reached yet — they are standing
  // over it with the sign-up form open in the next tab.
  if (address && address.origin === "owner" && address.first_seen_at == null) return;

  // A verification code, to an address the owner made themselves. Swallowing a
  // sign-in code is the worst thing this app could do, and an address they
  // generated is one they are actively using. Deliberately not extended to
  // addresses the catch-all invented: otherwise "your code is 123456" in a spam
  // template would be a way past the Screener for every guessed address.
  if (candidate.code && address?.origin === "owner") return;

  verdict.box = "screener";
  verdict.reason = "First message from this sender";
}
