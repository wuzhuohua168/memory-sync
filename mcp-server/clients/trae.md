# Trae 接入说明

Trae 支持 MCP（Settings → MCP → Add，选 STDIO 类型），填：

- **Command**: `python3`（Windows 用 `python` 的完整路径）
- **Args**: `["C:\\path\\to\\memory-sync\\mcp-server\\memory_mcp.py"]`
- **Env**:
  - `MEMORY_SYNC_WORKER=https://memory-sync.<你的子域名>.workers.dev`
  - `MEMORY_SYNC_TOKEN_FILE=C:\\path\\to\\.memory-sync-state\\sync_token`
    （或 `MEMORY_SYNC_TOKEN=<你的 token>`，注意 Windows 下不要把 token 写进会同步的配置文件）
  - `MEMORY_SYNC_SOURCE=trae`

连上后 Trae 的 agent 会自动看到 5 个 tool：

| tool | 用途 |
|---|---|
| `memory_digest` | **每次会话开始先调**，看其他客户端最近存了什么 |
| `memory_recall` | 按关键词查记忆 |
| `memory_retain` | 存记忆（一条一存，带主语和时间） |
| `memory_update` | 改写错的记忆 |
| `memory_forget` | 删除记忆 |

建议在 Trae 的自定义指令 / 项目规则里加一句：
"每次开始任务前先调用 memory_digest，有相关需求再 memory_recall；学到用户事实/偏好/决定时立即 memory_retain。"
