#!/usr/bin/env python3
"""Drive mcp-server/memory_mcp.py through the full MCP protocol against a stub Worker."""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

CALLS = []

class Stub(BaseHTTPRequestHandler):
    def _ok(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        CALLS.append({
            "method": self.command, "path": self.path,
            "auth": self.headers.get("Authorization"),
            "body": json.loads(raw) if raw else None,
        })
        assert self.headers.get("Authorization") == "Bearer test-token", "bad auth"
        if self.path.startswith("/digest"):
            self._ok({"ok": True, "items": [{"id": "1", "content": "stub memory"}], "since": "x"})
        elif self.path.startswith("/recall"):
            self._ok({"ok": True, "items": []})
        elif self.path.startswith("/retain"):
            self._ok({"ok": True, "id": "abc"})
        elif self.path.startswith("/memories/"):
            self._ok({"ok": True, "id": "abc"})
        else:
            self._ok({"ok": False, "error": "nope"})

    do_GET = do_POST = do_PATCH = do_DELETE = _handle
    def log_message(self, *a):
        pass

srv = HTTPServer(("127.0.0.1", 0), Stub)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

env = dict(os.environ,
           MEMORY_SYNC_WORKER=f"http://127.0.0.1:{port}",
           MEMORY_SYNC_TOKEN="test-token",
           MEMORY_SYNC_TOKEN_FILE="/nonexistent",
           MEMORY_SYNC_SOURCE="pytest")
proc = subprocess.Popen([sys.executable, "mcp-server/memory_mcp.py"],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        text=True, cwd=".", env=env)

def rpc(method, params=None, mid=1, notify=False):
    msg = {"jsonrpc": "2.0", "method": method}
    if not notify:
        msg["id"] = mid
    if params is not None:
        msg["params"] = params
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    if notify:
        return None
    return json.loads(proc.stdout.readline())

fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, extra)
    if not cond:
        fails.append(name)

r = rpc("initialize", {"protocolVersion": "2024-11-05"}, mid=1)
check("initialize", r["result"]["serverInfo"]["name"] == "memory-sync")
rpc("notifications/initialized", notify=True)
r = rpc("tools/list", mid=2)
names = [t["name"] for t in r["result"]["tools"]]
check("tools/list has 5 tools", names == ["memory_digest", "memory_recall", "memory_retain", "memory_update", "memory_forget"], str(names))
check("digest description mentions FIRST", "FIRST" in r["result"]["tools"][0]["description"])

r = rpc("tools/call", {"name": "memory_digest", "arguments": {}}, mid=3)
check("digest call ok", '"stub memory"' in r["result"]["content"][0]["text"])
check("digest hit worker", CALLS[-1]["path"].startswith("/digest") and CALLS[-1]["method"] == "GET", CALLS[-1]["path"])

r = rpc("tools/call", {"name": "memory_recall", "arguments": {"query": "视频号 配音", "kind": "preference"}}, mid=4)
check("recall query encoded", "q=" in CALLS[-1]["path"] and "kind=preference" in CALLS[-1]["path"], CALLS[-1]["path"])

r = rpc("tools/call", {"name": "memory_retain",
                       "arguments": {"content": "2026-10-04 用户决定X", "kind": "decision", "tags": ["a"]}}, mid=5)
b = CALLS[-1]["body"]
check("retain body", b["content"] == "2026-10-04 用户决定X" and b["source"] == "pytest"
      and b["kind"] == "decision" and b["tags"] == ["a"] and b["bank"] == "shared", str(b))
check("retain utf-8", "用户决定" in json.dumps(b, ensure_ascii=False))

r = rpc("tools/call", {"name": "memory_update", "arguments": {"id": "abc", "content": "new"}}, mid=6)
check("update PATCH", CALLS[-1]["method"] == "PATCH" and CALLS[-1]["path"] == "/memories/abc", CALLS[-1]["path"])

r = rpc("tools/call", {"name": "memory_forget", "arguments": {"id": "abc"}}, mid=7)
check("forget DELETE", CALLS[-1]["method"] == "DELETE" and CALLS[-1]["path"] == "/memories/abc")

r = rpc("tools/call", {"name": "nope", "arguments": {}}, mid=8)
check("unknown tool isError", r["result"].get("isError") is True)

r = rpc("bogus/method", mid=9)
check("unknown method -32601", r["error"]["code"] == -32601)

proc.stdin.close()
proc.wait(timeout=5)
srv.shutdown()
print("CALLS:", len(CALLS))
sys.exit(1 if fails else 0)
