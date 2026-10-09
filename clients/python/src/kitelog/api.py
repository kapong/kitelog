"""Tiny urllib client for the kitelog API: settings, JSON calls, retries."""

import http.client
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from . import __version__

log = logging.getLogger("kitelog")

RETRIES = 5  # extra attempts after the first one
BACKOFF = 1.0  # seconds before the first retry; doubles each time
MAX_BACKOFF = 30.0
TIMEOUT = 30.0  # per attempt, JSON API calls
UPLOAD_TIMEOUT = 300.0  # per attempt, file body PUTs
# Cloudflare's edge rejects urllib's default "Python-urllib/3.x" User-Agent (403 before the Worker).
USER_AGENT = f"kitelog-python/{__version__}"


class ApiError(Exception):
    """HTTP error from the server (status > 0) or network failure after retries (status 0)."""

    def __init__(self, status, code, message, body=None):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.body = body or {}


def config_path():
    return os.path.join(os.path.expanduser("~"), ".kitelog", "config")


def load_settings():
    """Return (base_url, api_key). Env vars win over ~/.kitelog/config."""
    cfg = {}
    try:
        with open(config_path()) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        log.warning("kitelog: cannot read %s: %s", config_path(), e)
    base = os.environ.get("KITELOG_BASE_URL") or cfg.get("base_url")
    key = os.environ.get("KITELOG_API_KEY") or cfg.get("api_key")
    return base, key


def _error(status, raw):
    try:
        body = json.loads(raw)
        err = body.get("error") or {}
        return ApiError(status, err.get("code", f"http_{status}"), err.get("message", ""), body)
    except (ValueError, AttributeError):
        return ApiError(status, f"http_{status}", raw[:200].decode("utf-8", "replace"))


def retryable(e):
    """Worth sending again later: network failure, 5xx, 429, or an unparsable 2xx body."""
    return e.status == 0 or e.status >= 500 or e.status == 429 or e.code == "bad_json"


def run_ended(e):
    """409 `run_not_running`: the run is finished or failed; nothing more will be accepted."""
    return e.status == 409 and e.code == "run_not_running"


def stop_sending(e):
    """Terminal for the whole run: key rejected or run already ended."""
    return auth_failed(e) or run_ended(e)


def auth_failed(e):
    """The API key was rejected. (403 `storage_tier_limit` only refuses one file.)"""
    return e.status == 401 or (e.status == 403 and e.code != "storage_tier_limit")


def send(make_request, timeout=None, deadline=lambda: None, retry=retryable):
    """Send make_request() (a fresh urllib Request per attempt) with retries.

    Retries errors for which `retry(err)` is true (default: network errors, 5xx,
    429) with exponential backoff. Other HTTP errors raise immediately. `deadline()` returns an absolute time.monotonic()
    (or None); no attempt or backoff runs past it. Returns (status, headers,
    body_bytes); raises ApiError.
    """
    timeout = TIMEOUT if timeout is None else timeout
    delay = BACKOFF
    for attempt in range(RETRIES + 1):
        t = timeout
        end = deadline()
        if end is not None:
            t = min(t, end - time.monotonic())
            if t <= 0:
                raise ApiError(0, "timeout", "deadline reached")
        try:
            with urllib.request.urlopen(make_request(), timeout=t) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            try:
                raw = e.read()
            except (OSError, http.client.HTTPException):
                raw = b""
            err = _error(e.code, raw)
            if not retry(err) or attempt == RETRIES:
                raise err from None
        except (OSError, http.client.HTTPException) as e:
            err = ApiError(0, "network_error", str(e))
            if attempt == RETRIES:
                raise err from None
        pause = min(delay, MAX_BACKOFF)
        end = deadline()
        if end is not None and time.monotonic() + pause >= end:
            raise err
        time.sleep(pause)
        delay *= 2


class Client:
    def __init__(self, base_url, api_key):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.deadline = None  # absolute time.monotonic(); set by finish() to bound shutdown

    def url(self, url):
        """Resolve a possibly relative URL from upload instructions against the base URL."""
        return urllib.parse.urljoin(self.base_url + "/", url)

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body, default=str).encode()
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json",
                   "User-Agent": USER_AGENT}
        if data is not None:
            headers["Content-Type"] = "application/json"

        def make():
            return urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)

        status, _, raw = send(make, deadline=lambda: self.deadline)
        if not raw.strip():
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            raise ApiError(status, "bad_json", "response is not JSON: " + raw[:100].decode("utf-8", "replace")) from None
