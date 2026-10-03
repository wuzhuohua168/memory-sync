# memory-sync

[English](#english) | [中文](#中文)

---

<a id="english"></a>
## English

**memory-sync** is a tiny shared-memory hub for your AI clients. One Cloudflare Worker + D1 database acts as the single source of truth; every client (Trae, Cursor, Claude Code, …) reads and writes through a small HTTP API, so something you tell one assistant is instantly visible to the others.

An optional sync script mirrors the shared bank with a local [Hindsight](https://github.com/hindsight) long-term memory instance every 5 minutes.

### Architecture

```
 Trae ──┐
        │   HTTPS + Bearer token (real-time)
Cursor ─┼──▶ Cloudflare Worker ──▶ D1 (memories + inbox)
        │                              ↕ 5-min two-way sync (optional)
Claude ─┘                         Hindsight (local, 127.0.0.1:8888)
```

### Quickstart

**1. Create the D1 database**

```bash
npm i -g wrangler
wrangler login
wrangler d1 create memory_sync   # note the returned database_id
```

**2. Configure**

Edit `worker/wrangler.jsonc`: fill in `account_id` and `database_id`.

**3. Apply schema & deploy**

```bash
cd worker
wrangler d1 execute memory_sync --file schema.sql --remote
openssl rand -hex 32   # generate SYNC_TOKEN, keep it safe
wrangler secret put SYNC_TOKEN
wrangler deploy
```

Your Worker is now live at `https://memory-sync.<your-subdomain>.workers.dev`
(optionally bind a custom domain in the Cloudflare dashboard).

**4. Point clients at it**

Give each client `docs/client-setup.md` with your Worker URL and token.

**5. (Optional) Hindsight sync**

```bash
export MEMORY_SYNC_WORKER=https://memory-sync.<your-subdomain>.workers.dev
export MEMORY_SYNC_TOKEN=<your token>
python3 sync/sync.py   # run every 5 min via cron/systemd
```

### API

All endpoints except `GET /health` require `Authorization: Bearer <SYNC_TOKEN>`.

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness check, no auth (also reports `fts` status) |
| GET | `/digest?since=...&k=20&bank=shared` | **Timeline: recent memories, newest first. Call at session start.** Defaults to last 24h |
| GET | `/recall?q=...&k=5&bank=shared&kind=` | Hybrid search: segmented FTS5 (BM25) + trigram substring + LIKE fallback; CJK supported |
| POST | `/retain` | `{content, bank?, source?, kind?, tags?, expires_at?}` → stored, returns `id` (dedupes identical content) |
| PATCH | `/memories/<id>` | Update `{content?, kind?, tags?, expires_at?}` |
| DELETE | `/memories/<id>` | Soft-delete a memory |
| POST | `/sync/push` | `{items:[{id,content,bank,source,created_at}]}` — upsert by id |
| GET | `/sync/pull?bank=` | Unclaimed inbox entries |
| POST | `/sync/ack` | `{ids:[...]}` — mark inbox entries claimed |
| POST | `/sync/gc` | `{days?}` — purge claimed inbox rows older than N days + hard-delete soft-deleted memories older than 30d |
| POST | `/admin/backfill_fts` | Index pre-migration rows into FTS (repeat until `remaining` is 0) |

### MCP server (recommended client access)

`mcp-server/memory_mcp.py` is a stdio MCP server (stdlib only, no dependencies)
exposing five tools: `memory_digest`, `memory_recall`, `memory_retain`,
`memory_update`, `memory_forget`. Point Cursor / Trae / Claude Code at it —
see `mcp-server/clients/` for config examples. The tool descriptions tell the
agent to call `memory_digest` first at session start, which fixes the
"clients don't know what the others know" problem far better than a prompt doc.

### Upgrading an existing deployment

```bash
cd worker
wrangler d1 execute memory_sync --file migrations/0002_p0.sql --remote
wrangler deploy
# backfill FTS for rows written before the migration (repeat until remaining=0):
curl -s -X POST https://<your-worker>/admin/backfill_fts -H "Authorization: Bearer $SYNC_TOKEN"
```

Optional: add `"triggers": { "crons": ["17 4 * * *"] }` to `wrangler.jsonc`
to run inbox GC daily without an external cron.

### Security notes

- The token is a single shared secret: rotate it on both the Worker secret and every client if it leaks.
- Request bodies must be UTF-8. On Windows, never pass CJK text through a bare `curl` command line (it gets encoded as GBK and stored as garbage) — build the JSON body explicitly in UTF-8 (e.g. Python).
- `source` is self-reported by clients today; per-client tokens (server-derived identity) are the planned P1 hardening. Don't store passwords, API keys, or other secrets as memories.

### License

MIT — see [LICENSE](LICENSE).

---

<a id="中文"></a>
## 中文

**memory-sync** 是一个极简的 AI 共享记忆中枢。一个 Cloudflare Worker + D1 数据库作为唯一数据源，所有 AI 客户端（Trae、Cursor、Claude Code……）通过 HTTP API 读写——你跟其中一个 AI 说的事，其他 AI 立刻都知道。

可选配一个同步脚本，每 5 分钟把共享区与本地 [Hindsight](https://github.com/hindsight) 长期记忆双向同步。

### 架构

```
 Trae ──┐
        │   HTTPS + Bearer token（实时）
Cursor ─┼──▶ Cloudflare Worker ──▶ D1（memories + inbox 表）
        │                              ↕ 每 5 分钟双向同步（可选）
Claude ─┘                         Hindsight（本地 127.0.0.1:8888）
```

### 快速开始

**1. 建 D1 数据库**

```bash
npm i -g wrangler
wrangler login
wrangler d1 create memory_sync   # 记下返回的 database_id
```

**2. 填配置**

编辑 `worker/wrangler.jsonc`，填入 `account_id` 和 `database_id`。

**3. 建表、设密钥、部署**

```bash
cd worker
wrangler d1 execute memory_sync --file schema.sql --remote
openssl rand -hex 32   # 生成 SYNC_TOKEN，妥善保管
wrangler secret put SYNC_TOKEN
wrangler deploy
```

部署后地址为 `https://memory-sync.<你的子域名>.workers.dev`（也可在 Cloudflare 后台绑定自己的域名）。

**4. 接入客户端**

把你的 Worker 地址和 token 填进 `docs/client-setup.md`，转交给每个客户端即可。

**5.（可选）Hindsight 同步**

```bash
export MEMORY_SYNC_WORKER=https://memory-sync.<你的子域名>.workers.dev
export MEMORY_SYNC_TOKEN=<你的 token>
python3 sync/sync.py   # 用 cron/systemd 每 5 分钟跑一次
```

### 接口

除 `GET /health` 外，所有接口都需要在 Header 带 `Authorization: Bearer <SYNC_TOKEN>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活检查，免鉴权（附带 `fts` 状态） |
| GET | `/digest?since=...&k=20&bank=shared` | **时间线：最新记忆倒序，会话开始先调**，默认最近 24 小时 |
| GET | `/recall?q=关键词&k=5&bank=shared&kind=` | 混合检索：分词 FTS5（BM25）+ trigram 子串 + LIKE 兜底，支持中文 |
| POST | `/retain` | `{content, bank?, source?, kind?, tags?, expires_at?}`，写入后返回 `id`（相同内容自动去重） |
| PATCH | `/memories/<id>` | 修改 `{content?, kind?, tags?, expires_at?}` |
| DELETE | `/memories/<id>` | 软删除一条记忆 |
| POST | `/sync/push` | `{items:[{id,content,bank,source,created_at}]}`，按 id upsert |
| GET | `/sync/pull?bank=` | 拉取未领取的 inbox 条目 |
| POST | `/sync/ack` | `{ids:[...]}`，确认已领取 |
| POST | `/sync/gc` | `{days?}`，清理已领取 N 天前的 inbox + 硬删除软删除 30 天以上的记忆 |
| POST | `/admin/backfill_fts` | 给迁移前写入的老数据建 FTS 索引（重复调用直到 `remaining` 为 0） |

### MCP server（推荐的客户端接入方式）

`mcp-server/memory_mcp.py` 是一个 stdio MCP server（纯标准库、零依赖），
提供 5 个 tool：`memory_digest`、`memory_recall`、`memory_retain`、
`memory_update`、`memory_forget`。Cursor / Trae / Claude Code 直接指向它即可，
配置示例见 `mcp-server/clients/`。tool 描述里写死了"会话开始先调 memory_digest"，
比靠提示词文档更能解决"各客户端互相不知道"的问题。

### 老版本升级

```bash
cd worker
wrangler d1 execute memory_sync --file migrations/0002_p0.sql --remote
wrangler deploy
# 给老数据建 FTS 索引（重复调用直到 remaining=0）：
curl -s -X POST https://<你的Worker地址>/admin/backfill_fts -H "Authorization: Bearer $SYNC_TOKEN"
```

可选：在 `wrangler.jsonc` 加 `"triggers": { "crons": ["17 4 * * *"] }`，
让 Worker 每天自动跑 inbox GC，不用外部 cron。

### 安全注意事项

- token 是唯一的共享密钥，泄露后要在 Worker secret 和所有客户端同时更换。
- 请求体必须是 UTF-8。Windows 下不要直接在命令行里拼中文 curl（会被按 GBK 编码，入库变乱码）——用 Python 等方式显式按 UTF-8 构造请求体。
- `source` 目前是客户端自报的；按客户端发独立 token（服务端派生身份）是计划中的 P1 加固。不要把密码、API key 等密钥存成记忆。

### 开源协议

MIT，见 [LICENSE](LICENSE)。
