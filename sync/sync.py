#!/usr/bin/env python3
"""Two-way sync: Hindsight `shared` bank <-> memory-sync Worker.

Pull: Worker's /sync/pull inbox entries -> retain into Hindsight shared bank
      (document_id = inbox id, update_mode=replace) -> /sync/ack
Push: Hindsight shared bank documents newer than the watermark -> chunks joined
      into text -> Worker /sync/push (upsert by id)

Configuration (environment variables):
  MEMORY_SYNC_WORKER   Worker base URL, e.g. https://memory-sync.<you>.workers.dev (required)
  MEMORY_SYNC_TOKEN    Bearer token, must match the Worker's SYNC_TOKEN secret (required)
  MEMORY_SYNC_TOKEN_FILE  Optional file to read the token from (takes precedence over env)
  HINDSIGHT_URL        Hindsight base URL (default: http://127.0.0.1:8888)
  MEMORY_SYNC_BANK     Bank name to sync (default: shared)
  MEMORY_SYNC_STATE_DIR State dir for token file + watermark (default: ~/.memory-sync-state)

Run every 5 minutes via cron/systemd. Stdlib only, no third-party dependencies.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

STATE_DIR = os.path.expanduser(os.environ.get("MEMORY_SYNC_STATE_DIR", "~/.memory-sync-state"))
TOKEN_FILE = os.environ.get("MEMORY_SYNC_TOKEN_FILE", os.path.join(STATE_DIR, "sync_token"))
WM_FILE = os.path.join(STATE_DIR, "watermark.json")
WORKER = os.environ.get("MEMORY_SYNC_WORKER", "").rstrip("/")
HS = os.environ.get("HINDSIGHT_URL", "http://127.0.0.1:8888").rstrip("/")
BANK = os.environ.get("MEMORY_SYNC_BANK", "shared")


def get_token():
    if os.path.isfile(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    tok = os.environ.get("MEMORY_SYNC_TOKEN", "").strip()
    if tok:
        return tok
    raise SystemExit("No token: set MEMORY_SYNC_TOKEN or MEMORY_SYNC_TOKEN_FILE")


def _urlopen_with_retry(req, timeout):
    import time
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


def wreq(method, path, data=None, params=None):
    if not WORKER:
        raise SystemExit("MEMORY_SYNC_WORKER is not set")
    token = get_token()
    url = WORKER + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        url, data=body, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "User-Agent": "Mozilla/5.0 (memory-sync daemon)"},
    )
    return json.loads(_urlopen_with_retry(req, 30))


def hreq(method, path, data=None, params=None):
    url = HS + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        url, data=body, method=method,
        headers={"Content-Type": "application/json"},
    )
    return json.loads(_urlopen_with_retry(req, 60))


def load_wm():
    try:
        return json.load(open(WM_FILE)).get("updated_after")
    except Exception:
        return None


def save_wm(v):
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump({"updated_after": v}, open(WM_FILE, "w"))


def pull():
    """Worker inbox -> Hindsight shared bank"""
    items = wreq("GET", "/sync/pull").get("items", [])
    acked = []
    for it in items:
        try:
            hreq("POST", f"/v1/default/banks/{BANK}/memories", {
                "items": [{
                    "content": it["content"],
                    "document_id": it["id"],
                    "update_mode": "replace",
                    "context": f"sync:{it.get('source', 'client')}",
                }],
                "async": False,
            })
            acked.append(it["id"])
        except Exception as e:
            print(f"pull retain failed {it['id']}: {e}", file=sys.stderr)
    if acked:
        wreq("POST", "/sync/ack", {"ids": acked})
    return len(acked), len(items)


def push():
    """Hindsight shared bank -> Worker"""
    wm = load_wm()
    params = {"limit": 100, "time_field": "updated_at"}
    if wm:
        params["start_date"] = wm
    docs = hreq("GET", f"/v1/default/banks/{BANK}/documents", params=params).get("items", [])
    items = []
    max_ts = wm
    for d in docs:
        ts = d.get("updated_at") or d.get("created_at")
        try:
            chunks = hreq(
                "GET", f"/v1/default/banks/{BANK}/documents/{d['id']}/chunks",
                params={"limit": 200},
            ).get("items", [])
        except Exception as e:
            print(f"chunks failed {d['id']}: {e}", file=sys.stderr)
            continue
        text = "\n".join(
            c.get("chunk_text", "")
            for c in sorted(chunks, key=lambda c: c.get("chunk_index", 0))
        ).strip()
        if not text:
            continue
        items.append({
            "id": d["id"],
            "content": text,
            "bank": BANK,
            "source": "hindsight",
            "created_at": d.get("created_at"),
        })
        if ts and (not max_ts or ts > max_ts):
            max_ts = ts
    pushed = 0
    if items:
        pushed = wreq("POST", "/sync/push", {"items": items}).get("pushed", 0)
    if max_ts:
        save_wm(max_ts)
    return pushed, len(docs)


if __name__ == "__main__":
    ra, rt = pull()
    p, ds = push()
    print(json.dumps(
        {"pulled_retained": ra, "pulled_total": rt, "pushed": p, "docs_seen": ds},
        ensure_ascii=False,
    ))
