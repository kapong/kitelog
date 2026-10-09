"""Run: init / log / save / finish. Network problems become warnings, never exceptions."""

import json
import logging
import math
import mimetypes
import os
import re
import threading
import time
import urllib.request

from . import api
from .api import ApiError, Client, load_settings, retryable, send, stop_sending
from .sender import MAX_PENDING_POINTS, Sender, warn_once

# Python's built-in table only: the host's /etc/mime.types differs per OS (e.g. `.pt`).
_MIME = mimetypes.MimeTypes()

log = logging.getLogger("kitelog")
_DROP = object()
MAX_JSON_CHARS = 256_000  # server limit for a run's summary / config


def _too_large(value):
    try:
        return len(json.dumps(value)) > MAX_JSON_CHARS
    except (TypeError, ValueError):
        return False  # let the server decide
FINISH_TIMEOUT = 30.0  # finish()/atexit never blocks longer than this
_KEY = re.compile(r"[^,\s\x00-\x1f\x7f]{1,256}")  # metric keys, as in the server contract
_BAD_PATH_CHARS = re.compile(r"[\\\x00-\x1f\x7f]")


def _put_retryable(e):
    return retryable(e) or (e.status == 400 and e.code == "body_incomplete")


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


def _rank():
    raw = os.environ.get("RANK")
    if raw is None:
        return 0
    try:
        rank = int(raw)
        if 0 <= rank < 2**31:
            return rank
    except ValueError:
        pass
    log.warning("kitelog: RANK=%r is not a valid rank; using writer_id 0", raw)
    return 0


