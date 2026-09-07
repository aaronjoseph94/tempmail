-- D1 schema for tempmail, for reference only.
--
-- The Worker creates and upgrades these tables itself the first time it runs
-- (see bootstrapSchema in src/db.ts), so you never need to apply this file.
-- It's here so you can see what's stored, and for `wrangler d1 execute` if
-- you like doing things by hand.

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,           -- random UUID
  address      TEXT NOT NULL,              -- the recipient, lower-cased
  from_name    TEXT,
  from_address TEXT NOT NULL,
  subject      TEXT,
  snippet      TEXT,                       -- first ~160 characters, for the list
  code         TEXT,                       -- verification code spotted in the mail, if any
  text_body    TEXT,
  html_body    TEXT,
  attachments  TEXT,                       -- JSON summary; the bytes live in the tables below
  received_at  INTEGER NOT NULL,           -- milliseconds since the epoch, when it arrived here
  read         INTEGER NOT NULL DEFAULT 0,
  starred      INTEGER NOT NULL DEFAULT 0, -- starred mail survives every cleanup
  deleted_at   INTEGER,                    -- set while in the trash; purged after a day
  -- Headers worth keeping.
  message_id   TEXT,
  in_reply_to  TEXT,
  references_hdr TEXT,
  reply_to     TEXT,
  sent_at      INTEGER,                    -- the sender's own Date header
  list_unsubscribe TEXT,
  list_unsubscribe_post TEXT,
  auth_results TEXT,                       -- Cloudflare's Authentication-Results, verbatim
  auth_summary TEXT                        -- JSON {"spf","dkim","dmarc"} parsed from it
);

CREATE INDEX IF NOT EXISTS idx_messages_address ON messages (address, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_starred ON messages (starred, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages (deleted_at);

-- Every address the inbox knows: its nickname, lifecycle and first sender.
-- Unknown addresses get a permanent row on their first message, so the
-- catch-all keeps working; burners are created before their first message.
CREATE TABLE IF NOT EXISTS addresses (
  address       TEXT PRIMARY KEY,
  label         TEXT,
  mode          TEXT NOT NULL DEFAULT 'permanent', -- permanent | expires | sealed | blocked
  expires_at    INTEGER,                           -- for mode = expires
  owner_domain  TEXT,                              -- the service the address was given to
  created_at    INTEGER NOT NULL,
  first_seen_at INTEGER                            -- first accepted message; a sealed address is used once this is set
);

-- One row per attachment (everything except the bytes), and the bytes as
-- base64 split across rows, because D1 refuses any single value over ~2 MB.
CREATE TABLE IF NOT EXISTS attachments (
  message_id   TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_id   TEXT,
  inline       INTEGER NOT NULL DEFAULT 0,
  chunks       INTEGER NOT NULL DEFAULT 0,        -- 0 when only the metadata was kept
  PRIMARY KEY (message_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);

CREATE TABLE IF NOT EXISTS attachment_chunks (
  message_id TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  data       TEXT NOT NULL,
  PRIMARY KEY (message_id, idx, seq)
);

-- Browsers that asked to be pushed to when mail arrives.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT
);

-- Site settings: the password hash, the session-signing secret, the display
-- domain, the editable limits, the Web Push key pair and the schema version.
-- Forgot the password? Delete its row and reload the site:
--   DELETE FROM settings WHERE key = 'password_hash';
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
