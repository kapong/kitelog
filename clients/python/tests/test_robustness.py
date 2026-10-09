import importlib
import logging
import time

import kitelog
from kitelog import api, sender

run_mod = importlib.import_module("kitelog.run")  # `kitelog.run` the attribute is the active Run

METRICS = r"/api/v1/runs/r1/metrics"
ERR = {"error": {"code": "internal", "message": "boom"}}


def posts(server):
    return server.find("POST", METRICS)


def values(req):
    return [p["value"] for p in req["json"]["points"]]


# ---- writer_id / last_seq ----

def test_resume_continues_after_last_seq(server, monkeypatch):
    monkeypatch.setenv("RANK", "3")
    server.on("POST", "/api/v1/runs", lambda r: (200, {"id": "r1", "last_seq": 41}))
    run = kitelog.init(run_id="r1")
    assert server.find("POST", "/api/v1/runs")[0]["json"] == {"resume": "r1", "writer_id": 3}
    kitelog.log({"loss": 1.0})
    run._flush()
    kitelog.log({"loss": 2.0})
    run._flush()
    assert [(r["json"]["writer_id"], r["json"]["seq"]) for r in posts(server)] == [(3, 42), (3, 43)]


def test_bad_rank_warns_and_uses_zero(server, monkeypatch, caplog):
    monkeypatch.setenv("RANK", "abc")
    run = kitelog.init()
    assert run.writer_id == 0 and "RANK='abc'" in caplog.text


# ---- 409 seq_conflict ----

def conflict_below(last):
    def fn(req):
        if req["json"]["seq"] <= last:
            return 409, {"error": {"code": "seq_conflict", "message": "low", "last_seq": last}}
        return 200, {}
    return fn


def test_409_jumps_to_server_last_seq_once(server):
    server.on("POST", METRICS, conflict_below(7))
    run = kitelog.init()
    kitelog.log({"loss": 1.0})
    run._flush()
    kitelog.log({"loss": 2.0})
    run._flush()
    assert [r["json"]["seq"] for r in posts(server)] == [0, 8, 9]
    assert values(posts(server)[1]) == [1.0]


def test_second_409_drops_batch(server, caplog):
    server.on("POST", METRICS, lambda r: (409, {"error": {"code": "seq_conflict", "message": "x", "last_seq": 50}}))
    run = kitelog.init()
    kitelog.log({"loss": 1.0})
    run._flush()
    assert [r["json"]["seq"] for r in posts(server)] == [0, 51]
    assert caplog.text.count("dropping 1 points") == 1
    assert run._sender.batches == [] and run._sender.pending == 0


def test_409_without_last_seq_drops_batch(server, caplog):
    server.on("POST", METRICS, lambda r: (409, {"error": {"code": "seq_conflict", "message": "x"}}))
    run = kitelog.init()
    kitelog.log({"loss": 1.0})
    run._flush()
    assert len(posts(server)) == 1
    assert caplog.text.count("dropping 1 points") == 1


# ---- 1: sender thread never dies ----

def test_non_json_200_is_retried_and_does_not_hang(server):
    bad = [True]
    server.on("POST", METRICS, lambda r: (200, b"<html>proxy</html>") if bad[0] else (200, {}))
    run = kitelog.init()
    kitelog.log({"loss": 1.0})
    run._flush()  # returns: bad_json is a retryable failure, batch kept
    assert run._sender.is_alive() and run._sender.pending == 1
    bad[0] = False
    run._flush()
    assert [r["json"]["seq"] for r in posts(server)][-1] == 0  # same seq resent
    assert run._sender.pending == 0