class Run:
    def __init__(self, project=None, name=None, config=None, tags=None, run_id=None):
        base_url, api_key = load_settings()
        if not base_url or not api_key:
            raise RuntimeError(
                "kitelog: no credentials. Set KITELOG_API_KEY and KITELOG_BASE_URL, or run `kitelog login`."
            )
        self.id = None  # None = disabled (server unreachable at init); all calls become no-ops
        self.writer_id = _rank()
        self.capabilities = {}
        self._client = Client(base_url, api_key)
        self._sender = None
        self._step = 0
        self._warned = set()
        self._lock = threading.Lock()
        self._finished = False
        self.summary = {}
        try:
            proj = self._client.request("GET", "/api/v1/project")
            self.capabilities = proj["capabilities"]
            slug = (proj.get("project") or {}).get("slug")
            if project and slug and project != slug:
                log.warning("kitelog: API key belongs to project %r, not %r; logging to %r", slug, project, slug)
            if config is not None and _too_large(config):
                log.warning("kitelog: config too large, not sent")
                config = None
            body = {k: v for k, v in (("name", name), ("config", config), ("tags", tags)) if v is not None}
            if run_id:
                body["resume"] = run_id
            body["writer_id"] = self.writer_id
            created = self._client.request("POST", "/api/v1/runs", body)
            run_id = created["id"]
            last_seq = int(created.get("last_seq", -1))
        except (ApiError, OSError, AttributeError, KeyError, TypeError, ValueError) as e:
            log.warning("kitelog: init failed, run disabled (%s)", e)
            return
        self.id = run_id
        self._sender = Sender(self._client, self.id, self.writer_id, last_seq)
        self._sender.start()

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
            warn_once(self._warned, ("metric", key), "kitelog: dropping non-finite value for %r", key)
            return _DROP
        warn_once(self._warned, ("metric", key), "kitelog: dropping non-numeric value for %r (numbers only)", key)
        return _DROP

    def _active(self):
        return self._sender is not None and not self._finished and not self._sender.disabled

    def log(self, data, step=None):
        """Queue metrics; never blocks on the network. Bools log as 0/1; NaN/inf are dropped."""
        if not self._active():
            return
        q = self._sender.queue
        if q.qsize() >= MAX_PENDING_POINTS:  # sender stuck in a long request; don't grow forever
            warn_once(self._warned, "queue", "kitelog: over %d points queued; dropping new points", MAX_PENDING_POINTS)
            return
        with self._lock:
            if step is None:
                step = self._step
            step = int(step)
            if step < 0:
                warn_once(self._warned, "step", "kitelog: negative step %d; ignoring log call", step)
                return
            self._step = max(self._step, step + 1)
        ts = int(time.time() * 1000)
        for key, value in data.items():
            key = str(key)
            if not _KEY.fullmatch(key):
                warn_once(self._warned, ("metric", key), "kitelog: dropping metric key %r (1-256 chars, no commas, "
                                "whitespace or control characters)", key[:40])
                continue
            value = self._clean(key, value)
            if value is not _DROP:
                q.put({"key": key, "step": step, "value": value, "ts": ts})

    def save_checkpoint(self, path):
        self._upload(path, "checkpoint")

    def save(self, path):
        self._upload(path, "artifact")

    def _upload(self, path, kind):
        """Upload synchronously so the file cannot change underneath us. Stored under its basename."""
        if not self._active():
            return
        if not (self.capabilities.get("can_save") or {}).get(kind):
            warn_once(self._warned, ("save", kind), "kitelog: this project cannot save %s files; skipping", kind)
            return
        name = _BAD_PATH_CHARS.sub("_", os.path.basename(path))
        if name in ("", ".", "..") or len(name) > 1024:
            log.warning("kitelog: cannot upload %r: no usable file name; skipping", path)
            return
        try:
            size = os.path.getsize(path)
            if not os.path.isfile(path):
                raise OSError("not a regular file")
        except OSError as e:
            log.warning("kitelog: cannot read %s (%s)", path, e)
            return
        limit = self.capabilities.get("max_checkpoint_bytes")
        if kind == "checkpoint" and limit is not None and size > limit:
            warn_once(self._warned, ("size", path), "kitelog: %s is %d bytes, over the %d byte limit; skipping", path, size, limit)
            return
        content_type = _MIME.guess_type(path)[0] or "application/octet-stream"
        try:
            created = self._client.request(
                "POST",
                f"/api/v1/runs/{self.id}/uploads",
                {"path": name, "kind": kind, "size": size, "content_type": content_type},
            )
            info = created["upload"]
            with open(path, "rb") as f:
                if info["type"] == "single":
                    self._put(info["url"], info.get("headers"), content_type, f, 0, size)
                    done = {}
                else:
                    part_size = int(info["part_size"])
                    parts = []
                    for part in info["parts"]:
                        offset = (int(part["n"]) - 1) * part_size
                        etag = self._put(part["url"], None, "application/octet-stream", f, offset,
                                         min(part_size, size - offset))
                        if not etag:
                            raise ApiError(0, "no_etag", f"storage returned no ETag for part {part['n']}")
                        parts.append({"n": part["n"], "etag": etag})
                    done = {"parts": parts}
            try:
                self._client.request("POST", f"/api/v1/uploads/{created['id']}/complete", done)
            except ApiError as e:
                if e.status != 404:
                    raise
                warn_once(self._warned, "run_deleted", "kitelog: run %s was deleted on the server; "
                          "skipping upload of %s", self.id, path)
        except ApiError as e:
            if stop_sending(e):
                self._sender._disable(e)
            else:
                log.warning("kitelog: upload of %s failed (%s)", path, e)
        except (OSError, KeyError, TypeError, ValueError) as e:
            log.warning("kitelog: upload of %s failed (%s)", path, e)

    def _put(self, url, headers, content_type, f, offset, size):
        """Send bytes to an instruction URL. No kitelog auth header: presigned URLs carry their own.

        Content-Type is set explicitly (urllib would otherwise add a form type); instruction headers win.
        """
        headers = dict(headers or {})
        if not any(k.lower() == "content-type" for k in headers):
            headers["Content-Type"] = content_type
        headers["Content-Length"] = str(size)

        def make():
            return urllib.request.Request(self._client.url(url), data=_Slice(f, offset, size),
                                          headers=headers, method="PUT")

        # 400 body_incomplete: the body was cut short in transit; resend it like a network error.
        _, resp_headers, _ = send(make, timeout=api.UPLOAD_TIMEOUT, retry=_put_retryable)
        return resp_headers.get("ETag")

    def _command(self, name, arg=None, deadline=None):
        """Queue a command for the sender; wait until done, the sender dies, or `deadline` passes."""
        done = threading.Event()
        self._sender.queue.put((name, done, arg))
        while not done.wait(0.05):
            if not self._sender.is_alive() or (deadline is not None and time.monotonic() >= deadline):
                return False
        return True

    def _flush(self):
        """Block until everything queued so far was sent (or failed). Used by tests."""
        if self._sender is not None and not self._finished:
            self._command("flush")

    def _summary_body(self):
        """JSON-safe copy of self.summary; unserializable keys are skipped with one warning each."""
        out = {}
        for key, value in self.summary.items():
            if not isinstance(value, (int, float)) and hasattr(value, "item"):
                try:  # numpy / torch scalars
                    value = value.item()
                except Exception:
                    pass
            try:
                json.dumps(value, allow_nan=False)
            except (TypeError, ValueError):
                warn_once(self._warned, ("summary", key), "kitelog: skipping non-serializable summary value for %r", key)
                continue
            out[str(key)] = value
        return out

    def finish(self, exit_code=0):
        """Flush; writer 0 also compacts and sets status `finished` (exit_code 0) or `failed`.

        Returns within about FINISH_TIMEOUT seconds even if the server is down.
        """
        if self._finished:
            return
        self._finished = True
        status = "finished" if exit_code == 0 else "failed"
        if self._sender is None:
            return
        deadline = time.monotonic() + FINISH_TIMEOUT
        self._client.deadline = deadline
        patch = {"status": status}
        summary = self._summary_body() if self.writer_id == 0 else {}
        if summary and _too_large(summary):
            log.warning("kitelog: summary too large, not sent")
            summary = {}
        if summary:
            patch["summary"] = summary
        if not self._command("finish", patch, deadline + 0.5):
            lost = self._sender.pending + max(0, self._sender.queue.qsize() - 1)
            log.warning("kitelog: finish timed out after %.0f s; %d points not sent", FINISH_TIMEOUT, lost)
        elif not self._sender.disabled:
            log.info("kitelog: run %s %s", self.id, status if self.writer_id == 0 else "flushed")
