"""Background sender thread: metric flushes, compaction (writer 0), heartbeats."""

import logging
import queue
import threading
import time

from .api import ApiError

log = logging.getLogger("kitelog")

# Module constants so tests can monkeypatch them.
FLUSH_INTERVAL = 15.0  # seconds between flushes
MAX_POINTS = 5000  # flush early at this many points (server caps a flush at 10000)
COMPACT_EVERY = 50  # writer 0 compacts after this many of its segments
HEARTBEAT_INTERVAL = 60.0  # bare heartbeat when nothing was sent for this long
MAX_CONFLICTS = 20  # 409s tolerated for one batch before it is dropped


class Sender(threading.Thread):
    def __init__(self, client, run_id, writer_id):
        super().__init__(name="kitelog-sender", daemon=True)
        self.client = client
        self.run_id = run_id
        self.writer_id = writer_id
        self.queue = queue.Queue()  # point dicts, or (command, done_event, arg) tuples
        self.seq = 0  # last seq handed out
        self.batches = []  # [[seq or None, points]]; only batches[0] may hold a seq
        self.segments = 0  # committed segments since the last compaction
        self.last_contact = time.monotonic()

    def run(self):
        buf = []
        last_flush = time.monotonic()
        while True:
            timeout = max(0.0, last_flush + FLUSH_INTERVAL - time.monotonic())
            try:
                item = self.queue.get(timeout=timeout)
            except queue.Empty:
                item = None
            if isinstance(item, dict):
                buf.append(item)
                if len(buf) < MAX_POINTS and time.monotonic() - last_flush < FLUSH_INTERVAL:
                    continue
                item = None
            if buf:
                self.batches.append([None, buf])
                buf = []
            last_flush = time.monotonic()
            self._send_batches()
            if item is None:
                if time.monotonic() - self.last_contact >= HEARTBEAT_INTERVAL:
                    self._heartbeat()
                continue
            cmd, done, arg = item
            if cmd == "finish":
                self._finish(arg)
                done.set()
                return
            done.set()  # "flush"

    def _post(self, suffix, body=None):
        return self.client.request("POST", f"/api/v1/runs/{self.run_id}{suffix}", body)

    def _send_batches(self):
        conflicts = 0
        while self.batches:
            batch = self.batches[0]
            if batch[0] is None:
                self.seq += 1
                batch[0] = self.seq
            try:
                self._post("/metrics", {"writer_id": self.writer_id, "seq": batch[0], "points": batch[1]})
            except ApiError as e:
                if e.status == 409 and conflicts < MAX_CONFLICTS:
                    # seq too low (e.g. resumed writer): jump ahead exponentially (1, 2, 4, ...) and resend.
                    self.seq += 2**conflicts
                    batch[0] = self.seq
                    conflicts += 1
                    continue
                if e.status == 0 or e.status >= 500 or e.status == 429:
                    log.warning("kitelog: metrics flush failed, will retry (%s)", e)
                    return  # keep the batch and its seq; next attempt resends it
                log.warning("kitelog: dropping %d points rejected by server (%s)", len(batch[1]), e)
                self.batches.pop(0)
                continue
            self.batches.pop(0)
            conflicts = 0
            self.last_contact = time.monotonic()
            if self.writer_id == 0:
                self.segments += 1
                if self.segments >= COMPACT_EVERY:
                    self._compact()

    def _compact(self):
        try:
            self._post("/metrics/compact")
            self.segments = 0
        except ApiError as e:
            log.warning("kitelog: compaction failed (%s)", e)

    def _heartbeat(self):
        try:
            self._post("/heartbeat", {"writer_id": self.writer_id})
            self.last_contact = time.monotonic()
        except ApiError as e:
            log.warning("kitelog: heartbeat failed (%s)", e)

    def _finish(self, status):
        if self.batches:
            lost = sum(len(b[1]) for b in self.batches)
            log.warning("kitelog: %d points could not be sent", lost)
        if self.writer_id != 0:
            return
        self._compact()
        try:
            self.client.request("PATCH", f"/api/v1/runs/{self.run_id}", {"status": status})
        except ApiError as e:
            log.warning("kitelog: could not set run status (%s)", e)
