-- Fresh-install schema (includes everything from migrations/0002_p0.sql).
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT,
  bank TEXT DEFAULT 'shared',
  source TEXT DEFAULT 'client',
  kind TEXT,
  tags TEXT,
  expires_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_bank ON memories(bank);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(bank, content_hash);

-- Full-text search (populated by the Worker at write time; see README).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_tri USING fts5(id UNINDEXED, content, tokenize='trigram');

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  bank TEXT DEFAULT 'shared',
  source TEXT DEFAULT 'client',
  created_at TEXT NOT NULL,
  claimed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inbox_claimed ON inbox(claimed, created_at);
