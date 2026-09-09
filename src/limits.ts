/**
 * Tunables.
 *
 * The constants below are the shipping defaults. The owner can override the
 * five that matter from Settings; those are stored in D1 and read back through
 * resolveLimits(), clamped to a range that keeps the Worker inside
 * Cloudflare's own limits.
 */

import {
  getSettings, SETTING_ATTACHMENT_MB, SETTING_GLOBAL_CAP, SETTING_PER_ADDRESS,
  SETTING_RAW_MB, SETTING_RETENTION_DAYS,
} from "./db";

/** Messages older than this are deleted by the nightly cron. Starred mail is kept. */
export const MESSAGE_TTL_DAYS = 100;

/** Deleted mail stays restorable for this long before the cron removes it for real. */
export const TRASH_TTL_MS = 24 * 60 * 60 * 1000;

/** How long an expired burner's row survives before the cron forgets it. */
export const BURNER_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard ceiling on stored messages, enforced nightly. Keeps D1 usage bounded. */
export const GLOBAL_MESSAGE_CAP = 5000;

/** Newest messages kept per address; older ones are pruned as mail arrives. */
export const MAX_MESSAGES_PER_ADDRESS = 200;

/** Raw messages bigger than this are bounced before we spend time parsing. */
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

/** Each stored body (text and HTML separately) is cut at this many characters. */
export const MAX_BODY_CHARS = 250_000;

/**
 * How much of a message search looks inside.
 *
 * Enough for anything anyone searches for -- the sender, the order number, the
 * one sentence they remember -- and small enough that scanning every message
 * stays a scan rather than an outing. A quarter-megabyte body is nearly all
 * quoted history and CSS.
 */
export const SEARCH_TEXT_CHARS = 8_000;

/** Attachment bytes kept per message. Anything past it keeps name and size only. */
export const ATTACHMENT_STORE_CAP = 25 * 1024 * 1024;

/**
 * Attachment content is split across rows at this many base64 characters.
 *
 * D1 refuses any single value over roughly 2 MB (SQLITE_TOOBIG), so a large
 * attachment cannot live in one row however the schema is written. 512 KB of
 * base64 is 384 KB of file per row, which leaves generous headroom. The value
 * must stay a multiple of 4 so every chunk decodes on its own.
 */
export const ATTACHMENT_CHUNK_CHARS = 512 * 1024;

/** Chunks pulled per query while streaming an attachment back out. */
export const ATTACHMENT_CHUNKS_PER_READ = 4;

/** How many chunk rows go into one D1 batch when storing an attachment. */
export const ATTACHMENT_CHUNKS_PER_WRITE = 4;

/** Default and maximum page size for the message list. */
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

export interface RuntimeLimits {
  retentionDays: number;
  perAddress: number;
  total: number;
  rawBytes: number;
  attachmentBytes: number;
}

/**
 * What survives the global cap, most worth keeping first.
 *
 * Starred mail first, because that is the owner saying so. Then junk last of
 * all, because it is the one box whose contents they have already been told
 * are worth nothing -- without that, a run of junk evicts real mail on age
 * alone. Everything else falls back to newest-first.
 *
 * Lives here rather than beside the query that uses it because src/index.ts is
 * the Worker's entrypoint module, and the runtime refuses to start if a named
 * export there is not a handler or a class.
 */
export const KEEP_ORDER = "starred DESC, (box = 'junk') ASC, received_at DESC, id DESC";

/** Bounds for the settings the owner can edit, shared with the UI. */
export const LIMIT_RANGES = {
  retentionDays: { min: 1, max: 365 },
  perAddress: { min: 10, max: 2000 },
  total: { min: 100, max: 20000 },
  rawMb: { min: 1, max: 25 },
  attachmentMb: { min: 1, max: 25 },
  /** How long a generated burner address may live, in hours. */
  burnerHours: { min: 1, max: 24 * 30 },
} as const;

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampMb(raw: string | null, min: number, max: number, fallbackBytes: number): number {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n)) return fallbackBytes;
  return Math.round(Math.min(max, Math.max(min, n)) * 1024 * 1024);
}

/** The limits in force right now: stored overrides, else the defaults above. */
export async function resolveLimits(db: D1Database): Promise<RuntimeLimits> {
  // One statement rather than five: this runs on every inbound message.
  const rows = await getSettings(db, [
    SETTING_RETENTION_DAYS, SETTING_PER_ADDRESS, SETTING_GLOBAL_CAP, SETTING_RAW_MB, SETTING_ATTACHMENT_MB,
  ]);
  const [days, per, total, rawMb, attachMb] = [
    rows.get(SETTING_RETENTION_DAYS) ?? null,
    rows.get(SETTING_PER_ADDRESS) ?? null,
    rows.get(SETTING_GLOBAL_CAP) ?? null,
    rows.get(SETTING_RAW_MB) ?? null,
    rows.get(SETTING_ATTACHMENT_MB) ?? null,
  ];
  return {
    retentionDays: clampInt(days, LIMIT_RANGES.retentionDays.min, LIMIT_RANGES.retentionDays.max, MESSAGE_TTL_DAYS),
    perAddress: clampInt(per, LIMIT_RANGES.perAddress.min, LIMIT_RANGES.perAddress.max, MAX_MESSAGES_PER_ADDRESS),
    total: clampInt(total, LIMIT_RANGES.total.min, LIMIT_RANGES.total.max, GLOBAL_MESSAGE_CAP),
    rawBytes: clampMb(rawMb, LIMIT_RANGES.rawMb.min, LIMIT_RANGES.rawMb.max, MAX_RAW_BYTES),
    attachmentBytes: clampMb(attachMb, LIMIT_RANGES.attachmentMb.min, LIMIT_RANGES.attachmentMb.max, ATTACHMENT_STORE_CAP),
  };
}
