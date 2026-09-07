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
  -- JSON array of { filename, contentType, size, contentId?, inline?, base64? };
  -- base64 is present only while the attachment fits the storage cap
  attachments  TEXT,
  received_at  INTEGER NOT NULL,           -- milliseconds since the epoch
  read         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_address ON messages (address, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages (received_at DESC);

-- Site settings: the password hash, the session-signing secret and the
-- display domain. Forgot the password? Delete its row and reload the site:
--   DELETE FROM settings WHERE key = 'password_hash';
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
