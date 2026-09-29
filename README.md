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
| GET | `/health` | Liveness check, no auth |
| GET | `/recall?q=...&k=5&bank=shared` | Keyword search, ranked by hit count + recency |
| POST | `/retain` | `{content, bank?, source?}` → stored, returns `id` |
| POST | `/sync/push` | `{items:[{id,content,bank,source,created_at}]}` — upsert by id |
| GET | `/sync/pull` | Unclaimed inbox entries |
| POST | `/sync/ack` | `{ids:[...]}` — mark inbox entries claimed |

### Security notes

- The token is a single shared secret: rotate it on both the Worker secret and every client if it leaks.
- Request bodies must be UTF-8. On Windows, never pass CJK text through a bare `curl` command line (it gets encoded as GBK and stored as garbage) — build the JSON body explicitly in UTF-8 (e.g. Python).
- There is intentionally no client-side delete/update API. Delete from D1 directly when needed.

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
| GET | `/health` | 存活检查，免鉴权 |
| GET | `/recall?q=关键词&k=5&bank=shared` | 关键词搜索，按命中数 + 时间排序 |
| POST | `/retain` | `{content, bank?, source?}`，写入后返回 `id` |
| POST | `/sync/push` | `{items:[{id,content,bank,source,created_at}]}`，按 id upsert |
| GET | `/sync/pull` | 拉取未领取的 inbox 条目 |
| POST | `/sync/ack` | `{ids:[...]}`，确认已领取 |

### 安全注意事项

- token 是唯一的共享密钥，泄露后要在 Worker secret 和所有客户端同时更换。
- 请求体必须是 UTF-8。Windows 下不要直接在命令行里拼中文 curl（会被按 GBK 编码，入库变乱码）——用 Python 等方式显式按 UTF-8 构造请求体。
- 出于设计，客户端没有删除/修改接口，需要时直接操作 D1 删除。

### 开源协议

MIT，见 [LICENSE](LICENSE)。
