"""Dev instance identity.

One agent, one window, one Vite, one control server, one private profile. The
unit of isolation is the instance, not the checkout, so several can run in the
same worktree without sharing a WebView2 profile or a discovery file.

`YTM_INSTANCE` names it. Everything else is derived: the data dir under
`app/.instances/<id>/`, the discovery file, the artifacts dir. The id `default`
keeps the old layout, meaning `app/` itself and `app/dev/.dev.json`, so a plain
`start.ps1` behaves exactly as it did before instances existed.

Dev only. Nothing here runs in a frozen build.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEV_DIR = Path(__file__).resolve().parent
APP_DIR = DEV_DIR.parent
REPO_DIR = DEV_DIR.parents[1]
INSTANCES_DIR = DEV_DIR / ".instances"
LEGACY_DISCOVERY_PATH = DEV_DIR / ".dev.json"

DEFAULT_ID = "default"

# Windows forbids these in a file name, and this id becomes one.
_UNSAFE = set('\\/:*?"<>|')


def _slug(value: str) -> str:
    cleaned = "".join("-" if char in _UNSAFE or char.isspace() else char for char in value)
    return cleaned.strip("-.")


def instance_id() -> str:
    """This process's instance id, ``default`` when unset."""
    return _slug(os.environ.get("YTM_INSTANCE", "").strip()) or DEFAULT_ID


def label() -> str:
    """Free text naming the instance, for window titles and listings."""
    return os.environ.get("YTM_INSTANCE_LABEL", "").strip()


def branch() -> str | None:
    """Current branch, for listings. Stable for the life of the window."""
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_DIR), "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    name = result.stdout.strip()
    return name if result.returncode == 0 and name else None


def is_default() -> bool:
    """True for the instance that keeps the pre-instance layout."""
    return instance_id() == DEFAULT_ID


def instances_dir() -> Path:
    """Directory holding one discovery file per live instance of this checkout."""
    return INSTANCES_DIR


def discovery_path() -> Path:
    """This instance's discovery file.

    Per instance, so writing or removing one never clobbers a sibling.
    """
    return INSTANCES_DIR / f"{instance_id()}.json"


def legacy_discovery_path() -> Path:
    """The single pre-instance discovery file, still written for ``default``."""
    return LEGACY_DISCOVERY_PATH


def artifacts_dir() -> Path:
    """Per-instance logs and screenshots."""
    return INSTANCES_DIR / instance_id() / "artifacts"


def data_dir() -> Path:
    """Instance-private profile, sign-in, preferences, stats and cache.

    Must agree with ``util.app_paths.data_dir()``, so an explicit `YTM_DATA_DIR`
    wins here too: the collision guard below is only worth anything if it checks
    the directory the app will actually open. ``default`` with no override keeps
    the checkout-wide ``app/``, so existing files are left where they are.
    """
    override = os.environ.get("YTM_DATA_DIR", "").strip()
    if override:
        return Path(override)
    if is_default():
        return APP_DIR
    return APP_DIR / ".instances" / instance_id()


def apply_env() -> None:
    """Fill in the env the rest of the app reads, from `YTM_INSTANCE`.

    Call before importing the app, because several modules resolve
    ``data_dir()`` and ``cache_dir()`` at import time. Safe to call twice, and
    an explicit variable already in the environment always wins.

    Nothing is set for ``default``, so a plain ``start.ps1`` changes no env.
    """
    ident = instance_id()
    os.environ["YTM_INSTANCE"] = ident
    if ident == DEFAULT_ID:
        return
    os.environ.setdefault("YTM_DATA_DIR", str(APP_DIR / ".instances" / ident))
    # One cache per checkout is the default: same code, so same payload shapes.
    if os.environ.get("YTM_ISOLATE_CACHE") != "1":
        os.environ.setdefault("YTM_CACHE_DIR", str(APP_DIR / ".cache"))
    # Media keys and Discord are OS-wide, so only one window can hold them.
    # The default instance keeps today's behavior; a named one opts in.
    os.environ.setdefault("YTM_MEDIA_KEYS", "0")
    os.environ.setdefault("YTM_DISCORD", "0")


