const JH = { 'Content-Type': 'application/json' };
const ok = (data) => new Response(JSON.stringify({ ok: true, ...data }), { headers: JH });
const err = (msg, status = 400) => new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: JH });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/health' && req.method === 'GET') {
      return ok({ service: 'memory-sync' });
    }

    const auth = req.headers.get('Authorization') || '';
    if (!env.SYNC_TOKEN || auth !== `Bearer ${env.SYNC_TOKEN}`) {
      return err('unauthorized', 401);
    }

    // 客户端查记忆：GET /recall?q=关键词&k=5&bank=shared
    if (path === '/recall' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const k = Math.min(Math.max(parseInt(url.searchParams.get('k') || '5', 10) || 5, 1), 20);
      const bank = url.searchParams.get('bank');
      if (!q) return err('missing q');
      const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
      const likes = terms.map(() => `content LIKE ?`).join(' OR ');
      const params = terms.map((t) => `%${t}%`);
      let sql = `SELECT id, content, bank, source, created_at FROM memories WHERE (${likes})`;
      if (bank) { sql += ` AND bank = ?`; params.push(bank); }
      sql += ` ORDER BY created_at DESC LIMIT 200`;
      const rows = (await env.DB.prepare(sql).bind(...params).all()).results || [];
      // 简单打分：命中词数多、时间新的排前面
      const scored = rows.map((r) => {
        let hits = 0;
        for (const t of terms) if (r.content.includes(t)) hits++;
        return { ...r, _hits: hits };
      }).sort((a, b) => b._hits - a._hits || (a.created_at < b.created_at ? 1 : -1));
      return ok({ items: scored.slice(0, k).map(({ _hits, ...r }) => r) });
    }

    // 客户端存记忆：POST /retain {content, bank?, source?}
    if (path === '/retain' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return err('bad json'); }
      const content = (body.content || '').trim();
      if (!content) return err('missing content');
      const bank = (body.bank || 'shared').slice(0, 64);
      const source = (body.source || 'client').slice(0, 64);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO memories(id, content, bank, source, created_at, updated_at) VALUES(?,?,?,?,?,?)'
        ).bind(id, content, bank, source, now, now),
        env.DB.prepare(
          'INSERT INTO inbox(id, content, bank, source, created_at) VALUES(?,?,?,?,?)'
        ).bind(id, content, bank, source, now),
      ]);
      return ok({ id });
    }

    // VM 推：POST /sync/push {items:[{id, content, bank, source, created_at}]}
    if (path === '/sync/push' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return err('bad json'); }
      const items = Array.isArray(body.items) ? body.items : [];
      const stmts = [];
      for (const it of items.slice(0, 500)) {
        if (!it || !it.id || !it.content) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO memories(id, content, bank, source, created_at, updated_at)
             VALUES(?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`
          ).bind(it.id, String(it.content), String(it.bank || 'shared').slice(0, 64),
            String(it.source || 'hindsight').slice(0, 64),
            String(it.created_at || new Date().toISOString()),
            String(it.created_at || new Date().toISOString()))
        );
      }
      if (stmts.length) await env.DB.batch(stmts);
      return ok({ pushed: stmts.length });
    }

    // VM 拉：GET /sync/pull
    if (path === '/sync/pull' && req.method === 'GET') {
      const rows = (await env.DB.prepare(
        'SELECT id, content, bank, source, created_at FROM inbox WHERE claimed = 0 ORDER BY created_at ASC LIMIT 100'
      ).all()).results || [];
      return ok({ items: rows });
    }

    // VM 确认：POST /sync/ack {ids:[...]}
    if (path === '/sync/ack' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return err('bad json'); }
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE inbox SET claimed = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
      }
      return ok({ acked: ids.length });
    }

    return err('not found', 404);
  },
};
