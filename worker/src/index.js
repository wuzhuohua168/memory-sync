const JH = { 'Content-Type': 'application/json' };
const ok = data =>
  new Response(JSON.stringify({ ok: true, ...data }), { headers: JH });
const err = (msg, status = 400) =>
  new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: JH,
  });

const KINDS = new Set([
  'fact',
  'preference',
  'decision',
  'project',
  'task',
  'note',
]);
const nowISO = () => new Date().toISOString();
const clampInt = (v, dflt, min, max) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
};

// ---------------------------------------------------------------------------
// Text utils
// ---------------------------------------------------------------------------
let _seg = null;
function segment(text) {
  // Application-layer Chinese segmentation for FTS indexing.
  // Intl.Segmenter is built into the Workers (V8) runtime — no dependencies.
  try {
    if (!_seg) _seg = new Intl.Segmenter('zh', { granularity: 'word' });
    return [..._seg.segment(text)]
      .map(s => s.segment)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return text;
  }
}

const normalize = t => (t || '').replace(/\s+/g, ' ').trim();

async function sha256hex(t) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(t)
  );
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Escape a term for a LIKE pattern (D1 limits LIKE patterns to 50 bytes,
// so callers must also keep terms short).
const likeEscape = t => t.replace(/[\\%_]/g, m => '\\' + m);

// Escape one token for an FTS5 MATCH expression; returns '""' when empty.
const ftsEscape = t => {
  const clean = (t || '').replace(/["*():^]/g, '').trim();
  return clean ? `"${clean}"` : '""';
};
// Keep only tokens that contain at least one letter/number (drops bare
// punctuation segments like "-" which unicode61 would not index anyway).
const keepToken = t =>
  t && t !== '""' && /[\p{L}\p{N}]/u.test(t.replace(/^"|"$/g, ''));

function parseTags(tags) {
  if (tags === null || tags === undefined) return null;
  if (!Array.isArray(tags)) throw new Error('tags must be an array');
  const clean = tags
    .map(t => String(t).slice(0, 32))
    .filter(Boolean)
    .slice(0, 10);
  return JSON.stringify(clean);
}

function parseExpiresAt(v) {
  if (v === null || v === undefined || v === '') return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error('expires_at is not a valid date');
  return new Date(ms).toISOString();
}

function outRow(r) {
  let tags = null;
  try {
    tags = r.tags ? JSON.parse(r.tags) : null;
  } catch {
    tags = null;
  }
  return {
    id: r.id,
    content: r.content,
    bank: r.bank,
    source: r.source,
    kind: r.kind || null,
    tags,
    created_at: r.created_at,
    updated_at: r.updated_at,
    ...(r.expires_at ? { expires_at: r.expires_at } : {}),
  };
}

// ---------------------------------------------------------------------------
// FTS helpers (application-layer sync; the Worker is the only writer)
// ---------------------------------------------------------------------------
async function ftsReady(db) {
  try {
    const r = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('memories_fts','memories_fts_tri')"
      )
      .first();
    return r && r.n === 2;
  } catch {
    return false;
  }
}

function indexStmts(db, id, content) {
  return [
    db.prepare('DELETE FROM memories_fts WHERE id = ?').bind(id),
    db.prepare('DELETE FROM memories_fts_tri WHERE id = ?').bind(id),
    db
      .prepare('INSERT INTO memories_fts(id, content) VALUES(?, ?)')
      .bind(id, segment(content)),
    db
      .prepare('INSERT INTO memories_fts_tri(id, content) VALUES(?, ?)')
      .bind(id, content),
  ];
}

function unindexStmts(db, id) {
  return [
    db.prepare('DELETE FROM memories_fts WHERE id = ?').bind(id),
    db.prepare('DELETE FROM memories_fts_tri WHERE id = ?').bind(id),
  ];
}

// Shared visibility filter: not soft-deleted, not expired.
function visFilter(alias = 'm') {
  return {
    sql: `${alias}.deleted_at IS NULL AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)`,
    params: [nowISO()],
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// Hybrid recall: segmented FTS5 (BM25) + trigram substring + LIKE fallback.
async function handleRecall(db, url) {
  const q = normalize(url.searchParams.get('q') || '');
  const k = clampInt(url.searchParams.get('k'), 5, 1, 20);
  const bank = url.searchParams.get('bank');
  const kind = url.searchParams.get('kind');
  if (!q) return err('missing q');
  if (kind && !KINDS.has(kind)) return err('bad kind');

  // Keep terms short: D1 caps LIKE patterns at 50 bytes.
  const terms = q
    .split(' ')
    .filter(Boolean)
    .slice(0, 8)
    .map(t => [...t].slice(0, 20).join(''));
  if (!terms.length) return err('missing q');

  const vis = visFilter('m');
  const extra = { sql: '', params: [] };
  if (bank) {
    extra.sql += ' AND m.bank = ?';
    extra.params.push(bank);
  }
  if (kind) {
    extra.sql += ' AND m.kind = ?';
    extra.params.push(kind);
  }
  const where = `WHERE ${vis.sql}${extra.sql}`;
  const whereParams = [...vis.params, ...extra.params];

  const cands = new Map(); // id -> {row, score}
  const add = (row, score) => {
    const prev = cands.get(row.id);
    if (!prev || score > prev.score) cands.set(row.id, { row, score });
  };

  const ready = await ftsReady(db);

  if (ready) {
    // 1) Segmented word index — handles CJK (incl. 1-2 char queries) + BM25.
    const tokens = segment(q)
      .split(' ')
      .map(ftsEscape)
      .filter(keepToken)
      .slice(0, 12);
    if (tokens.length) {
      const expr = tokens.join(' AND ');
      try {
        const rows =
          (
            await db
              .prepare(
                `SELECT m.id, m.content, m.bank, m.source, m.kind, m.tags, m.created_at, m.updated_at, m.expires_at,
                  bm25(memories_fts) AS r
           FROM memories_fts f JOIN memories m ON m.id = f.id
           ${where} AND f.content MATCH ?
           ORDER BY r LIMIT 100`
              )
              .bind(...whereParams, expr)
              .all()
          ).results || [];
        for (const r of rows) add(r, 10 + 1 / (1 + Math.max(0, r.r)));
      } catch {
        /* malformed MATCH -> fall through to LIKE */
      }
    }
    // 2) Trigram index — true substring matches for queries >= 3 chars.
    const triTerms = terms
      .filter(t => [...t].length >= 3)
      .map(ftsEscape)
      .filter(keepToken);
    if (triTerms.length) {
      const expr = triTerms.join(' AND ');
      try {
        const rows =
          (
            await db
              .prepare(
                `SELECT m.id, m.content, m.bank, m.source, m.kind, m.tags, m.created_at, m.updated_at, m.expires_at
           FROM memories_fts_tri f JOIN memories m ON m.id = f.id
           ${where} AND f.content MATCH ? LIMIT 100`
              )
              .bind(...whereParams, expr)
              .all()
          ).results || [];
        for (const r of rows) add(r, (cands.get(r.id)?.score || 0) + 5);
      } catch {
        /* fall through */
      }
    }
  }

  // 3) LIKE fallback: no FTS (not migrated yet) or FTS found nothing.
  if (cands.size === 0) {
    const likes = terms.map(() => "m.content LIKE ? ESCAPE '\\'").join(' OR ');
    const params = terms.map(t => `%${likeEscape(t)}%`);
    const rows =
      (
        await db
          .prepare(
            `SELECT m.id, m.content, m.bank, m.source, m.kind, m.tags, m.created_at, m.updated_at, m.expires_at
       FROM memories m ${where} AND (${likes})
       ORDER BY m.updated_at DESC LIMIT 200`
          )
          .bind(...whereParams, ...params)
          .all()
      ).results || [];
    for (const r of rows) {
      let hits = 0;
      for (const t of terms) if (r.content.includes(t)) hits++;
      add(r, hits);
    }
  }

  const items = [...cands.values()]
    .sort(
      (a, b) =>
        b.score - a.score || (a.row.updated_at < b.row.updated_at ? 1 : -1)
    )
    .slice(0, k)
    .map(c => outRow(c.row));
  return ok({ items, fts: ready });
}

// Timeline: what changed since `since` — no keyword guessing needed.
async function handleDigest(db, url) {
  const k = clampInt(url.searchParams.get('k'), 20, 1, 50);
  const bank = url.searchParams.get('bank');
  const sinceRaw = url.searchParams.get('since');
  const since =
    sinceRaw && Number.isFinite(Date.parse(sinceRaw))
      ? new Date(Date.parse(sinceRaw)).toISOString()
      : new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const vis = visFilter('m');
  let sql = `SELECT m.id, m.content, m.bank, m.source, m.kind, m.tags, m.created_at, m.updated_at, m.expires_at
             FROM memories m WHERE m.updated_at > ? AND ${vis.sql}`;
  const params = [since, ...vis.params];
  if (bank) {
    sql += ' AND m.bank = ?';
    params.push(bank);
  }
  sql += ' ORDER BY m.updated_at DESC LIMIT ?';
  params.push(k);
  const rows =
    (
      await db
        .prepare(sql)
        .bind(...params)
        .all()
    ).results || [];
  return ok({ items: rows.map(outRow), since });
}

async function handleRetain(db, body) {
  const content = normalize(body.content || '');
  if (content.length < 2) return err('content too short');
  if (content.length > 8000) return err('content too long');
  const bank = String(body.bank || 'shared').slice(0, 64);
  const source = String(body.source || 'client').slice(0, 64);
  let kind = null,
    tags = null,
    expires_at = null;
  try {
    if (body.kind) {
      if (!KINDS.has(body.kind)) return err('bad kind');
      kind = body.kind;
    }
    tags = parseTags(body.tags);
    expires_at = parseExpiresAt(body.expires_at);
  } catch (e) {
    return err(e.message);
  }

  // Dedup: same normalized content in the same bank -> refresh, don't duplicate.
  const hash = await sha256hex(bank + '\n' + content);
  const dup = await db
    .prepare(
      'SELECT id FROM memories WHERE bank = ? AND content_hash = ? AND deleted_at IS NULL LIMIT 1'
    )
    .bind(bank, hash)
    .first();
  const now = nowISO();
  if (dup) {
    await db
      .prepare('UPDATE memories SET updated_at = ? WHERE id = ?')
      .bind(now, dup.id)
      .run();
    return ok({ id: dup.id, deduped: true });
  }

  const id = crypto.randomUUID();
  const ready = await ftsReady(db);
  const stmts = [
    db
      .prepare(
        `INSERT INTO memories(id, content, content_hash, bank, source, kind, tags, expires_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(id, content, hash, bank, source, kind, tags, expires_at, now, now),
    db
      .prepare(
        'INSERT INTO inbox(id, content, bank, source, created_at) VALUES(?,?,?,?,?)'
      )
      .bind(id, content, bank, source, now),
  ];
  if (ready) stmts.push(...indexStmts(db, id, content));
  await db.batch(stmts);
  return ok({ id });
}

async function handleUpdate(db, id, body) {
  const cur = await db
    .prepare(
      'SELECT id, content FROM memories WHERE id = ? AND deleted_at IS NULL'
    )
    .bind(id)
    .first();
  if (!cur) return err('not found', 404);
  const sets = [],
    params = [];
  let content = null;
  try {
    if (body.content !== undefined) {
      content = normalize(body.content);
      if (content.length < 2) return err('content too short');
      if (content.length > 8000) return err('content too long');
      sets.push('content = ?');
      params.push(content);
    }
    if (body.kind !== undefined) {
      if (body.kind && !KINDS.has(body.kind)) return err('bad kind');
      sets.push('kind = ?');
      params.push(body.kind || null);
    }
    if (body.tags !== undefined) {
      sets.push('tags = ?');
      params.push(parseTags(body.tags));
    }
    if (body.expires_at !== undefined) {
      sets.push('expires_at = ?');
      params.push(parseExpiresAt(body.expires_at));
    }
  } catch (e) {
    return err(e.message);
  }
  if (!sets.length) return err('nothing to update');
  const now = nowISO();
  sets.push('updated_at = ?');
  params.push(now);
  if (content !== null) {
    const bankRow = await db
      .prepare('SELECT bank FROM memories WHERE id = ?')
      .bind(id)
      .first();
    sets.push('content_hash = ?');
    params.push(await sha256hex(bankRow.bank + '\n' + content));
  }
  params.push(id);
  const ready = await ftsReady(db);
  const stmts = [
    db
      .prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...params),
  ];
  if (ready && content !== null) stmts.push(...indexStmts(db, id, content));
  await db.batch(stmts);
  return ok({ id });
}

async function handleDelete(db, id) {
  const cur = await db
    .prepare('SELECT id FROM memories WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first();
  if (!cur) return err('not found', 404);
  const ready = await ftsReady(db);
  const stmts = [
    db
      .prepare(
        'UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?'
      )
      .bind(nowISO(), nowISO(), id),
  ];
  if (ready) stmts.push(...unindexStmts(db, id));
  await db.batch(stmts);
  return ok({ id, deleted: true });
}

// VM push: upsert by id (keeps FTS in sync too).
async function handlePush(db, body) {
  const items = Array.isArray(body.items) ? body.items : [];
  const ready = await ftsReady(db);
  const stmts = [];
  let pushed = 0;
  for (const it of items.slice(0, 500)) {
    if (!it || !it.id || !it.content) continue;
    const content = normalize(String(it.content));
    if (content.length < 2 || content.length > 8000) continue;
    const now = nowISO();
    const bank = String(it.bank || 'shared').slice(0, 64);
    const source = String(it.source || 'hindsight').slice(0, 64);
    const created = String(it.created_at || now);
    let tags = null;
    try {
      tags = parseTags(it.tags);
    } catch {
      tags = null;
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO memories(id, content, content_hash, bank, source, kind, tags, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET content=excluded.content, content_hash=excluded.content_hash,
           bank=excluded.bank, updated_at=excluded.updated_at`
        )
        .bind(
          it.id,
          content,
          await sha256hex(bank + '\n' + content),
          bank,
          source,
          it.kind && KINDS.has(it.kind) ? it.kind : null,
          tags,
          created,
          now
        )
    );
    if (ready) stmts.push(...indexStmts(db, String(it.id), content));
    pushed++;
    // D1 caps bound params per query — flush in small batches.
    if (stmts.length >= 40) await db.batch(stmts.splice(0, stmts.length));
  }
  if (stmts.length) await db.batch(stmts);
  return ok({ pushed });
}

async function gcOnce(db, days = 7) {
  const inboxCut = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const memCut = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const r1 = await db
    .prepare('DELETE FROM inbox WHERE claimed = 1 AND created_at < ?')
    .bind(inboxCut)
    .run();
  const gone = await db
    .prepare(
      'SELECT id FROM memories WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 500'
    )
    .bind(memCut)
    .all();
  const ids = (gone.results || []).map(r => r.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const ready = await ftsReady(db);
    const stmts = [
      db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).bind(...ids),
    ];
    if (ready) for (const id of ids) stmts.push(...unindexStmts(db, id));
    await db.batch(stmts);
  }
  return { inbox_purged: r1.meta?.changes ?? 0, memories_purged: ids.length };
}

// Backfill FTS for rows written before the migration (segments in-Worker).
async function handleBackfill(db) {
  const ready = await ftsReady(db);
  if (!ready) return err('fts tables not migrated yet', 503);
  const rows =
    (
      await db
        .prepare(
          `SELECT m.id, m.content FROM memories m LEFT JOIN memories_fts f ON f.id = m.id
     WHERE f.id IS NULL AND m.deleted_at IS NULL LIMIT 200`
        )
        .all()
    ).results || [];
  const stmts = [];
  for (const r of rows) stmts.push(...indexStmts(db, r.id, r.content));
  for (let i = 0; i < stmts.length; i += 40)
    await db.batch(stmts.slice(i, i + 40));
  const rest = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM memories m LEFT JOIN memories_fts f ON f.id = m.id
     WHERE f.id IS NULL AND m.deleted_at IS NULL`
    )
    .first();
  return ok({ indexed: rows.length, remaining: rest?.n ?? 0 });
}

// ---------------------------------------------------------------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/health' && req.method === 'GET') {
      let fts = false;
      try {
        fts = await ftsReady(env.DB);
      } catch {
        /* ignore */
      }
      return ok({ service: 'memory-sync', fts });
    }

    const auth = req.headers.get('Authorization') || '';
    if (!env.SYNC_TOKEN || auth !== `Bearer ${env.SYNC_TOKEN}`) {
      return err('unauthorized', 401);
    }
    const db = env.DB;

    if (path === '/recall' && req.method === 'GET')
      return handleRecall(db, url);
    if (path === '/digest' && req.method === 'GET')
      return handleDigest(db, url);

    if (path === '/retain' && req.method === 'POST') {
      let body;
      try {
        body = await req.json();
      } catch {
        return err('bad json');
      }
      return handleRetain(db, body);
    }

    const memMatch = path.match(/^\/memories\/([A-Za-z0-9_-]+)$/);
    if (memMatch) {
      const id = memMatch[1];
      if (req.method === 'PATCH') {
        let body;
        try {
          body = await req.json();
        } catch {
          return err('bad json');
        }
        return handleUpdate(db, id, body);
      }
      if (req.method === 'DELETE') return handleDelete(db, id);
    }

    if (path === '/sync/push' && req.method === 'POST') {
      let body;
      try {
        body = await req.json();
      } catch {
        return err('bad json');
      }
      return handlePush(db, body);
    }

    if (path === '/sync/pull' && req.method === 'GET') {
      const bank = url.searchParams.get('bank');
      let sql =
        'SELECT id, content, bank, source, created_at FROM inbox WHERE claimed = 0';
      const params = [];
      if (bank) {
        sql += ' AND bank = ?';
        params.push(bank);
      }
      sql += ' ORDER BY created_at ASC LIMIT 100';
      const rows =
        (
          await db
            .prepare(sql)
            .bind(...params)
            .all()
        ).results || [];
      return ok({ items: rows });
    }

    if (path === '/sync/ack' && req.method === 'POST') {
      let body;
      try {
        body = await req.json();
      } catch {
        return err('bad json');
      }
      const ids = Array.isArray(body.ids)
        ? body.ids.filter(x => typeof x === 'string')
        : [];
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        await db
          .prepare(`UPDATE inbox SET claimed = 1 WHERE id IN (${ph})`)
          .bind(...ids)
          .run();
      }
      return ok({ acked: ids.length });
    }

    if (path === '/sync/gc' && req.method === 'POST') {
      let days = 7;
      try {
        const b = await req.json();
        if (b && b.days)
          days = Math.min(Math.max(parseInt(b.days, 10) || 7, 1), 90);
      } catch {
        /* keep default */
      }
      return ok(await gcOnce(db, days));
    }

    if (path === '/admin/backfill_fts' && req.method === 'POST')
      return handleBackfill(db);

    return err('not found', 404);
  },

  // Optional: add `triggers: { crons: ["17 4 * * *"] }` to wrangler.jsonc
  // to run GC daily without any external cron.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(gcOnce(env.DB, 7).catch(() => {}));
  },
};
