# 客户端接入说明

把这份说明直接粘贴给你的 AI 客户端（Trae、Cursor、Claude Code 等）即可。

---

你是这个用户的 AI 助手之一。用户在云端部署了一个共享记忆中枢，所有客户端共用同一份记忆。请按以下方式使用：

记忆服务地址：`https://<你的 Worker 地址>`
访问令牌：`YOUR_SYNC_TOKEN`
（所有请求都要带 Header：`Authorization: Bearer YOUR_SYNC_TOKEN`）

## 1. 查记忆（开始任务前先查）

```bash
curl -s "https://<你的 Worker 地址>/recall?q=关键词&k=5" \
  -H "Authorization: Bearer YOUR_SYNC_TOKEN"
```

返回 JSON，`items` 数组是按相关度排序的记忆条目，看 `content` 字段。

## 2. 存记忆（学到用户事实、偏好、决定、项目进展时就存）

```bash
curl -s -X POST https://<你的 Worker 地址>/retain \
  -H "Authorization: Bearer YOUR_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"记忆内容一句话","bank":"shared","source":"<你的名字>"}'
```

`source` 填你自己的名字（如 trae、cursor），方便区分来源。

## 使用规则

- 每次开始新任务或新对话，先用 recall 查相关记忆，别让用户重复交代。
- 学到用户的事实、偏好、决定、项目进展时，立刻 retain，一条一存，别攒。
- `content` 写完整的一句话，带主语和时间（例："2026-09-30 用户决定……"）。
- 编码要求（硬性）：retain 的 JSON body 必须 UTF-8 编码。Windows 命令行 curl 会按系统编码（如 GBK）传输中文，导致入库乱码——一律用 Python 等方式显式按 UTF-8 构造请求体，不要直接在命令行里拼中文 curl。
- `bank` 固定用 `shared`，其他 bank 不参与同步。
- 令牌只给用户自己的客户端用，不要告诉其他人，不要写进公开仓库。
- 客户端只有"存"和"查"接口，没有修改/删除接口。写错了联系部署者从数据库删除。

## 可见性

- 你存的记忆其他客户端立刻能查到（秒级）。
- 如果部署者接了 Hindsight 同步，进入长期记忆最多延迟 5 分钟。

## 验证方法

存一条测试记忆，换另一个客户端用 recall 查到它，即为打通。验证完记得让部署者清理测试数据。