def _answers(info: dict[str, Any]) -> bool:
    """True when the recorded pid is still serving its control port."""
    port = info.get("controlPort")
    if not isinstance(port, int):
        return False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.5) as response:
            health = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return False
    return health.get("pid") == info.get("pid")


def _candidates() -> list[dict[str, Any]]:
    """Every readable discovery record, live or stale."""
    records: list[dict[str, Any]] = []
    paths = list(INSTANCES_DIR.glob("*.json")) if INSTANCES_DIR.is_dir() else []
    if LEGACY_DISCOVERY_PATH not in paths:
        paths.append(LEGACY_DISCOVERY_PATH)
    for path in paths:
        try:
            info = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(info, dict) and info.get("instance"):
            records.append(info)
    return records


def live_instances() -> list[dict[str, Any]]:
    """Every instance of this checkout that still answers its control port."""
    seen: set[str] = set()
    live: list[dict[str, Any]] = []
    for info in _candidates():
        ident = str(info.get("instance"))
        if ident in seen:
            continue
        if _answers(info):
            seen.add(ident)
            live.append(info)
    return live


def owner_of_data_dir(path: Path) -> dict[str, Any] | None:
    """A live instance already using `path`, ignoring this one.

    This is the precise form of the old one-per-checkout lock: two windows may
    share a checkout, but never a WebView2 profile.
    """
    target = os.path.normcase(str(path))
    mine = instance_id()
    for info in live_instances():
        if str(info.get("instance")) == mine:
            continue
        if os.path.normcase(str(info.get("dataDir") or "")) == target:
            return info
    return None


def _seed_browser_json(root: Path, force: bool = False) -> None:
    """Copy the checkout's sign-in into a named instance's private data dir.

    The checkout's file stays the source of truth and is never modified. Copying
    rather than sharing means a token refresh writes only this instance's copy,
    so two windows never race one ``browser.json``. ``force`` skips the mtime
    check, for when the checkout re-signed in and this copy should follow.
    """
    source = APP_DIR / "browser.json"
    if not source.is_file():
        return
    target = root / "browser.json"
    try:
        if not force and target.is_file() and target.stat().st_mtime >= source.stat().st_mtime:
            return
        shutil.copy2(source, target)
        logger.info("Seeded sign-in into %s", target)
    except OSError:
        logger.exception("Could not seed %s", target)


def reseed_requested() -> bool:
    """True when the launcher asked for the sign-in copy to be refreshed."""
    return os.environ.get("YTM_RESEED") == "1"


def prepare(reseed: bool | None = None) -> Path:
    """Create this instance's directories, seed the sign-in, and check the profile.

    Returns the data dir. Raises ``SystemExit`` when another live instance
    already owns that dir, because WebView2 refuses two processes on one folder
    and half-starting is worse than not starting.
    """
    apply_env()
    root = data_dir()
    # Runs for every instance, including `default`: it only objects to a
    # *different* live instance on this data dir, so a duplicate of this same id
    # is left to the control-server check in main.py, which explains it better.
    ensure_no_owner(root)
    root.mkdir(parents=True, exist_ok=True)
    artifacts_dir().mkdir(parents=True, exist_ok=True)
    INSTANCES_DIR.mkdir(parents=True, exist_ok=True)
    if not is_default():
        _seed_browser_json(root, force=reseed_requested() if reseed is None else reseed)
    return root


def ensure_no_owner(path: Path) -> None:
    """Refuse to start when a live instance already uses `path`."""
    owner = owner_of_data_dir(path)
    if owner is None:
        return
    logger.error(
        "Instance %r already uses the data dir %s (pid %s, vite %s, control %s). "
        "Stop it with `python app\\dev\\cli.py -i %s stop`, or pick another instance id.",
        owner.get("instance"),
        path,
        owner.get("pid"),
        owner.get("vitePort"),
        owner.get("controlPort"),
        owner.get("instance"),
    )
    raise SystemExit(1)
