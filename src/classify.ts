/**
 * What happens to a message between the parse and the insert.
 *
 * Three features want a say in where new mail lands — the rules the owner
 * wrote, the junk filter that learns from their taps, and the Screener that
 * holds strangers. Running them as three separate passes over the same message
 * invites exactly the bug where two of them disagree and the last one to write
 * wins, so they are one ordered pipeline instead, with a single verdict.
 *
 * Precedence, most authoritative first:
 *
 *   1. Rules      — the owner said so explicitly. Nothing overrules that.
 *   2. Junk       — learned from their own marks, and only when it is sure.
 *   3. Screener   — a sender nobody has vouched for waits to be let in.
 *
 * This runs inside the Email Routing handler, where a throw would bounce mail
 * that was otherwise perfectly deliverable. So the whole thing is wrapped: any
 * failure here delivers to the inbox and logs. A message in the wrong place is
 * a nuisance; a message that never arrived is data loss.
 */

import type { AddressRow } from "./addresses";

/** Where a message lives. The trash is `deleted_at`, not a box. */
export const BOXES = ["inbox", "screener", "junk"] as const;
export type Box = (typeof BOXES)[number];

export function isBox(value: unknown): value is Box {
  return typeof value === "string" && (BOXES as readonly string[]).includes(value);
}

/** Everything the pipeline is allowed to look at. */
export interface Candidate {
  /** The recipient, lower-cased. */
  to: string;
  /** The sender's address, lower-cased. */
  from: string;
  fromName: string | null;
  subject: string;
  text: string | null;
  html: string | null;
  hasAttachment: boolean;
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

async function decide(_db: D1Database, _candidate: Candidate): Promise<Verdict> {
  // Rules, the junk filter and the Screener each attach here, in that order.
  // Until they do, every message is ordinary mail.
  return deliver();
}
