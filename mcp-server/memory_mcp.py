#!/usr/bin/env python3
"""memory-sync MCP server (stdio).

Exposes the shared memory hub as native MCP tools so AI clients
(Cursor, Trae, Claude Code, ...) call it directly instead of hand-rolled
curl + prompt conventions.

Stdlib only — no third-party dependencies.

Configuration (environment variables, same names as sync/sync.py):
  MEMORY_SYNC_WORKER      Worker base URL, e.g. https://memory-sync.<you>.workers.dev (required)
  MEMORY_SYNC_TOKEN       Bearer token (required unless MEMORY_SYNC_TOKEN_FILE is set)
  MEMORY_SYNC_TOKEN_FILE  File to read the token from (takes precedence)
  MEMORY_SYNC_SOURCE      `source` label for memories written via MCP (default: mcp)
  MEMORY_SYNC_BANK        Default bank (default: shared)

Client config examples live in mcp-server/clients/.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

WORKER = os.environ.get("MEMORY_SYNC_WORKER", "").rstrip("/")
STATE_DIR = os.path.expanduser(os.environ.get("MEMORY_SYNC_STATE_DIR", "~/.memory-sync-state"))
TOKEN_FILE = os.environ.get("MEMORY_SYNC_TOKEN_FILE", os.path.join(STATE_DIR, "sync_token"))
SOURCE = os.environ.get("MEMORY_SYNC_SOURCE", "mcp")
DEFAULT_BANK = os.environ.get("MEMORY_SYNC_BANK", "shared")


def get_token():
    if os.path.isfile(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    tok = os.environ.get("MEMORY_SYNC_TOKEN", "").strip()
    if tok:
        return tok
    raise SystemExit("memory-sync MCP: no token (MEMORY_SYNC_TOKEN / MEMORY_SYNC_TOKEN_FILE)")


TOKEN = get_token()
if not WORKER:
    raise SystemExit("memory-sync MCP: MEMORY_SYNC_WORKER is not set")


def wreq(method, path, data=None, params=None):
    url = WORKER + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None
    req = urllib.request.Request(
        url, data=body, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error", "worker error"))
    return payload


TOOLS = [
    {
        "name": "memory_digest",
        "description": (
            "FIRST tool to call at the start of every session or new conversation, before doing any "
            "work. Returns the most recently created/updated shared memories across all AI clients, "
            "newest first — this is how you learn what the user told other assistants since your last "
            "session. Call it with no arguments for the last 24h, or pass `since` (ISO date) to catch "
            "up from a specific time. Read the returned items and keep the relevant ones in mind."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "since": {"type": "string", "description": "ISO 8601 date; only memories updated after this are returned. Omit for last 24h."},
                "limit": {"type": "integer", "description": "Max items (1-50, default 20)."},
                "bank": {"type": "string", "description": "Memory bank (default: shared)."},
            },
        },
    },
    {
        "name": "memory_recall",
        "description": (
            "Search shared memories by keywords (Chinese and English supported). Use this when you "
            "need a specific fact, preference, decision, or project detail the user may have told any "
            "assistant before — e.g. before starting a task, or when the user references something "
            "from the past. Results are ranked by relevance."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Keywords, e.g. '视频号 配音' or 'Vultr 信用卡'."},
                "limit": {"type": "integer", "description": "Max items (1-20, default 5)."},
                "bank": {"type": "string", "description": "Memory bank (default: shared)."},
                "kind": {"type": "string", "enum": ["fact", "preference", "decision", "project", "task", "note"],
                         "description": "Optional filter by memory kind."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "memory_retain",
        "description": (
            "Save a memory to the shared hub so all AI clients can see it. Call this IMMEDIATELY "
            "when you learn a durable fact about the user: preferences, decisions, project status, "
            "commitments, corrections to your behavior. One fact per call, one complete sentence with "
            "subject and date (e.g. '2026-10-04 用户决定视频素材不重复使用'). Do NOT save secrets, "
            "passwords, tokens, or transient chatter. Duplicate content is deduplicated automatically."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "One complete sentence, with subject and date."},
                "kind": {"type": "string", "enum": ["fact", "preference", "decision", "project", "task", "note"],
                        "description": "What kind of memory this is."},
                "tags": {"type": "array", "items": {"type": "string"},
                        "description": "Up to 10 short tags, e.g. ['视频号','配音']."},
                "expires_at": {"type": "string", "description": "Optional ISO date after which the memory is hidden."},
                "bank": {"type": "string", "description": "Memory bank (default: shared)."},
            },
            "required": ["content"],
        },
    },
    {
        "name": "memory_update",
        "description": "Update a memory you previously saved (fix a mistake or refresh it). Prefer this over saving a duplicate.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Memory id from memory_digest / memory_recall."},
                "content": {"type": "string"},
                "kind": {"type": "string", "enum": ["fact", "preference", "decision", "project", "task", "note"]},
                "tags": {"type": "array", "items": {"type": "string"}},
                "expires_at": {"type": "string"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "memory_forget",
        "description": "Delete a memory (wrong, outdated, or the user asked to remove it).",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "Memory id."}},
            "required": ["id"],
        },
    },
]


def tool_text(obj):
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, indent=2)}]}


def call_tool(name, args):
    args = args or {}
    if name == "memory_digest":
        params = {"k": args.get("limit", 20), "bank": args.get("bank") or DEFAULT_BANK}
        if args.get("since"):
            params["since"] = args["since"]
        return tool_text(wreq("GET", "/digest", params=params))
    if name == "memory_recall":
        params = {"q": args["query"], "k": args.get("limit", 5), "bank": args.get("bank") or DEFAULT_BANK}
        if args.get("kind"):
            params["kind"] = args["kind"]
        return tool_text(wreq("GET", "/recall", params=params))
    if name == "memory_retain":
        return tool_text(wreq("POST", "/retain", {
            "content": args["content"],
            "bank": args.get("bank") or DEFAULT_BANK,
            "source": SOURCE,
            "kind": args.get("kind"),
            "tags": args.get("tags"),
            "expires_at": args.get("expires_at"),
        }))
    if name == "memory_update":
        body = {}
        for f in ("content", "kind", "tags", "expires_at"):
            if args.get(f) is not None:
                body[f] = args[f]
        return tool_text(wreq("PATCH", f"/memories/{args['id']}", body))
    if name == "memory_forget":
        return tool_text(wreq("DELETE", f"/memories/{args['id']}"))
    raise ValueError(f"unknown tool: {name}")


def reply(mid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": mid}
    if error is not None:
        code, message = error
        msg["error"] = {"code": code, "message": str(message)}
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        mid = msg.get("id")
        method = msg.get("method", "")
        params = msg.get("params", {}) or {}

        # Notifications have no id -> no response.
        if method == "notifications/initialized":
            continue
        if method == "initialize":
            reply(mid, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "memory-sync", "version": "0.2.0"},
            })
        elif method == "ping":
            reply(mid, {})
        elif method == "tools/list":
            reply(mid, {"tools": TOOLS})
        elif method == "tools/call":
            try:
                result = call_tool(params.get("name"), params.get("arguments"))
                reply(mid, result)
            except Exception as e:  # noqa: BLE001 - surfaced to the MCP client
                reply(mid, {"content": [{"type": "text", "text": f"error: {e}"}], "isError": True})
        else:
            if mid is not None:
                reply(mid, error=(-32601, f"method not found: {method}"))


if __name__ == "__main__":
    main()
