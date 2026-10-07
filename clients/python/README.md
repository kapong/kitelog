# kitelog

Python client for [kitelog](https://github.com/kapong/kitelog), a self-hosted experiment tracker on Cloudflare. Log metrics, config, checkpoints, and files from training scripts. Python 3.9+, standard library only.

## Install

```bash
pip install kitelog
```

## Quickstart

```python
import kitelog as kl

kl.init(project="my-proj", name="exp-1", config={"lr": 1e-3})
for step in range(100):
    kl.log({"loss": loss, "acc": acc}, step=step)
kl.save_checkpoint("model.pt")
kl.summary({"best_acc": 0.93})
kl.finish()
```

## Configuration

Create a project and an API key (`kl_...`) in your kitelog web UI, then either set environment variables:

```bash
export KITELOG_BASE_URL=https://kitelog.example.com
export KITELOG_API_KEY=kl_...
```

or run `kitelog login` to save them to `~/.kitelog/config` (mode 0600). Environment variables take precedence. An API key is scoped to one project.

## API

- `kitelog.init(project=None, name=None, config=None, tags=None, resume=None, run_id=None)`: start a run, or join/continue one by id (`run_id` and `resume` are the same; default `KITELOG_RUN_ID`). An id that does not exist yet is created. Returns the `Run`.
- `kitelog.log(data, step=None)`: queue a dict of numeric metrics. `step` defaults to an auto-incrementing counter.
- `kitelog.save_checkpoint(path)`: upload a checkpoint file (stored under its basename).
- `kitelog.save(path)`: upload an artifact file (requires the project to use its own S3 storage).
- `kitelog.summary(data)`: merge a dict into the run summary; sent when the run finishes.
- `kitelog.finish(exit_code=0)`: flush and close the run (`failed` if `exit_code` is nonzero). Also runs automatically at exit.
- `kitelog.run`: the active `Run` (its `id` is the run id).

Metric values must be numbers (bools become 0/1; numpy/torch scalars are converted). Non-numeric, NaN, and infinite values are dropped with a one-time warning. Keys are 1 to 256 characters with no commas, whitespace, or control characters.

## Distributed training and resume

Pick a run id (1 to 64 characters of `A-Z a-z 0-9 _ -`) and give the same one to every rank, either as `kitelog.init(project="my-proj", run_id="exp-42")` or by setting `KITELOG_RUN_ID` in the launcher (the client reads it when `run_id` is not passed). The first rank to arrive creates the run under that id; the others join it. No coordination between ranks is needed. The writer id comes from the `RANK` environment variable (default 0). Only rank 0's `finish()` compacts metrics and closes the run.

```bash
KITELOG_RUN_ID=exp-42 torchrun --nproc_per_node=4 train.py   # train.py calls kitelog.init(project="my-proj")
```

Use a new id for each new run: reusing an id joins (resumes) that run. To continue a run later, use `kitelog.init(resume="<run_id>")` (same as `run_id`).

## Behavior guarantees

- `log()` is non-blocking: points are queued and sent by a background thread about every 15 seconds.
- The client never crashes your training script. Network errors are retried with backoff; if the server is unreachable at `init()`, the run is disabled and every call becomes a no-op with a warning. A rejected API key (401/403) disables the run after one warning.
- Files the project cannot store are skipped with one warning; the server enforces the same rules.
- `finish()` (and exit) waits at most 30 seconds in total, then reports how many points were not sent.
- An uncaught exception marks the run `failed`.
- Up to 1 million points are buffered while the server is unreachable.

## License

TBD.
