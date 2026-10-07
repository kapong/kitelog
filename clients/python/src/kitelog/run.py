"""Run: init / log / save / finish. Network problems become warnings, never exceptions."""

import logging
import math
import mimetypes
import os
import sys
import threading
import time
import urllib.request

from .api import ApiError, Client, load_settings, send
from .sender import Sender

log = logging.getLogger("kitelog")
_DROP = object()
MAX_KEY_LEN = 256


class _Slice:
    """File-like view of `size` bytes from `offset`, so uploads stream instead of loading the file."""

    def __init__(self, f, offset, size):
        f.seek(offset)
        self.f = f
        self.left = size

    def read(self, n=-1):
        if n is None or n < 0 or n > self.left:
            n = self.left
        data = self.f.read(n)
        self.left -= len(data)
        return data


class Run:
    def __init__(self, project=None, name=None, config=None, tags=None, run_id=None):
        base_url, api_key = load_settings()
        if not base_url or not api_key:
            raise RuntimeError(
                "kitelog: no credentials. Set KITELOG_API_KEY and KITELOG_BASE_URL, or run `kitelog login`."
            )
        self.id = None  # None = disabled (server unreachable at init); all calls become no-ops
        self.name = name
        self.config = dict(config or {})
        self.writer_id = int(os.environ.get("RANK", 0))
        self.capabilities = {}
        self._client = Client(base_url, api_key)
        self._sender = None
        self._step = 0
        self._warned = set()
        self._lock = threading.Lock()
        self._finished = False
        try:
            proj = self._client.request("GET", "/api/v1/project")
            self.capabilities = proj["capabilities"]
            slug = (proj.get("project") or {}).get("slug")
            if project and slug and project != slug:
                log.warning("kitelog: API key belongs to project %r, not %r; logging to %r", slug, project, slug)
            body = {k: v for k, v in (("name", name), ("config", config), ("tags", tags)) if v is not None}
            if run_id:
                body["resume"] = run_id
            created = self._client.request("POST", "/api/v1/runs", body)
            self.id = created["id"]
        except (ApiError, KeyError, TypeError, ValueError) as e:
            log.warning("kitelog: init failed, run disabled (%s)", e)
            return
        self._sender = Sender(self._client, self.id, self.writer_id)
        self._sender.start()

    def _warn_once(self, key, msg, *args):
        if key not in self._warned:
            self._warned.add(key)
            log.warning(msg, *args)

    def _clean(self, key, value):
        if not isinstance(value, (int, float)) and hasattr(value, "item"):
            try:  # numpy / torch scalars
                value = value.item()
            except Exception:
                pass
        if isinstance(value, bool):
            return float(value)
        if isinstance(value, (int, float)):
            if math.isfinite(value):
                return value
            self._warn_once(("metric", key), "kitelog: dropping non-finite value for %r", key)
            return _DROP
        self._warn_once(("metric", key), "kitelog: dropping non-numeric value for %r (numbers only)", key)
        return _DROP

    def log(self, data, step=None):
        """Queue metrics; never blocks on the network. Bools log as 0/1; NaN/inf are dropped."""
        if self._sender is None or self._finished:
            return
        with self._lock:
            if step is None:
                step = self._step
            step = int(step)
            if step < 0:
                self._warn_once("step", "kitelog: negative step %d; ignoring log call", step)
                return
            self._step = max(self._step, step + 1)
        ts = int(time.time() * 1000)
        for key, value in data.items():
            key = str(key)
            if not 1 <= len(key) <= MAX_KEY_LEN:
                self._warn_once(("metric", key), "kitelog: dropping metric key %r (1-%d chars)", key[:40], MAX_KEY_LEN)
                continue
            value = self._clean(key, value)
            if value is not _DROP:
                self._sender.queue.put({"key": str(key), "step": step, "value": value, "ts": ts})

    def save_checkpoint(self, path):
        self._upload(path, "checkpoint")

    def save(self, path):
        self._upload(path, "artifact")

    def _upload(self, path, kind):
        """Upload synchronously so the file cannot change underneath us. Stored under its basename."""
        if self._sender is None or self._finished:
            return
        if not (self.capabilities.get("can_save") or {}).get(kind):
            self._warn_once(("save", kind), "kitelog: this project cannot save %s files; skipping", kind)
            return
        try:
            size = os.path.getsize(path)
        except OSError as e:
            log.warning("kitelog: cannot read %s (%s)", path, e)
            return
        limit = self.capabilities.get("max_checkpoint_bytes")
        if kind == "checkpoint" and limit is not None and size > limit:
            self._warn_once(("size", path), "kitelog: %s is %d bytes, over the %d byte limit; skipping", path, size, limit)
            return
        content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        try:
            created = self._client.request(
                "POST",
                f"/api/v1/runs/{self.id}/uploads",
                {"path": os.path.basename(path), "kind": kind, "size": size, "content_type": content_type},
            )
            info = created["upload"]
            with open(path, "rb") as f:
                if info["type"] == "single":
                    self._put(info["url"], info.get("headers"), f, 0, size)
                    done = {}
                else:
                    part_size = int(info["part_size"])
                    parts = []
                    for part in info["parts"]:
                        offset = (int(part["n"]) - 1) * part_size
                        etag = self._put(part["url"], None, f, offset, min(part_size, size - offset))
                        parts.append({"n": part["n"], "etag": etag})
                    done = {"parts": parts}
            self._client.request("POST", f"/api/v1/uploads/{created['id']}/complete", done)
        except (ApiError, OSError, KeyError, TypeError, ValueError) as e:
            log.warning("kitelog: upload of %s failed (%s)", path, e)

    def _put(self, url, headers, f, offset, size):
        """Send bytes to an instruction URL. No kitelog auth header: presigned URLs carry their own."""
        headers = dict(headers or {})
        headers["Content-Length"] = str(size)

        def make():
            return urllib.request.Request(self._client.url(url), data=_Slice(f, offset, size),
                                          headers=headers, method="PUT")

        resp_headers, _ = send(make)
        return resp_headers.get("ETag")

    def _flush(self):
        """Block until everything queued so far was sent (or failed). Used by tests."""
        if self._sender is not None and not self._finished:
            done = threading.Event()
            self._sender.queue.put(("flush", done, None))
            done.wait()

    def finish(self, exit_code=0, quiet=False):
        """Flush; writer 0 also compacts and sets status `finished` (exit_code 0) or `failed`."""
        if self._finished:
            return
        self._finished = True
        status = "finished" if exit_code == 0 else "failed"
        if self._sender is not None:
            done = threading.Event()
            self._sender.queue.put(("finish", done, status))
            done.wait()
        if not quiet and self.id is not None:
            print(f"kitelog: run {self.id} {status if self.writer_id == 0 else 'flushed'}", file=sys.stderr)
