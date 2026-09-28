-- npx wrangler d1 execute shawn-ai --remote --file worker/schema.sql
-- D1 enforces foreign keys, so deleting a user cascades to their chats and messages.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  sub TEXT UNIQUE NOT NULL,        -- "<provider>:<subject>", e.g. "google:1234"
  email TEXT,
  name TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,             -- the first question, so titling costs no tokens
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_user ON chats(user_id, updated);
CREATE TABLE IF NOT EXISTS messages (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id);
-- One row per Groq answer. usage.html shows signed-in visitors their own rows.
-- Existing databases: ALTER TABLE usage ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
CREATE TABLE IF NOT EXISTS usage (
  ts INTEGER NOT NULL,
  path TEXT NOT NULL,
  model TEXT,
  prompt INTEGER,
  cached INTEGER,
  out INTEGER,
  ms INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE   -- null for API, Slack and signed-out chat
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS usage_user ON usage(user_id, ts);
