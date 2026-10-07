import json
import logging
import os
import stat
import time

import pytest

import kitelog
from kitelog import cli, sender

METRICS = r"/api/v1/runs/r1/metrics"


def seqs(server):
    return [r["json"]["seq"] for r in server.find("POST", METRICS)]


def test_init_log_flush_seq_order(server):
    run = kitelog.init(project="proj", name="exp", config={"lr": 0.1}, tags=["a"])
    assert run.id == "r1" and run.writer_id == 0
    create = server.find("POST", "/api/v1/runs")[0]
    assert create["json"] == {"name": "exp", "config": {"lr": 0.1}, "tags": ["a"], "writer_id": 0}
    assert create["headers"]["authorization"] == "Bearer kl_test"

    kitelog.log({"loss": 1.0, "acc": 0.5})
    kitelog.log({"loss": 0.9})
    run._flush()
    kitelog.log({"loss": 0.8}, step=10)
    kitelog.log({"loss": 0.7})
    run._flush()
    run._flush()  # nothing queued: no empty segment

    posts = server.find("POST", METRICS)
    assert seqs(server) == [0, 1]  # new writer: last_seq -1, so seq starts at 0
    assert all(p["json"]["writer_id"] == 0 for p in posts)
    pts = posts[0]["json"]["points"]
    assert [(p["key"], p["step"], p["value"]) for p in pts] == [("loss", 0, 1.0), ("acc", 0, 0.5), ("loss", 1, 0.9)]
    assert isinstance(pts[0]["ts"], int)
    assert [p["step"] for p in posts[1]["json"]["points"]] == [10, 11]


def test_flush_on_max_points_and_interval(server, monkeypatch):
    monkeypatch.setattr(sender, "MAX_POINTS", 10)
    kitelog.init()
    for i in range(25):
        kitelog.log({"x": i})
    deadline = time.time() + 5
    while len(server.find("POST", METRICS)) < 2 and time.time() < deadline:
        time.sleep(0.01)
    assert [len(r["json"]["points"]) for r in server.find("POST", METRICS)] == [10, 10]

    monkeypatch.setattr(sender, "FLUSH_INTERVAL", 0.05)
    kitelog.log({"x": 99})  # wakes the sender; the remaining 6 points go out on the timer
    deadline = time.time() + 5
    while len(server.find("POST", METRICS)) < 3 and time.time() < deadline:
        time.sleep(0.01)
    assert seqs(server) == [0, 1, 2]
    assert len(server.find("POST", METRICS)[2]["json"]["points"]) == 6


def test_retry_resends_same_seq(server):
    calls = []

    def flaky(req):
        calls.append(req)
        return (500, {"error": {"code": "internal", "message": "boom"}}) if len(calls) == 1 else (200, {})

    server.on("POST", METRICS, flaky)
    run = kitelog.init()
    kitelog.log({"loss": 1.0})
    run._flush()
    assert seqs(server) == [0, 0]
    assert calls[0]["json"] == calls[1]["json"]
    kitelog.log({"loss": 2.0})
    run._flush()
    assert seqs(server) == [0, 0, 1]


def test_failed_flush_keeps_batch_for_next_flush(server, caplog):
    down = [True]
    server.on("POST", METRICS, lambda r: (503, {}) if down[0] else (200, {}))
    run = kitelog.init()
    kitelog.log({"loss": 1.0})
    run._flush()  # all retries fail: warning, batch kept
    assert "will retry" in caplog.text
    down[0] = False
    kitelog.log({"loss": 2.0})
    run._flush()
    ok = server.find("POST", METRICS)[-2:]
    assert [r["json"]["seq"] for r in ok] == [0, 1]
    assert [p["value"] for p in ok[0]["json"]["points"]] == [1.0]


def test_4xx_not_retried(server, caplog):
    server.on("POST", METRICS, lambda r: (400, {"error": {"code": "bad", "message": "nope"}}))
    run = kitelog.init()
    kitelog.log({"loss": 1.0})
    run._flush()
    assert seqs(server) == [0]
    assert "dropping 1 points" in caplog.text


def test_resume_kwarg_sends_resume(server):
    kitelog.init(resume="r1", name="again")
    assert server.find("POST", "/api/v1/runs")[0]["json"] == {"name": "again", "resume": "r1", "writer_id": 0}


