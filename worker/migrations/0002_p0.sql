-- Migration 0002: P0 memory-layer upgrade
-- Run once against the existing D1 database, then deploy the new Worker,
-- then POST /admin/backfill_fts (repeat until remaining = 0).
--
--   wrangler d1 execute memory_sync --file worker/migrations/0002_p0.sql --remote

-- 1) New columns on memories (all nullable -> backfill-safe)
ALTER TABLE memories ADD COLUMN content_hash TEXT;
ALTER TABLE memories ADD COLUMN kind TEXT;
ALTER TABLE memories ADD COLUMN tags TEXT;
ALTER TABLE memories ADD COLUMN expires_at TEXT;
ALTER TABLE memories ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(bank, content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);

-- 2) Drop exact duplicates (same bank + same content), keep the earliest row.
--    (Application-level dedup via content_hash takes over for new writes.)
DELETE FROM memories WHERE id NOT IN (
  SELECT MIN(id) FROM memories GROUP BY bank, content
);

-- 3) FTS tables. Populated by the Worker at write time (application layer),
--    because Chinese segmentation needs Intl.Segmenter (JS runtime).
--    - memories_fts:     unicode61 over Worker-segmented text (CJK word/char
--                        tokens incl. 1-2 char queries, BM25 ranking)
--    - memories_fts_tri: trigram over raw text (true substring, >=3 chars)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_tri USING fts5(id UNINDEXED, content, tokenize='trigram');

-- 4) Seed the trigram table from existing rows (segmentation for memories_fts
--    is done by POST /admin/backfill_fts after deploy).
INSERT OR IGNORE INTO memories_fts_tri(id, content)
SELECT id, content FROM memories WHERE deleted_at IS NULL;
