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
export const SETTING_MAIL_DOMAIN = "mail_domain";
export const SETTING_RETENTION_DAYS = "retention_days";
export const SETTING_PER_ADDRESS = "per_address_cap";
export const SETTING_GLOBAL_CAP = "global_cap";
export const SETTING_RAW_MB = "raw_mb";
export const SETTING_ATTACHMENT_MB = "attachment_mb";

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
  deleted_at   INTEGER
)`;

const CREATE_SETTINGS = `CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/** Per-address nicknames, so "shop-otter-12" can read as "Shopping". */
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
];

/** Indexes on columns that older databases only gain from ADDED_COLUMNS. */
const LATE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages (deleted_at)",
];

/** Creates or upgrades the schema. Safe to call as often as you like. */
export async function bootstrapSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(CREATE_MESSAGES),
    db.prepare(CREATE_SETTINGS),
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

export async function getLabels(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare("SELECT address, label FROM address_labels").all<{ address: string; label: string }>();
  return Object.fromEntries(results.map((row) => [row.address, row.label]));
}

export async function setLabel(db: D1Database, address: string, label: string): Promise<void> {
  if (!label) {
    await db.prepare("DELETE FROM address_labels WHERE address = ?1").bind(address).run();
    return;
  }
  await db
    .prepare("INSERT INTO address_labels (address, label) VALUES (?1, ?2) ON CONFLICT(address) DO UPDATE SET label = excluded.label")
    .bind(address, label)
    .run();
}

/* ---------------------------------------------------------- attachments */

/** Drops a message's attachment rows and their chunks. */
export async function deleteAttachmentsFor(db: D1Database, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  // Bind each id rather than interpolating, in batches D1 is happy with.
  // 90 at a time: D1 caps a statement at 100 bound variables.
  for (let i = 0; i < messageIds.length; i += 90) {
    const slice = messageIds.slice(i, i + 90);
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
