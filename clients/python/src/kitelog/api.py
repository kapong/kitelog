"""Tiny urllib client for the kitelog API: settings, JSON calls, retries."""

import http.client
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger("kitelog")

RETRIES = 5  # extra attempts after the first one
BACKOFF = 1.0  # seconds before the first retry; doubles each time
MAX_BACKOFF = 30.0
TIMEOUT = 60.0


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


def send(make_request):
    """Send make_request() (a fresh urllib Request per attempt) with retries.

    Retries network errors, 5xx and 429 with exponential backoff. Other HTTP
    errors raise immediately. Returns (headers, body_bytes); raises ApiError.
    """
    delay = BACKOFF
    for attempt in range(RETRIES + 1):
        try:
            with urllib.request.urlopen(make_request(), timeout=TIMEOUT) as r:
                return r.headers, r.read()
        except urllib.error.HTTPError as e:
            err = _error(e.code, e.read())
            if not (e.code >= 500 or e.code == 429) or attempt == RETRIES:
                raise err from None
        except (OSError, http.client.HTTPException) as e:
            if attempt == RETRIES:
                raise ApiError(0, "network_error", str(e)) from None
        time.sleep(min(delay, MAX_BACKOFF))
        delay *= 2


class Client:
    def __init__(self, base_url, api_key):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def url(self, url):
        """Resolve a possibly relative URL from upload instructions against the base URL."""
        return urllib.parse.urljoin(self.base_url + "/", url)

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body, default=str).encode()
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"

        def make():
            return urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)

        _, raw = send(make)
        return json.loads(raw) if raw.strip() else {}
