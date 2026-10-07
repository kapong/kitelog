"""Background sender thread: metric flushes, compaction (writer 0), heartbeats."""

import logging
import queue
import threading
import time

from .api import ApiError, retryable, run_ended, stop_sending

log = logging.getLogger("kitelog")


def warn_once(seen, key, msg, *args):
    if key not in seen:
        seen.add(key)
        log.warning(msg, *args)

# Module constants so tests can monkeypatch them.
FLUSH_INTERVAL = 15.0  # seconds between flushes
MAX_POINTS = 5000  # points per batch; a full batch is sent early (server caps a flush at 10000)
COMPACT_EVERY = 20  # writer 0 compacts after this many of its segments
HEARTBEAT_INTERVAL = 60.0  # bare heartbeat when nothing was sent for this long
MAX_PENDING_POINTS = 1_000_000  # buffered while the server is unreachable; oldest dropped beyond


class Sender(threading.Thread):
    def __init__(self, client, run_id, writer_id, last_seq=-1):
        super().__init__(name="kitelog-sender", daemon=True)
        self.client = client
        self.run_id = run_id
        self.writer_id = writer_id
        self.queue = queue.Queue()  # point dicts, or (command, done_event, arg) tuples
        self.next_seq = last_seq + 1  # next seq to hand out
        self.batches = []  # [[seq or None, points]]; only batches[0] may hold a seq
        self.pending = 0  # points in self.batches
        self.segments = 0  # committed segments since the last compaction
        self.failing = False  # last send failed: wait for the timer instead of sending early
        self.disabled = False  # API key rejected or run ended: stop all network calls
        self.compact_more = False  # last periodic compaction left work; call again next tick
        self.stopping = False
        self.last_flush = time.monotonic()
        self.last_contact = time.monotonic()
        self._warned = set()

    def run(self):
        # Only a finish command ends the thread; anything unexpected is logged and survived.
        while True:
            try:
                if self._tick():
                    return
            except Exception:
                log.exception("kitelog: sender error")
                if self.stopping:
                    return
                time.sleep(min(1.0, FLUSH_INTERVAL))

    def _tick(self):
        cmd = self._collect()
        if self.compact_more and not self.disabled:  # one call per tick, so flushing is never held up
            self._compact()
        if cmd is None:
            now = time.monotonic()
            if now - self.last_flush >= FLUSH_INTERVAL:
                self._send_batches()
                self.last_flush = time.monotonic()
                if not self.batches and time.monotonic() - self.last_contact >= HEARTBEAT_INTERVAL:
                    self._heartbeat()
            elif not self.failing and self._has_full():
                self._send_batches(only_full=True)
                self.last_flush = time.monotonic()
            return False
        name, done, arg = cmd
        self.stopping = name == "finish"
        try:
            self._send_batches()
            self.last_flush = time.monotonic()
            if self.stopping:
                self._finish(arg)
        finally:
            done.set()
        return self.stopping

    def _collect(self):
        """Wait for the next item, then drain what is queued without blocking. Returns a command or None."""
        timeout = max(0.0, self.last_flush + FLUSH_INTERVAL - time.monotonic())
        try:
            item = self.queue.get(timeout=timeout)
        except queue.Empty:
            return None
        for _ in range(MAX_POINTS):  # bounded, so a log storm still reaches the flush checks
            if not isinstance(item, dict):
                return item
            self._add(item)
            try:
                item = self.queue.get_nowait()
            except queue.Empty:
                return None
        if isinstance(item, dict):
            self._add(item)
            return None
        return item

    def _add(self, point):
        """Append to the last batch if it was never sent and has room, so outages don't fragment."""
        if self.disabled:
            return
        last = self.batches[-1] if self.batches else None
        if last is not None and last[0] is None and len(last[1]) < MAX_POINTS:
            last[1].append(point)
        else:
            self.batches.append([None, [point]])
        self.pending += 1
        while self.pending > MAX_PENDING_POINTS and len(self.batches) > 1:
            dropped = self.batches.pop(0)
            self.pending -= len(dropped[1])
            warn_once(self._warned, "cap", "kitelog: over %d points buffered (server unreachable?); dropping the oldest",
                            MAX_PENDING_POINTS)

    def _has_full(self):
        return len(self.batches) > 1 or (bool(self.batches) and len(self.batches[0][1]) >= MAX_POINTS)

    def _post(self, suffix, body=None):
        return self.client.request("POST", f"/api/v1/runs/{self.run_id}{suffix}", body)

    def _disable(self, e):
        self.disabled = True  # pending batches stay; finish() reports them as not sent
        if run_ended(e):
            warn_once(self._warned, "auth", "kitelog: run is no longer running on the server (%s); "
                      "run disabled, nothing more will be sent", e)
        else:
            warn_once(self._warned, "auth", "kitelog: API key rejected (%s); run disabled, nothing more will be sent", e)

    def _drop(self, why):
        batch = self.batches.pop(0)
        self.pending -= len(batch[1])
        log.warning("kitelog: dropping %d points (%s)", len(batch[1]), why)

    def _send_batches(self, only_full=False):
        while self.batches and not self.disabled:
            if only_full and not self._has_full():
                return
            batch = self.batches[0]
            if batch[0] is None:
                batch[0] = self.next_seq
                self.next_seq += 1
            try:
                sent = self._send_one(batch)
            except ApiError as e:
                if stop_sending(e):
                    self._disable(e)
                    return
                if retryable(e):
                    self.failing = True
                    log.warning("kitelog: metrics flush failed, will retry (%s)", e)
                    return  # keep the batch and its seq; resending the same seq is idempotent
                self._drop(f"rejected by server: {e}")
                continue
            if not sent:  # dropped after a seq conflict
                continue
            self.batches.pop(0)
            self.pending -= len(batch[1])
            self.failing = False
            self.last_contact = time.monotonic()
            if self.writer_id == 0:
                self.segments += 1
                if self.segments >= COMPACT_EVERY:
                    self._compact()

    def _send_one(self, batch):
        """POST one batch. On 409, jump to the server's last_seq + 1 and retry once; else drop it.

        Returns True if sent, False if dropped."""
        for attempt in range(2):
            try:
                self._post("/metrics", {"writer_id": self.writer_id, "seq": batch[0], "points": batch[1]})
                return True
            except ApiError as e:
                if e.status != 409 or run_ended(e):
                    raise
                err = e.body.get("error") if isinstance(e.body, dict) else None
                last = err.get("last_seq") if isinstance(err, dict) else None
                if attempt or not isinstance(last, int) or isinstance(last, bool):
                    self._drop(f"seq conflict: {e}")
                    return False
                batch[0] = last + 1
                self.next_seq = last + 2

    def _compact(self):
        """One compaction call (the server does a bounded amount of work). Sets and returns `more`."""
        self.compact_more = False
        try:
            result = self._post("/metrics/compact")
            self.segments = 0
            self.compact_more = isinstance(result, dict) and result.get("more") is True
        except ApiError as e:
            if stop_sending(e):
                self._disable(e)
            else:
                log.warning("kitelog: compaction failed (%s)", e)
        return self.compact_more

    def _heartbeat(self):
        if self.disabled:
            return
        try:
            self._post("/heartbeat", {"writer_id": self.writer_id})
            self.last_contact = time.monotonic()
        except ApiError as e:
            if stop_sending(e):
                self._disable(e)
            else:
                log.warning("kitelog: heartbeat failed (%s)", e)

    def _finish(self, patch):
        if self.pending:
            log.warning("kitelog: %d points not sent", self.pending)
        if self.writer_id != 0 or self.disabled:
            return
        # Keep compacting while the server reports more work, until finish()'s deadline.
        while self._compact() and not self.disabled:
            if self.client.deadline is not None and time.monotonic() >= self.client.deadline:
                break
        if self.disabled:
            return
        try:
            self.client.request("PATCH", f"/api/v1/runs/{self.run_id}", patch)
        except ApiError as e:
            if stop_sending(e):
                self._disable(e)
            else:
                log.warning("kitelog: could not set run status (%s)", e)
