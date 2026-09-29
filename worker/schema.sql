CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  bank TEXT DEFAULT 'shared',
  source TEXT DEFAULT 'client',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_bank ON memories(bank);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  bank TEXT DEFAULT 'shared',
  source TEXT DEFAULT 'client',
  created_at TEXT NOT NULL,
  claimed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inbox_claimed ON inbox(claimed, created_at);
