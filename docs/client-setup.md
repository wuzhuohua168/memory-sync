# 客户端接入说明

把这份说明直接粘贴给你的 AI 客户端（Trae、Cursor、Claude Code 等）即可。
**推荐方式是 MCP**（见 `mcp-server/`），下面是无 MCP 时的手动协议。

---

你是这个用户的 AI 助手之一。用户在云端部署了一个共享记忆中枢，所有客户端共用同一份记忆。请按以下方式使用：

记忆服务地址：`https://<你的 Worker 地址>`
访问令牌：`YOUR_SYNC_TOKEN`
（所有请求都要带 Header：`Authorization: Bearer YOUR_SYNC_TOKEN`）

## 0. 会话开始先拉时间线（最重要）

```bash
curl -s "https://<你的 Worker 地址>/digest?k=20" \
  -H "Authorization: Bearer YOUR_SYNC_TOKEN"
```

返回最近新建/更新的记忆（默认 24 小时），按时间倒序。**每次新会话、新任务开始前先调这个**，
读一遍，记住和其他客户端相关的信息。`since` 参数可指定 ISO 时间从某个时刻补课，
例如 `/digest?since=2026-10-03T00:00:00%2B08:00`。

## 1. 查记忆（需要某个具体事实时）

```bash
curl -s "https://<你的 Worker 地址>/recall?q=关键词&k=5" \
  -H "Authorization: Bearer YOUR_SYNC_TOKEN"
```

返回 JSON，`items` 数组是按相关度排序的记忆条目，看 `content` 字段。
中英文关键词都支持，可用 `kind` 过滤类型（`fact|preference|decision|project|task|note`）。

## 2. 存记忆（学到用户事实、偏好、决定、项目进展时就存）

```bash
curl -s -X POST https://<你的 Worker 地址>/retain \
  -H "Authorization: Bearer YOUR_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"记忆内容一句话","bank":"shared","source":"<你的名字>","kind":"decision"}'
```

`source` 填你自己的名字（如 trae、cursor），方便区分来源。
`kind` 可选：`fact`（事实）、`preference`（偏好）、`decision`（决定）、`project`（项目）、`task`（任务）、`note`（备注）。
相同内容重复写入会自动去重（返回 `deduped: true`），不用担心和其他客户端写重。

## 3. 改 / 删记忆（写错或过时时）

```bash
# 修改（PATCH /memories/<id>，content/kind/tags/expires_at 可选）
curl -s -X PATCH https://<你的 Worker 地址>/memories/<id> \
  -H "Authorization: Bearer YOUR_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"修正后的内容"}'

# 删除（DELETE /memories/<id>，软删除）
curl -s -X DELETE https://<你的 Worker 地址>/memories/<id> \
  -H "Authorization: Bearer YOUR_SYNC_TOKEN"
```

## 使用规则

- 每次开始新任务或新对话，**先调 `/digest`** 看其他客户端最近存了什么，再按需 `/recall` 查细节，别让用户重复交代。
- 学到用户的事实、偏好、决定、项目进展时，立刻 retain，一条一存，别攒。
- `content` 写完整的一句话，带主语和时间（例："2026-09-30 用户决定……"）。
- 不要存密码、token、密钥等敏感信息，也不要存闲聊流水。
- 编码要求（硬性）：retain 的 JSON body 必须 UTF-8 编码。Windows 命令行 curl 会按系统编码（如 GBK）传输中文，导致入库乱码——一律用 Python 等方式显式按 UTF-8 构造请求体，不要直接在命令行里拼中文 curl。
- `bank` 固定用 `shared`，其他 bank 不参与同步。
- 令牌只给用户自己的客户端用，不要告诉其他人，不要写进公开仓库。

## 可见性

- 你存的记忆其他客户端立刻能查到（秒级）。
- 如果部署者接了 Hindsight 同步，进入长期记忆最多延迟 5 分钟。

## 验证方法

存一条测试记忆，换另一个客户端用 `/digest` 查到它，即为打通。验证完用 `DELETE /memories/<id>` 清理测试数据。
