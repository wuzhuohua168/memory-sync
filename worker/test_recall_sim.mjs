// Simulates the Worker's recall query-building against real FTS5.
// Extracts the REAL helper functions from worker/src/index.js and runs the
// same SQL the Worker generates, to validate CJK recall behavior.
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';

const src = fs.readFileSync('worker/src/index.js', 'utf8');
function extract(name, type = 'function') {
  const start = type === 'function'
    ? src.indexOf(`function ${name}(`)
    : src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error('not found: ' + name);
  if (type !== 'function') {
    const arrow = src.indexOf('=>', start);
    let p = arrow + 2;
    while (/\s/.test(src[p])) p++;
    if (src[p] !== '{') return src.slice(start, src.indexOf(';', p) + 1); // expression body
  }
  // brace-balanced body
  let p = src.indexOf('{', start);
  let depth = 0;
  for (let i = p; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
// `let _seg` must exist for segment(); indirect eval -> global scope so the
// extracted function declarations are visible to the test code below.
(0, eval)('globalThis._seg = null;\n' + ['segment', 'normalize', 'ftsEscape', 'keepToken']
  .map(n => extract(n, n === 'segment' ? 'function' : 'const')).join('\n')
  + '\n;globalThis.segment=segment;globalThis.normalize=normalize;globalThis.ftsEscape=ftsEscape;globalThis.keepToken=keepToken;');
const { segment, normalize, ftsEscape, keepToken } = globalThis;

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, bank TEXT DEFAULT 'shared',
  source TEXT DEFAULT 'client', kind TEXT, tags TEXT, expires_at TEXT, deleted_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content, tokenize='unicode61')`);
db.exec(`CREATE VIRTUAL TABLE memories_fts_tri USING fts5(id UNINDEXED, content, tokenize='trigram')`);

const docs = [
  ['1', '2026-09-30 用户决定视频号配音用系统TTS，不再尝试Edge语音'],
  ['2', '2026-10-02 用户要求视频素材跨视频不重复，重复处用AI生成'],
  ['3', '2026-10-03 用户不喜欢揭内幕式钩子，反转钩子只能纠正客户认知'],
  ['4', '2026-10-01 Vultr免费VPS申请已放弃，用户没有信用卡'],
  ['5', '2026-10-03 日本小额免税2028年4月1日实施，并非2026年取消'],
  ['6', '2026-09-28 用户开始运营微信视频号做日韩跨境物流获客'],
];
const now = new Date().toISOString();
for (const [id, content] of docs) {
  db.prepare('INSERT INTO memories(id,content,created_at,updated_at) VALUES(?,?,?,?)').run(id, content, now, now);
  db.prepare('INSERT INTO memories_fts(id,content) VALUES(?,?)').run(id, segment(content));
  db.prepare('INSERT INTO memories_fts_tri(id,content) VALUES(?,?)').run(id, content);
}

// Same query building as handleRecall()
function recall(q) {
  const terms = normalize(q).split(' ').filter(Boolean).slice(0, 8).map(t => [...t].slice(0, 20).join(''));
  const vis = `m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > '${now}')`;
  const found = new Map();
  const tokens = segment(q).split(' ').map(ftsEscape).filter(keepToken).slice(0, 12);
  if (tokens.length) {
    const expr = tokens.join(' AND ');
    const rows = db.prepare(
      `SELECT m.id, m.content, bm25(memories_fts) AS r FROM memories_fts f JOIN memories m ON m.id=f.id
       WHERE ${vis} AND f.content MATCH ? ORDER BY r LIMIT 100`).all(expr);
    for (const r of rows) found.set(r.id, (found.get(r.id) || 0) + 10 + 1 / (1 + Math.max(0, r.r)));
  }
  const tri = terms.filter(t => [...t].length >= 3).map(ftsEscape).filter(keepToken);
  if (tri.length) {
    const expr = tri.join(' AND ');
    const rows = db.prepare(
      `SELECT m.id FROM memories_fts_tri f JOIN memories m ON m.id=f.id
       WHERE ${vis} AND f.content MATCH ? LIMIT 100`).all(expr);
    for (const r of rows) found.set(r.id, (found.get(r.id) || 0) + 5);
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const cases = [
  ['备货', []],                    // 2-char: no doc mentions it -> empty is correct
  ['配音', ['1']],
  ['视频素材 重复', ['2']],
  ['揭内幕 钩子', ['3']],
  ['免税', ['5']],
  ['Vultr', ['4']],
  ['视频号', ['1', '6']],          // both mention 视频号
  ['用户决定', ['1']],             // trigram substring
  ['信用卡', ['4']],
];
let fail = 0;
for (const [q, want] of cases) {
  const got = recall(q);
  const pass = want.every(id => got.includes(id)) && (want.length === 0 ? got.length === 0 : true);
  console.log((pass ? 'PASS' : 'FAIL') + ` recall(${JSON.stringify(q)}) -> [${got}] want ⊆ [${want}]`);
  if (!pass) fail++;
}
// segmentation sanity
console.log('segment("2026-10-03 用户不喜欢揭内幕式钩子") =', JSON.stringify(segment('2026-10-03 用户不喜欢揭内幕式钩子')));
process.exit(fail ? 1 : 0);
