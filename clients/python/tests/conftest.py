import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import kitelog
from kitelog import api, sender

CAPS = {
    "can_save": {"checkpoint": True, "artifact": True},
    "max_checkpoint_bytes": 1000,
    "keep_checkpoints": 1,
    "metric_types": ["number"],
}
PROJECT = {"id": "p1", "slug": "proj", "name": "Proj", "description": None, "created_at": 0}


class FakeServer:
    """Records every request; routes can be overridden with on(method, path_regex, fn)."""

    def __init__(self):
        self.requests = []
        self.routes = []
        self.lock = threading.Lock()
        self.caps = dict(CAPS)
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _handle(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = None
                req = {"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
                       "raw": raw, "json": body}
                with fake.lock:
                    fake.requests.append(req)
                status, payload, headers = fake.respond(req)
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_PATCH = _handle

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"
        threading.Thread(target=self.httpd.serve_forever, args=(0.02,), daemon=True).start()

    def on(self, method, pattern, fn):
        self.routes.insert(0, (method, re.compile(pattern + "$"), fn))

    def respond(self, req):
        for method, pattern, fn in self.routes:
            if method == req["method"] and pattern.match(req["path"]):
                r = fn(req)
                return r if len(r) == 3 else (*r, None)
        if req["path"] == "/api/v1/project":
            return 200, {"project": PROJECT, "capabilities": self.caps}, None
        if req["method"] == "POST" and req["path"] == "/api/v1/runs":
            return 200, {"id": "r1"}, None
        return 200, {}, None

    def find(self, method, pattern):
        rx = re.compile(pattern + "$")
        with self.lock:
            return [r for r in self.requests if r["method"] == method and rx.match(r["path"])]

    def paths(self):
        with self.lock:
            return [(r["method"], r["path"]) for r in self.requests]


@pytest.fixture
def server(monkeypatch, tmp_path):
    s = FakeServer()
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("KITELOG_BASE_URL", s.url)
    monkeypatch.setenv("KITELOG_API_KEY", "kl_test")
    monkeypatch.delenv("RANK", raising=False)
    monkeypatch.setattr(api, "BACKOFF", 0.01)
    monkeypatch.setattr(api, "RETRIES", 2)
    monkeypatch.setattr(sender, "FLUSH_INTERVAL", 30.0)  # tests flush explicitly
    yield s
    kitelog.finish(quiet=True)
    s.httpd.shutdown()