def test_run_id_sent_as_resume(server):
    kitelog.init(run_id="exp-42")
    assert server.find("POST", "/api/v1/runs")[0]["json"] == {"resume": "exp-42", "writer_id": 0}


def test_run_id_from_env(server, monkeypatch):
    monkeypatch.setenv("KITELOG_RUN_ID", "exp-env")
    monkeypatch.setenv("RANK", "3")
    kitelog.init(project="proj")
    assert server.find("POST", "/api/v1/runs")[0]["json"] == {"resume": "exp-env", "writer_id": 3}
    kitelog.finish()
    monkeypatch.setenv("KITELOG_RUN_ID", "ignored")
    kitelog.init(run_id="explicit")
    assert server.find("POST", "/api/v1/runs")[1]["json"]["resume"] == "explicit"


def test_numeric_only_drops_with_single_warning(server, caplog):
    run = kitelog.init()
    with caplog.at_level(logging.WARNING, logger="kitelog"):
        kitelog.log({"loss": 1.0, "name": "a", "flag": True, "bad": float("nan")})
        kitelog.log({"loss": 2.0, "name": "b", "flag": False, "bad": float("inf")})
        run._flush()
    pts = server.find("POST", METRICS)[0]["json"]["points"]
    assert [(p["key"], p["value"]) for p in pts] == [("loss", 1.0), ("flag", 1.0), ("loss", 2.0), ("flag", 0.0)]
    msgs = [r.getMessage() for r in caplog.records]
    assert sum("'name'" in m for m in msgs) == 1
    assert sum("'bad'" in m for m in msgs) == 1


def test_bad_keys_and_steps_dropped(server, caplog):
    run = kitelog.init()
    kitelog.log({"k" * 257: 1.0, "": 2.0, "ok": 3.0})
    kitelog.log({"ok": 4.0}, step=-1)
    run._flush()
    pts = server.find("POST", METRICS)[0]["json"]["points"]
    assert [(p["key"], p["value"]) for p in pts] == [("ok", 3.0)]
    assert "negative step" in caplog.text


def test_del_char_key_dropped_with_warning(server, caplog):
    run = kitelog.init()
    with caplog.at_level(logging.WARNING, logger="kitelog"):
        kitelog.log({"bad\x7fkey": 1.0, "ok": 2.0})
    run._flush()
    pts = server.find("POST", METRICS)[0]["json"]["points"]
    assert [p["key"] for p in pts] == ["ok"]
    assert "dropping metric key" in caplog.text


def test_no_checkpoint_limit_when_null(server, tmp_path):
    server.caps["max_checkpoint_bytes"] = None
    f = tmp_path / "big.pt"
    f.write_bytes(b"x" * 5000)
    kitelog.init()
    kitelog.save_checkpoint(str(f))
    assert server.find("POST", r"/api/v1/runs/r1/uploads")


def test_save_skipped_when_not_allowed(server, tmp_path, caplog):
    server.caps["can_save"] = {"checkpoint": True, "artifact": False}
    f = tmp_path / "preds.txt"
    f.write_bytes(b"x" * 10)
    big = tmp_path / "big.pt"
    big.write_bytes(b"x" * 2000)  # over max_checkpoint_bytes=1000
    kitelog.init()
    with caplog.at_level(logging.WARNING, logger="kitelog"):
        kitelog.save(str(f))
        kitelog.save(str(f))
        kitelog.save_checkpoint(str(big))
        kitelog.save_checkpoint(str(big))
    assert server.find("POST", r"/api/v1/runs/r1/uploads") == []
    msgs = [r.getMessage() for r in caplog.records]
    assert sum("cannot save artifact" in m for m in msgs) == 1
    assert sum("over the 1000 byte limit" in m for m in msgs) == 1


