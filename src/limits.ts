/**
 * Tunables.
 *
 * The constants below are the shipping defaults. The owner can override the
 * four that matter from Settings; those are stored in D1 and read back through
 * resolveLimits(), clamped to a range that keeps the Worker inside
 * Cloudflare's own limits.
 */

import {
  getSetting, SETTING_ATTACHMENT_MB, SETTING_GLOBAL_CAP, SETTING_PER_ADDRESS,
  SETTING_RAW_MB, SETTING_RETENTION_DAYS,
} from "./db";

/** Messages older than this are deleted by the nightly cron. Starred mail is kept. */
export const MESSAGE_TTL_DAYS = 100;

/** Deleted mail stays restorable for this long before the cron removes it for real. */
export const TRASH_TTL_MS = 24 * 60 * 60 * 1000;

/** Hard ceiling on stored messages, enforced nightly. Keeps D1 usage bounded. */
export const GLOBAL_MESSAGE_CAP = 5000;

/** Newest messages kept per address; older ones are pruned as mail arrives. */
export const MAX_MESSAGES_PER_ADDRESS = 200;

/** Raw messages bigger than this are bounced before we spend time parsing. */
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

/** Each stored body (text and HTML separately) is cut at this many characters. */
export const MAX_BODY_CHARS = 250_000;

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

/** Bounds for the settings the owner can edit, shared with the UI. */
export const LIMIT_RANGES = {
  retentionDays: { min: 1, max: 365 },
  perAddress: { min: 10, max: 2000 },
  total: { min: 100, max: 20000 },
  rawMb: { min: 1, max: 25 },
  attachmentMb: { min: 1, max: 25 },
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
  const [days, per, total, rawMb, attachMb] = await Promise.all([
    getSetting(db, SETTING_RETENTION_DAYS),
    getSetting(db, SETTING_PER_ADDRESS),
    getSetting(db, SETTING_GLOBAL_CAP),
    getSetting(db, SETTING_RAW_MB),
    getSetting(db, SETTING_ATTACHMENT_MB),
  ]);
  return {
    retentionDays: clampInt(days, LIMIT_RANGES.retentionDays.min, LIMIT_RANGES.retentionDays.max, MESSAGE_TTL_DAYS),
    perAddress: clampInt(per, LIMIT_RANGES.perAddress.min, LIMIT_RANGES.perAddress.max, MAX_MESSAGES_PER_ADDRESS),
    total: clampInt(total, LIMIT_RANGES.total.min, LIMIT_RANGES.total.max, GLOBAL_MESSAGE_CAP),
    rawBytes: clampMb(rawMb, LIMIT_RANGES.rawMb.min, LIMIT_RANGES.rawMb.max, MAX_RAW_BYTES),
    attachmentBytes: clampMb(attachMb, LIMIT_RANGES.attachmentMb.min, LIMIT_RANGES.attachmentMb.max, ATTACHMENT_STORE_CAP),
  };
}
