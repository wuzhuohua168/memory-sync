# 共享记忆中枢 · 3 分钟快速接入

> 给新客户端（AI 助手）的接入说明，直接转发即可。
> 唯一需要找用户要的东西：**SYNC_TOKEN**（一串 64 位字符）。

---

## 方式一：MCP（推荐，有原生工具）

### 1. 克隆仓库

```bash
git clone https://github.com/wuzhuohua168/memory-sync
cd memory-sync && git pull   # 保持最新，拿上游修复
```

### 2. 存放令牌

把用户给你的 SYNC_TOKEN 原样写入下面这个文件（无换行、无引号）：

| 系统 | 路径 |
|---|---|
| macOS / Linux | `~/.memory-sync-state/sync_token` |
| Windows | `C:\Users\<你的用户名>\.memory-sync-state\sync_token` |

```bash
# macOS / Linux 一行搞定（把引号里的换成真实 token）：
mkdir -p ~/.memory-sync-state && printf '%s' '你的TOKEN' > ~/.memory-sync-state/sync_token
```

校验（期望 `64 True`）：

```bash
python3 -c "
t = open('$HOME/.memory-sync-state/sync_token').read().strip()
print(len(t), t.startswith('cfut_') == False and len(t) == 64)"
```
Windows PowerShell：
```powershell
$tok = [System.IO.File]::ReadAllText("$env:USERPROFILE\.memory-sync-state\sync_token").Trim()
"$($tok.Length) $($tok -match '^[0-9a-f]{64}$')"
```

> ⚠️ 如果是 `53` 位且以 `cfut_` 开头——那是 Cloudflare API token，不是记忆中枢的令牌，找用户重拿。

### 3. 配置 MCP（STDIO 型）

在你的客户端（Cursor / Trae / Claude Code / Windsurf 等）添加 MCP server：

```json
{
  "mcpServers": {
    "memory-sync": {
      "command": "python3",
      "args": ["/path/to/memory-sync/mcp-server/memory_mcp.py"],
      "env": {
        "MEMORY_SYNC_WORKER": "https://memory.shasha.us.ci",
        "MEMORY_SYNC_TOKEN_FILE": "/path/to/.memory-sync-state/sync_token",
        "MEMORY_SYNC_SOURCE": "你的客户端名"
      }
    }
  }
}
```

- `command`：Windows 用 `python` 的完整路径（如 `C:\Python311\python.exe`）
- `args`：改成你本机 `memory_mcp.py` 的实际路径
- `MEMORY_SYNC_SOURCE`：填你自己的名字（如 `cursor`、`trae`、`workbuddy`），写入的记忆会带这个来源标记
- 各客户端的具体入口见 `mcp-server/clients/`（`cursor.mcp.json`、`trae.md`、`claude-code.mcp.json`）

### 4. 验证

连上后调用 `memory_digest`（无参数），返回记忆列表即成功。
然后写一条测试记忆再删掉，确认双向通：`memory_retain` → 换个客户端 `memory_digest` 能读到 → `memory_forget` 清理。

### 使用规则（tool 描述里已内置，再强调一遍）

- **每次新会话/新任务开始，先调 `memory_digest`**，看其他客户端最近存了什么
- 学到用户的事实、偏好、决定、项目进展时，立刻 `memory_retain`，一条一存
- `content` 写完整一句话，带主语和时间（如 "2026-10-05 用户决定……"）
- 不存密码、token、密钥，不存闲聊流水
- `bank` 固定用 `shared`

---

## 方式二：无 MCP（纯 HTTP，备用）

客户端不支持 MCP 时，看 `docs/client-setup.md`，把里面的
`https://<你的 Worker 地址>` 换成 `https://memory.shasha.us.ci`，
`YOUR_SYNC_TOKEN>` 换成用户给你的 token，直接 curl 即可。
之前 WorkBuddy 就是这么接入自检通过的。

---

## 常见坑

| 现象 | 原因 | 解法 |
|---|---|---|
| 403 / error 1010 | Python 默认 UA 被 Cloudflare 边缘拦截 | `git pull` 拿到上游 UA 修复（已在 main） |
| 401 | token 错了或过期 | 找用户重拿 SYNC_TOKEN（64 位 hex） |
| 中文入库乱码 | Windows 命令行按 GBK 传了中文 | 用 MCP 或 Python 按 UTF-8 构造请求体，不要手拼中文 curl |
| 工具列表里没有 5 个 tool | MCP server 没重连 | 在客户端设置里断开重连一次（或重启客户端） |
