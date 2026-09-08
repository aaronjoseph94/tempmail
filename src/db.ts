/**
 * Database bootstrap, the settings store, and attachment storage.
 *
 * The Worker creates and upgrades its own tables the first time it runs, so a
 * fresh deployment needs no migration step. Every statement here is
 * idempotent, so running the bootstrap twice is harmless.
 */

/* Settings keys. */
export const SETTING_PASSWORD = "password_hash";
export const SETTING_SESSION_SECRET = "session_secret";
/**
 * The default mail domain -- the one shown and generated against. Kept as its
 * own row rather than derived, so an older client that only knows about one
 * domain still reads and writes something meaningful.
 */
export const SETTING_MAIL_DOMAIN = "mail_domain";
/**
 * Every domain this inbox offers, as a JSON array, most-preferred first. The
 * first entry is the default and is mirrored into SETTING_MAIL_DOMAIN.
 *
 * This is a display and generation list, never a security boundary: what mail
 * is actually accepted is decided by domainAccepted() against the MAIL_DOMAIN
 * variable and by the Email Routing rules, neither of which this can widen.
 */
export const SETTING_MAIL_DOMAINS = "mail_domains";
/** What the site calls itself. Empty falls back to BRAND_DEFAULT. */
export const SETTING_BRAND_NAME = "brand_name";
export const SETTING_RETENTION_DAYS = "retention_days";
export const SETTING_PER_ADDRESS = "per_address_cap";
export const SETTING_GLOBAL_CAP = "global_cap";
export const SETTING_RAW_MB = "raw_mb";
export const SETTING_ATTACHMENT_MB = "attachment_mb";
/**
 * The instance's Web Push (VAPID) key pair, created on first use and stored as
 * one JSON value. It used to live in two rows; writing them separately let two
 * concurrent creators each win one half, leaving a public key that did not
 * match the private one. The two legacy keys are still read as a fallback.
 */
export const SETTING_VAPID_KEYS = "vapid_keys";
export const SETTING_VAPID_PUBLIC = "vapid_public";
export const SETTING_VAPID_PRIVATE = "vapid_private";
/**
 * Runs a one-off data migration exactly once per database.
 *
 * The key itself is the latch: setSettingIfAbsent only writes when the key is
 * absent, so the first caller to claim it does the work and every later one
 * skips. Deliberately one key per migration rather than a version number --
 * SETTING_SCHEMA_VERSION below is claimed by key presence, so raising its value
 * would not re-arm it and a migration written that way would never run on any
 * database that already exists.
 *
 * A failure releases the latch, so a migration that dies half way through is
 * retried on the next cold start instead of being skipped forever.
 */
export async function runOnce(db: D1Database, key: string, work: () => Promise<void>): Promise<boolean> {
  if (!(await setSettingIfAbsent(db, key, String(Date.now())))) return false;
  try {
    await work();
  } catch (err) {
    await deleteSetting(db, key);
    throw err;
  }
  return true;
}

/** Bumped when a one-off data migration has run, so it never runs twice. */
export const SETTING_SCHEMA_VERSION = "schema_v";
const SCHEMA_VERSION = "3";

const CREATE_MESSAGES = `CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  address      TEXT NOT NULL,
  from_name    TEXT,
  from_address TEXT NOT NULL,
  subject      TEXT,
  snippet      TEXT,
  code         TEXT,
  text_body    TEXT,
  html_body    TEXT,
  attachments  TEXT,
  received_at  INTEGER NOT NULL,
  read         INTEGER NOT NULL DEFAULT 0,
  starred      INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER,
  message_id   TEXT,
  in_reply_to  TEXT,
  references_hdr TEXT,
  reply_to     TEXT,
  sent_at      INTEGER,
  list_unsubscribe TEXT,
  list_unsubscribe_post TEXT,
  auth_results TEXT,
  auth_summary TEXT,
  box          TEXT NOT NULL DEFAULT 'inbox',
  box_reason   TEXT
)`;