def test_single_upload(server, tmp_path):
    f = tmp_path / "model.pt"
    f.write_bytes(b"checkpoint-bytes")
    server.on("POST", r"/api/v1/runs/r1/uploads", lambda r: (200, {"id": "u1", "upload": {
        "type": "single", "url": server.url + "/s3/obj?sig=1", "method": "PUT",
        "headers": {"x-amz-test": "1"}}}))
    kitelog.init()
    kitelog.save_checkpoint(str(f))
    req = server.find("POST", r"/api/v1/runs/r1/uploads")[0]["json"]
    assert req == {"path": "model.pt", "kind": "checkpoint", "size": 16, "content_type": "application/octet-stream"}
    put = server.find("PUT", r"/s3/obj\?sig=1")[0]
    assert put["raw"] == b"checkpoint-bytes"
    assert "authorization" not in put["headers"]
    assert put["headers"]["x-amz-test"] == "1"
    assert server.find("POST", r"/api/v1/uploads/u1/complete")[0]["json"] == {}


def test_relative_worker_url_upload(server, tmp_path):
    f = tmp_path / "preds.csv"
    f.write_bytes(b"a,b\n")
    server.on("POST", r"/api/v1/runs/r1/uploads", lambda r: (200, {"id": "u2", "upload": {
        "type": "single", "url": "/api/v1/uploads/u2/body", "method": "PUT",
        "headers": {"Authorization": "Bearer upload-token"}}}))
    kitelog.init()
    kitelog.save(str(f))
    put = server.find("PUT", r"/api/v1/uploads/u2/body")[0]
    assert put["raw"] == b"a,b\n" and put["headers"]["authorization"] == "Bearer upload-token"
    assert server.find("POST", r"/api/v1/runs/r1/uploads")[0]["json"]["content_type"] == "text/csv"


def test_multipart_upload(server, tmp_path):
    data = b"0123456789AB"
    f = tmp_path / "model.pt"
    f.write_bytes(data)
    server.on("POST", r"/api/v1/runs/r1/uploads", lambda r: (200, {"id": "u3", "upload": {
        "type": "multipart", "part_size": 5,
        "parts": [{"n": i, "url": f"{server.url}/s3/part{i}"} for i in (1, 2, 3)]}}))
    server.on("PUT", r"/s3/part\d", lambda r: (200, b"", {"ETag": '"etag-' + r["path"][-1] + '"'}))
    kitelog.init()
    kitelog.save_checkpoint(str(f))
    bodies = [server.find("PUT", rf"/s3/part{i}")[0]["raw"] for i in (1, 2, 3)]
    assert bodies == [b"01234", b"56789", b"AB"]
    done = server.find("POST", r"/api/v1/uploads/u3/complete")[0]["json"]
    assert done == {"parts": [{"n": 1, "etag": '"etag-1"'}, {"n": 2, "etag": '"etag-2"'}, {"n": 3, "etag": '"etag-3"'}]}


def test_upload_rejected_is_warning(server, tmp_path, caplog):
    f = tmp_path / "model.pt"
    f.write_bytes(b"x")
    server.on("POST", r"/api/v1/runs/r1/uploads",
              lambda r: (403, {"error": {"code": "storage_tier_limit", "message": "no"}}))
    kitelog.init()
    kitelog.save_checkpoint(str(f))
    assert "storage_tier_limit" in caplog.text


def test_finish_compacts_and_sets_status(server):
    kitelog.init()
    kitelog.log({"loss": 1.0})
    kitelog.finish()
    assert kitelog.run is None
    tail = server.paths()[-3:]
    assert tail == [("POST", METRICS), ("POST", METRICS + "/compact"), ("PATCH", "/api/v1/runs/r1")]
    assert server.find("PATCH", "/api/v1/runs/r1")[0]["json"] == {"status": "finished"}
    with pytest.raises(RuntimeError):
        kitelog.log({"x": 1})


def test_finish_failed_status(server):
    run = kitelog.init()
    run.finish(exit_code=1)
    run.finish()  # idempotent
    assert [r["json"] for r in server.find("PATCH", "/api/v1/runs/r1")] == [{"status": "failed"}]


def test_compaction_every_n_segments(server, monkeypatch):
    monkeypatch.setattr(sender, "COMPACT_EVERY", 2)
    run = kitelog.init()
    for i in range(5):
        kitelog.log({"x": i})
        run._flush()
    assert len(server.find("POST", METRICS + "/compact")) == 2
    kitelog.finish()
    assert len(server.find("POST", METRICS + "/compact")) == 3


