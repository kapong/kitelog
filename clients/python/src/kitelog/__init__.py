"""kitelog: lightweight experiment tracking.

    import kitelog as kl
    kl.init(project="my-proj", name="exp-1", config={"lr": 1e-3})
    kl.log({"loss": 0.5}, step=0)
    kl.save_checkpoint("model.pt")
    kl.finish()
"""

import atexit
import os
import sys

from .run import Run

__all__ = ["init", "log", "save", "save_checkpoint", "summary", "finish", "run", "Run"]
__version__ = "0.1.0"

run = None  # the active Run, set by init()
_hooked = False


def init(project=None, name=None, config=None, tags=None, resume=None, run_id=None):
    """Create a run, or join one by id with `run_id`/`resume` (default: env KITELOG_RUN_ID).

    Joining an id that does not exist yet creates it with that id, so distributed ranks can all
    pass the same id (1-64 chars of A-Z a-z 0-9 _ -) with no coordination.
    """
    global run, _hooked
    if run is not None:
        run.finish()
    run = Run(project=project, name=name, config=config, tags=tags, run_id=resume or run_id or os.environ.get("KITELOG_RUN_ID") or None)
    if not _hooked:
        _hooked = True
        atexit.register(_atexit)
        prev = sys.excepthook

        def hook(tp, value, tb):
            prev(tp, value, tb)
            if run is not None:
                run.finish(exit_code=1)

        sys.excepthook = hook
    return run


def _active():
    if run is None:
        raise RuntimeError("kitelog: call kitelog.init() first")
    return run


def log(data, step=None):
    _active().log(data, step=step)


def save(path):
    _active().save(path)


def save_checkpoint(path):
    _active().save_checkpoint(path)


def summary(data):
    """Merge `data` into run.summary; sent with the final PATCH in finish()."""
    _active().summary.update(data)


def finish(exit_code=0):
    global run
    if run is not None:
        run.finish(exit_code=exit_code)
        run = None


def _atexit():
    if run is not None:
        run.finish()