const CREATE_SETTINGS = `CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/**
 * Every address the inbox knows about: its nickname, its lifecycle and the
 * first domain that wrote to it. Rows appear on first mail or when the owner
 * generates a burner; the catch-all still accepts unknown addresses.
 */
const CREATE_ADDRESSES = `CREATE TABLE IF NOT EXISTS addresses (
  address       TEXT PRIMARY KEY,
  label         TEXT,
  mode          TEXT NOT NULL DEFAULT 'permanent',
  expires_at    INTEGER,
  owner_domain  TEXT,
  created_at    INTEGER NOT NULL,
  first_seen_at INTEGER
)`;

/** Browsers that asked to be pushed to when mail arrives. */
const CREATE_PUSH = `CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT
)`;

/** The pre-lifecycle label table; kept so the migration below can read it. */
const CREATE_LABELS = `CREATE TABLE IF NOT EXISTS address_labels (
  address TEXT PRIMARY KEY,
  label   TEXT NOT NULL
)`;

/** One row per attachment: everything except the bytes. */
const CREATE_ATTACHMENTS = `CREATE TABLE IF NOT EXISTS attachments (
  message_id   TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_id   TEXT,
  inline       INTEGER NOT NULL DEFAULT 0,
  chunks       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, idx)
)`;

/**
 * The bytes, base64 and split across rows.
 *
 * D1 rejects any single value over roughly 2 MB, so a 25 MB attachment has to
 * be chunked no matter how the schema is arranged. Reassembly happens while
 * streaming the download.
 */
const CREATE_CHUNKS = `CREATE TABLE IF NOT EXISTS attachment_chunks (
  message_id TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  data       TEXT NOT NULL,
  PRIMARY KEY (message_id, idx, seq)
)`;

const CREATE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_messages_address ON messages (address, received_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages (received_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_messages_starred ON messages (starred, received_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id)",
];

/** Columns added after the first release; older databases pick them up here. */
const ADDED_COLUMNS = [
  { name: "snippet", ddl: "ALTER TABLE messages ADD COLUMN snippet TEXT" },
  { name: "code", ddl: "ALTER TABLE messages ADD COLUMN code TEXT" },
  { name: "starred", ddl: "ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0" },
  // Soft delete: a trashed message keeps its row for a day so it can be undone.
  { name: "deleted_at", ddl: "ALTER TABLE messages ADD COLUMN deleted_at INTEGER" },
  // Headers worth keeping: threading ids, the sender's own date, one-click
  // unsubscribe links and Cloudflare's authentication verdicts.
  { name: "message_id", ddl: "ALTER TABLE messages ADD COLUMN message_id TEXT" },
  { name: "in_reply_to", ddl: "ALTER TABLE messages ADD COLUMN in_reply_to TEXT" },
  { name: "references_hdr", ddl: "ALTER TABLE messages ADD COLUMN references_hdr TEXT" },
  { name: "reply_to", ddl: "ALTER TABLE messages ADD COLUMN reply_to TEXT" },
  { name: "sent_at", ddl: "ALTER TABLE messages ADD COLUMN sent_at INTEGER" },
  { name: "list_unsubscribe", ddl: "ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT" },
  { name: "list_unsubscribe_post", ddl: "ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT" },
  { name: "auth_results", ddl: "ALTER TABLE messages ADD COLUMN auth_results TEXT" },
  { name: "auth_summary", ddl: "ALTER TABLE messages ADD COLUMN auth_summary TEXT" },
  // Which box the message landed in, and the one-line reason it is there.
  // Everything that already existed was ordinary mail, which is the default.
  { name: "box", ddl: "ALTER TABLE messages ADD COLUMN box TEXT NOT NULL DEFAULT 'inbox'" },
  { name: "box_reason", ddl: "ALTER TABLE messages ADD COLUMN box_reason TEXT" },
];

/** Indexes on columns that older databases only gain from ADDED_COLUMNS. */
const LATE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages (deleted_at)",
  // Every list query is scoped to one box, either across the inbox or within
  // one address, so both shapes get an index that ends in the sort column.
  "CREATE INDEX IF NOT EXISTS idx_messages_box ON messages (box, received_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_messages_address_box ON messages (address, box, received_at DESC)",
];

/** Creates or upgrades the schema. Safe to call as often as you like. */
export async function bootstrapSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(CREATE_MESSAGES),
    db.prepare(CREATE_SETTINGS),
    db.prepare(CREATE_ADDRESSES),
    db.prepare(CREATE_PUSH),
    db.prepare(CREATE_LABELS),
    db.prepare(CREATE_ATTACHMENTS),
    db.prepare(CREATE_CHUNKS),
    ...CREATE_INDEXES.map((sql) => db.prepare(sql)),
    // Left over from the original inbox-based design.
    db.prepare("DROP TABLE IF EXISTS inboxes"),
  ]);

  const { results } = await db.prepare("PRAGMA table_info(messages)").all<{ name: string }>();
  const present = new Set(results.map((column) => column.name));
  for (const column of ADDED_COLUMNS) {
    if (!present.has(column.name)) await db.prepare(column.ddl).run();
  }
  for (const sql of LATE_INDEXES) await db.prepare(sql).run();
  await migrateAddresses(db);
}

/**
 * One-off: fold the old label table into `addresses` and give every address
 * that already has mail a row. Runs once per database.
 */
async function migrateAddresses(db: D1Database): Promise<void> {
  if (!(await setSettingIfAbsent(db, SETTING_SCHEMA_VERSION, SCHEMA_VERSION))) return;
  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO addresses (address, label, mode, created_at)
         SELECT address, label, 'permanent', ?1 FROM address_labels`
    ).bind(now),
    db.prepare("DELETE FROM address_labels"),
    db.prepare(
      `INSERT OR IGNORE INTO addresses (address, mode, created_at, first_seen_at)
         SELECT address, 'permanent', MIN(received_at), MIN(received_at) FROM messages GROUP BY address`
    ),
    // The one-shot lifetime was removed; addresses that used it become
    // ordinary ones rather than silently bouncing forever.
    db.prepare("UPDATE addresses SET mode = 'permanent' WHERE mode = 'sealed'"),
  ]);
}