def test_non_zero_writer_only_flushes(server, monkeypatch):
    monkeypatch.setenv("RANK", "1")
    monkeypatch.setattr(sender, "COMPACT_EVERY", 1)
    kitelog.init(run_id="r1")
    kitelog.log({"loss": 1.0})
    kitelog.finish()
    assert server.find("POST", METRICS)[0]["json"]["writer_id"] == 1
    assert server.find("POST", METRICS + "/compact") == []
    assert server.find("PATCH", "/api/v1/runs/r1") == []


def test_idle_heartbeat(server, monkeypatch):
    monkeypatch.setattr(sender, "FLUSH_INTERVAL", 0.02)
    monkeypatch.setattr(sender, "HEARTBEAT_INTERVAL", 0.05)
    kitelog.init()
    time.sleep(0.3)
    beats = server.find("POST", "/api/v1/runs/r1/heartbeat")
    assert beats and beats[0]["json"] == {"writer_id": 0}


def test_excepthook_marks_failed(server):
    import sys
    kitelog.init()
    sys.excepthook(ValueError, ValueError("boom"), None)
    assert server.find("PATCH", "/api/v1/runs/r1")[0]["json"] == {"status": "failed"}


def test_server_down_never_crashes(monkeypatch, tmp_path, caplog):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("KITELOG_BASE_URL", "http://127.0.0.1:9")  # nothing listens
    monkeypatch.setenv("KITELOG_API_KEY", "kl_test")
    monkeypatch.setattr(kitelog.api, "BACKOFF", 0.01)
    monkeypatch.setattr(kitelog.api, "RETRIES", 1)
    run = kitelog.init()
    assert run.id is None and "init failed" in caplog.text
    kitelog.log({"loss": 1.0})
    kitelog.save("nothing")
    kitelog.finish()


def test_missing_credentials_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("KITELOG_BASE_URL", raising=False)
    monkeypatch.delenv("KITELOG_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="kitelog login"):
        kitelog.init()


def test_cli_login_writes_private_config(server, monkeypatch, tmp_path):
    monkeypatch.delenv("KITELOG_BASE_URL")
    monkeypatch.delenv("KITELOG_API_KEY")
    monkeypatch.setattr("builtins.input", lambda prompt: server.url)
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt: "kl_secret")
    cli.main(["login"])
    path = tmp_path / ".kitelog" / "config"
    assert json.loads(path.read_text()) == {"base_url": server.url, "api_key": "kl_secret"}
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert server.find("GET", "/api/v1/project")[0]["headers"]["authorization"] == "Bearer kl_secret"
    run = kitelog.init()  # settings now come from the config file
    assert run.id == "r1"


def test_summary_sent_in_final_patch(server):
    run = kitelog.init()
    kitelog.summary({"acc": 0.9})
    run.summary["n"] = 3
    kitelog.finish()
    patches = server.find("PATCH", "/api/v1/runs/r1")
    assert [p["json"] for p in patches] == [{"status": "finished", "summary": {"acc": 0.9, "n": 3}}]


def test_summary_non_serializable_skipped(server, caplog):
    class Item:
        def item(self):
            return 7

    kitelog.init()
    kitelog.summary({"ok": Item(), "bad": object(), "nan": float("nan")})
    kitelog.finish()
    assert server.find("PATCH", "/api/v1/runs/r1")[0]["json"]["summary"] == {"ok": 7}
    assert "non-serializable summary value for 'bad'" in caplog.text


def test_empty_summary_not_sent(server):
    kitelog.init()
    kitelog.summary({})
    kitelog.finish()
    assert server.find("PATCH", "/api/v1/runs/r1")[0]["json"] == {"status": "finished"}


def test_oversized_summary_dropped_status_kept(server, caplog):
    kitelog.init()
    kitelog.summary({"big": "x" * 300_000})
    kitelog.finish()
    assert server.find("PATCH", "/api/v1/runs/r1")[0]["json"] == {"status": "finished"}
    assert "summary too large, not sent" in caplog.text


def test_oversized_config_dropped_run_created(server, caplog):
    run = kitelog.init(name="exp", config={"big": "x" * 300_000})
    assert run.id == "r1"
    body = server.find("POST", "/api/v1/runs")[0]["json"]
    assert "config" not in body and body["name"] == "exp"
    assert "config too large, not sent" in caplog.text