def test_unexpected_exception_does_not_kill_sender(server, monkeypatch, caplog):
    run = kitelog.init()
    s = run._sender
    real = s._send_batches
    calls = []

    def boom(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("unexpected")
        return real(*a, **k)

    monkeypatch.setattr(s, "_send_batches", boom)
    kitelog.log({"loss": 1.0})
    run._flush()  # done is still set
    deadline = time.time() + 2
    while "sender error" not in caplog.text and time.time() < deadline:
        time.sleep(0.01)
    assert s.is_alive() and "sender error" in caplog.text
    run._flush()
    assert values(posts(server)[0]) == [1.0]


def test_flush_returns_if_sender_dead(server):
    run = kitelog.init()
    run._sender.queue.put(("finish", __import__("threading").Event(), "finished"))
    run._sender.join(5)
    t = time.monotonic()
    run._flush()
    assert time.monotonic() - t < 1


# ---- 2: finish has a total deadline ----

def test_finish_returns_within_deadline_when_server_down(server, monkeypatch, caplog):
    monkeypatch.setattr(run_mod, "FINISH_TIMEOUT", 0.5)
    monkeypatch.setattr(api, "RETRIES", 5)
    monkeypatch.setattr(api, "BACKOFF", 0.2)  # without a deadline: ~6 s per call, 3 calls
    run = kitelog.init()
    server.on("POST", r"/api/v1/runs/r1/.*", lambda r: (503, ERR))
    server.on("PATCH", r"/api/v1/runs/r1", lambda r: (503, ERR))
    kitelog.log({"loss": 1.0, "acc": 2.0})
    t = time.monotonic()
    run.finish()
    assert time.monotonic() - t < 1.5
    assert "2 points not sent" in caplog.text


def test_finish_returns_when_server_hangs(server, monkeypatch, caplog):
    monkeypatch.setattr(run_mod, "FINISH_TIMEOUT", 0.3)
    run = kitelog.init()
    server.on("POST", METRICS, lambda r: (time.sleep(2), (200, {}))[1])
    kitelog.log({"loss": 1.0})
    t = time.monotonic()
    run.finish()
    assert time.monotonic() - t < 1.5
    assert "points not sent" in caplog.text


# ---- 3: bounded memory, no fragmentation ----

def test_outage_merges_points_instead_of_fragmenting(server):
    down = [True]
    server.on("POST", METRICS, lambda r: (503, ERR) if down[0] else (200, {}))
    run = kitelog.init()
    for i in range(4):
        kitelog.log({"x": float(i)})
        run._flush()
    down[0] = False
    run._flush()
    ok = posts(server)[-2:]
    assert [r["json"]["seq"] for r in ok] == [0, 1]
    assert [values(r) for r in ok] == [[0.0], [1.0, 2.0, 3.0]]


def test_buffer_cap_drops_oldest_batch(server, monkeypatch, caplog):
    monkeypatch.setattr(sender, "MAX_POINTS", 3)
    monkeypatch.setattr(sender, "MAX_PENDING_POINTS", 6)
    down = [True]
    server.on("POST", METRICS, lambda r: (503, ERR) if down[0] else (200, {}))
    run = kitelog.init()
    kitelog.log({"x": 0.0})
    run._flush()  # seq 0 assigned, failed
    for i in range(1, 8):
        kitelog.log({"x": float(i)})
    run._flush()
    assert run._sender.pending <= 6
    down[0] = False
    run._flush()
    ok = posts(server)[-2:]
    assert [values(r) for r in ok] == [[4.0, 5.0, 6.0], [7.0]]
    assert [r["json"]["seq"] for r in ok] == [1, 2]
    assert caplog.text.count("dropping the oldest") == 1


# ---- 401/403 ----

def test_auth_failure_disables_run(server, caplog):
    server.on("POST", METRICS, lambda r: (401, {"error": {"code": "unauthorized", "message": "bad key"}}))
    run = kitelog.init()
    kitelog.log({"loss": 1.0})
    run._flush()
    kitelog.log({"loss": 2.0})
    run._flush()
    run.finish()
    assert len(posts(server)) == 1
    assert server.find("PATCH", "/api/v1/runs/r1") == []
    assert caplog.text.count("API key rejected") == 1


# ---- metric keys ----

def test_invalid_metric_keys_dropped_with_one_warning(server, caplog):
    run = kitelog.init()
    with caplog.at_level(logging.WARNING, logger="kitelog"):
        for _ in range(2):
            kitelog.log({"a,b": 1.0, "a b": 2.0, "a\x01": 3.0, "tab\t": 4.0, "ok/x.y": 5.0})
        run._flush()
    assert {p["key"] for p in posts(server)[0]["json"]["points"]} == {"ok/x.y"}
    msgs = [r.getMessage() for r in caplog.records if "dropping metric key" in r.getMessage()]
    assert len(msgs) == 4


# ---- uploads ----

def single_upload(server, uid, headers=None):
    server.on("POST", r"/api/v1/runs/r1/uploads", lambda r: (200, {"id": uid, "upload": {
        "type": "single", "url": f"/s3/{uid}", "method": "PUT", "headers": headers or {}}}))


def test_put_content_type_is_declared_type(server, tmp_path):
    f = tmp_path / "preds.csv"
    f.write_bytes(b"a\n")
    single_upload(server, "u1")
    kitelog.init()
    kitelog.save(str(f))
    assert server.find("PUT", "/s3/u1")[0]["headers"]["content-type"] == "text/csv"


def test_put_instruction_content_type_wins(server, tmp_path):
    f = tmp_path / "preds.csv"
    f.write_bytes(b"a\n")
    single_upload(server, "u1", {"content-type": "x/signed"})
    kitelog.init()
    kitelog.save(str(f))
    put = server.find("PUT", "/s3/u1")[0]
    assert put["headers"]["content-type"] == "x/signed"


def multipart(server, uid, etag):
    server.on("POST", r"/api/v1/runs/r1/uploads", lambda r: (200, {"id": uid, "upload": {
        "type": "multipart", "part_size": 5, "parts": [{"n": 1, "url": "/s3/p1"}, {"n": 2, "url": "/s3/p2"}]}}))
    server.on("PUT", r"/s3/p\d", lambda r: (200, b"", {"ETag": '"e"'} if etag else {}))


def test_multipart_part_content_type(server, tmp_path):
    f = tmp_path / "model.pt"
    f.write_bytes(b"0123456789")
    multipart(server, "u2", etag=True)
    kitelog.init()
    kitelog.save_checkpoint(str(f))
    assert server.find("PUT", "/s3/p1")[0]["headers"]["content-type"] == "application/octet-stream"
    assert server.find("POST", "/api/v1/uploads/u2/complete")


def test_missing_etag_is_warning_without_complete(server, tmp_path, caplog):
    f = tmp_path / "model.pt"
    f.write_bytes(b"0123456789")
    multipart(server, "u3", etag=False)
    kitelog.init()
    kitelog.save_checkpoint(str(f))
    assert "no_etag" in caplog.text
    assert server.find("POST", "/api/v1/uploads/u3/complete") == []


def test_upload_path_sanitized(server, tmp_path):
    f = tmp_path / "we\\ird\x01.pt"
    f.write_bytes(b"x")
    single_upload(server, "u4")
    kitelog.init()
    kitelog.save_checkpoint(str(f))
    assert server.find("POST", r"/api/v1/runs/r1/uploads")[0]["json"]["path"] == "we_ird_.pt"


def test_upload_directory_skipped(server, tmp_path, caplog):
    kitelog.init()
    kitelog.save(str(tmp_path) + "/")
    kitelog.save(str(tmp_path))
    assert server.find("POST", r"/api/v1/runs/r1/uploads") == []
    assert "skipping" in caplog.text and "not a regular file" in caplog.text


def test_init_survives_stalled_error_body(monkeypatch, caplog):
    import socket
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    conns = []

    def serve():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            conns.append(c)
            c.recv(65536)
            c.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 100\r\n\r\n")  # then stall

    import threading
    threading.Thread(target=serve, daemon=True).start()
    monkeypatch.setenv("KITELOG_BASE_URL", f"http://127.0.0.1:{srv.getsockname()[1]}")
    monkeypatch.setenv("KITELOG_API_KEY", "kl_test")
    monkeypatch.setattr(api, "TIMEOUT", 0.2)
    monkeypatch.setattr(api, "RETRIES", 1)
    monkeypatch.setattr(api, "BACKOFF", 0.01)
    try:
        run = kitelog.init()
    finally:
        srv.close()
        for c in conns:
            c.close()
    assert run.id is None and "init failed" in caplog.text


# ---- bounded compaction (CompactResult.more) ----

def compact_more_times(server, n):
    """Compaction reports more=True for the first n calls, then False."""
    calls = []

    def fn(r):
        calls.append(r)
        return 200, {"chunks": 3, "segments": 9, "more": len(calls) <= n}
    server.on("POST", METRICS + "/compact", fn)
    return calls


def test_finish_loops_compaction_until_more_false(server):
    compact_more_times(server, 3)
    kitelog.init()
    kitelog.log({"x": 1})
    kitelog.finish()
    tail = server.paths()[-5:]
    assert tail == [("PATCH", "/api/v1/runs/r1")] + [("POST", METRICS + "/compact")] * 4


def test_finish_compaction_loop_stops_at_deadline(server, monkeypatch):
    monkeypatch.setattr(run_mod, "FINISH_TIMEOUT", 0.5)
    server.on("POST", METRICS + "/compact", lambda r: (time.sleep(0.05), (200, {"chunks": 3, "segments": 9, "more": True}))[1])
    kitelog.init()
    t = time.monotonic()
    kitelog.finish()
    assert time.monotonic() - t < 2
    assert 2 <= len(server.find("POST", METRICS + "/compact")) < 20
    # status was set before compaction, so the deadline cut did not lose it
    assert server.find("PATCH", "/api/v1/runs/r1")[0]["json"] == {"status": "finished"}


def test_periodic_compaction_does_not_block_flushing(server, monkeypatch):
    monkeypatch.setattr(sender, "COMPACT_EVERY", 1)
    compact_more_times(server, 100)
    run = kitelog.init()
    kitelog.log({"x": 1})
    run._flush()
    # one compact after the segment; `more` is deferred to the next tick, not looped
    assert server.paths()[-2:] == [("POST", METRICS), ("POST", METRICS + "/compact")]
    assert len(server.find("POST", METRICS + "/compact")) == 1
    kitelog.log({"x": 2})
    run._flush()
    # next tick: one follow-up compact, then the flush still goes out
    assert len(posts(server)) == 2
    assert len(server.find("POST", METRICS + "/compact")) == 3  # deferred follow-up + one for the new segment


# ---- 409 run_not_running is terminal ----

NOT_RUNNING = {"error": {"code": "run_not_running", "message": "run is finished"}}


def test_run_not_running_disables_with_one_warning(server, caplog):
    server.on("POST", METRICS, lambda r: (409, NOT_RUNNING))
    run = kitelog.init()
    kitelog.log({"x": 1})
    run._flush()
    kitelog.log({"x": 2})
    run._flush()
    assert len(posts(server)) == 1  # not retried, no further sends
    assert run._sender.disabled
    assert caplog.text.count("no longer running") == 1
    kitelog.finish()
    assert server.find("PATCH", "/api/v1/runs/r1") == []


def test_heartbeat_run_not_running_disables(server, monkeypatch, caplog):
    monkeypatch.setattr(sender, "FLUSH_INTERVAL", 0.02)
    monkeypatch.setattr(sender, "HEARTBEAT_INTERVAL", 0.02)
    server.on("POST", "/api/v1/runs/r1/heartbeat", lambda r: (409, NOT_RUNNING))
    run = kitelog.init()
    time.sleep(0.3)
    assert len(server.find("POST", "/api/v1/runs/r1/heartbeat")) == 1
    assert run._sender.disabled
    assert caplog.text.count("no longer running") == 1


# ---- upload body PUT 400 body_incomplete / complete 404 ----

def test_put_body_incomplete_is_retried(server, tmp_path):
    f = tmp_path / "m.pt"
    f.write_bytes(b"hello")
    single_upload(server, "u7")
    calls = []

    def put(r):
        calls.append(r)
        if len(calls) == 1:
            return 400, {"error": {"code": "body_incomplete", "message": "short"}}
        return 200, b""
    server.on("PUT", "/s3/u7", put)
    kitelog.init()
    kitelog.save(str(f))
    assert [c["raw"] for c in calls] == [b"hello", b"hello"]
    assert server.find("POST", "/api/v1/uploads/u7/complete")


def test_put_body_incomplete_bounded_by_retries(server, tmp_path, caplog):
    f = tmp_path / "m.pt"
    f.write_bytes(b"hello")
    single_upload(server, "u8")
    server.on("PUT", "/s3/u8", lambda r: (400, {"error": {"code": "body_incomplete", "message": "short"}}))
    kitelog.init()
    kitelog.save(str(f))
    assert len(server.find("PUT", "/s3/u8")) == api.RETRIES + 1
    assert server.find("POST", "/api/v1/uploads/u8/complete") == []
    assert "body_incomplete" in caplog.text


def test_complete_404_warns_once_and_skips(server, tmp_path, caplog):
    single_upload(server, "u9")
    server.on("POST", "/api/v1/uploads/u9/complete", lambda r: (404, {"error": {"code": "not_found", "message": "x"}}))
    run = kitelog.init()
    for name in ("a.pt", "b.pt"):
        f = tmp_path / name
        f.write_bytes(b"x")
        kitelog.save(str(f))
    assert len(server.find("POST", "/api/v1/uploads/u9/complete")) == 2
    assert caplog.text.count("was deleted") == 1
    assert "upload of" not in caplog.text.replace("skipping upload of", "")
    assert not run._sender.disabled
