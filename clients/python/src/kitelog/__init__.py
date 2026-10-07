"""kitelog: lightweight experiment tracking.

    import kitelog as kl
    kl.init(project="my-proj", name="exp-1", config={"lr": 1e-3})
    kl.log({"loss": 0.5}, step=0)
    kl.save_checkpoint("model.pt")
    kl.finish()
"""

import atexit
import sys

from .run import Run

__all__ = ["init", "log", "save", "save_checkpoint", "finish", "run", "Run"]
__version__ = "0.1.0"

run = None  # the active Run, set by init()
_hooked = False


def init(project=None, name=None, config=None, tags=None, resume=None, run_id=None):
    """Create a run, or join an existing one with `resume`/`run_id` (distributed ranks share one id)."""
    global run, _hooked
    if run is not None:
        run.finish()
    run = Run(project=project, name=name, config=config, tags=tags, run_id=resume or run_id)
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


def finish(exit_code=0, quiet=False):
    global run
    if run is not None:
        run.finish(exit_code=exit_code, quiet=quiet)
        run = None


def _atexit():
    if run is not None:
        run.finish()