let bootstrap: Promise<void> | null = null;

/** Runs the bootstrap once per isolate. Concurrent first requests share it. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!bootstrap) {
    bootstrap = bootstrapSchema(db).catch((err) => {
      bootstrap = null; // let the next request try again
      throw err;
    });
  }
  return bootstrap;
}

/* ------------------------------------------------------------- settings */

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

/** Writes the value only if the key is still unset. Returns whether it did. */
export async function setSettingIfAbsent(db: D1Database, key: string, value: string): Promise<boolean> {
  const result = await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)").bind(key, value).run();
  return result.meta.changes === 1;
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run();
}

/* --------------------------------------------------------------- labels */

export async function setLabel(db: D1Database, address: string, label: string): Promise<void> {
  if (!label) {
    await db.prepare("UPDATE addresses SET label = NULL WHERE address = ?1").bind(address).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO addresses (address, label, mode, created_at) VALUES (?1, ?2, 'permanent', ?3)
       ON CONFLICT(address) DO UPDATE SET label = excluded.label`
    )
    .bind(address, label, Date.now())
    .run();
}

/* ------------------------------------------------------- bulk id writes */

/** D1 refuses a statement with more than this many bound variables. */
export const D1_MAX_BINDS = 100;

/**
 * Slices ids into runs that fit one statement. `reserved` is how many binds
 * the caller needs for everything else in the same statement.
 */
export function idChunks(ids: string[], reserved = 0): string[][] {
  const size = Math.max(1, D1_MAX_BINDS - reserved);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Deletes these messages outright, attachments and all. Not the trash. */
export async function deleteMessagesByIds(db: D1Database, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await deleteAttachmentsFor(db, ids);
  for (const chunk of idChunks(ids)) {
    const holes = chunk.map((_, n) => `?${n + 1}`).join(",");
    await db.prepare(`DELETE FROM messages WHERE id IN (${holes})`).bind(...chunk).run();
  }
}

/* ---------------------------------------------------------- attachments */

/** Drops a message's attachment rows and their chunks. */
export async function deleteAttachmentsFor(db: D1Database, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  // Bind each id rather than interpolating, in batches D1 is happy with.
  for (const slice of idChunks(messageIds)) {
    const holes = slice.map((_, n) => `?${n + 1}`).join(",");
    await db.batch([
      db.prepare(`DELETE FROM attachment_chunks WHERE message_id IN (${holes})`).bind(...slice),
      db.prepare(`DELETE FROM attachments WHERE message_id IN (${holes})`).bind(...slice),
    ]);
  }
}

/** Removes attachment rows whose message is gone (a backstop for the cron). */
export async function sweepOrphanAttachments(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM attachment_chunks WHERE message_id NOT IN (SELECT id FROM messages)"),
    db.prepare("DELETE FROM attachments WHERE message_id NOT IN (SELECT id FROM messages)"),
  ]);
}
