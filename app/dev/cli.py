"""Talk to a running dev instance from the command line.

Each window publishes a discovery file under `app/dev/.instances/<id>.json`, so
several can run side by side and this tool can name one with `-i`. It uses only
the standard library, so any Python can run it (the app's venv is not required).

    python app\\dev\\cli.py list
    python app\\dev\\cli.py list --worktrees
    python app\\dev\\cli.py list --prune
    python app\\dev\\cli.py health
    python app\\dev\\cli.py -i alpha health
    python app\\dev\\cli.py -i alpha wait
    python app\\dev\\cli.py -i alpha call get_playlists
    python app\\dev\\cli.py -i alpha call search "daft punk"
    python app\\dev\\cli.py -i alpha call search --json-file args.json
    python app\\dev\\cli.py -i alpha eval "document.body.innerText"
    python app\\dev\\cli.py -i alpha eval "document.querySelector('a').click()"
    python app\\dev\\cli.py -i alpha logs --level warning --limit 50
    python app\\dev\\cli.py -i alpha screenshot
    python app\\dev\\cli.py -i alpha screenshot C:\\temp\\shot.png
    python app\\dev\\cli.py -i alpha stop
    python app\\dev\\cli.py -c C:\\other\\checkout -i alpha health

`-i` names the instance. Without it `YTM_INSTANCE` wins, then a lone instance,
and several live ones is an error that lists them rather than guessing, because
a command must never drive the wrong window. `-c` points at another checkout's
instances, which agents legitimately need, and it always needs `-i` so reaching
another window stays deliberate.

A read is always safe. `call` runs any public API method, which includes writes
to the signed-in account, so treat it like the app's own buttons.

Use single quotes inside a JavaScript expression. PowerShell strips double quotes
on the way to a native command, so `eval "document.title"` works but
`eval 'document.querySelector("a")'` arrives with the quotes removed.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Duplicated from `dev.instance` on purpose: this tool must import nothing from
# the app package, so it runs under any Python, not just the app's venv.
DEV_DIR = Path(__file__).resolve().parent
REPO_DIR = Path(__file__).resolve().parents[2]
INSTANCES_DIR = DEV_DIR / ".instances"
LEGACY_DISCOVERY_PATH = DEV_DIR / ".dev.json"

_LIST_HEADERS = ("ID", "LABEL", "BRANCH", "PID", "VITE", "CONTROL", "LOADED", "AGE")


class _NotStarted(SystemExit):
    """No live instance yet.

    `wait` retries this, because the window it targets may still be starting;
    every other command reports it exactly like a plain SystemExit.
    """


def _checkout_paths(root: Path) -> tuple[Path, Path]:
    """One checkout's per-instance dir and its pre-instance discovery file."""
    dev_dir = root / "app" / "dev"
    return dev_dir / ".instances", dev_dir / ".dev.json"


def _belongs(info: dict, root: Path) -> bool:
    """True when a record claims `root`, so a moved file is not mistaken for one.

    `checkout` and `worktree` both name a repo root; accept either, and accept a
    record that names neither so an older payload still resolves here.
    """
    target = os.path.normcase(str(root))
    named = False
    for key in ("checkout", "worktree"):
        value = info.get(key)
        if value:
            named = True
            if os.path.normcase(str(value)) == target:
                return True
    return not named


def _records(root: Path) -> list[tuple[dict, Path]]:
    """Every readable discovery record in one checkout's own dirs, live or stale."""
    instances_dir, legacy = _checkout_paths(root)
    paths = list(instances_dir.glob("*.json")) if instances_dir.is_dir() else []
    if legacy.is_file():
        paths.append(legacy)
    records: list[tuple[dict, Path]] = []
    for path in paths:
        try:
            info = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(info, dict) and info.get("instance"):
            records.append((info, path))
    return records


def _foreign_roots(root: Path) -> list[str]:
    """Other checkouts named by records sitting in this checkout's dirs."""
    names: list[str] = []
    for info, _ in _records(root):
        if _belongs(info, root):
            continue
        for key in ("worktree", "checkout"):
            value = info.get(key)
            if value and value not in names:
                names.append(value)
                break
    return names


def _health(info: dict) -> dict | None:
    """The instance's live /health, or None when its recorded pid no longer answers.

    A live record needs both: the control port answers, and it reports the same
    pid. That rules out a leftover file and a pid the OS has since reused.
    """
    port = info.get("controlPort")
    if not isinstance(port, int):
        return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.5) as response:
            health = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None
    return health if health.get("pid") == info.get("pid") else None


def _scan(root: Path) -> tuple[list[dict], list[dict]]:
    """One checkout's records, split into live and dead, deduped by instance id."""
    live: list[dict] = []
    stale: list[dict] = []
    seen: set[str] = set()
    for info, path in _records(root):
        if not _belongs(info, root):
            continue
        info["_file"] = str(path)
        ident = str(info.get("instance"))
        if ident in seen:
            continue
        health = _health(info)
        if health is None:
            stale.append(info)
            continue
        seen.add(ident)
        info["_health"] = health
        live.append(info)
    return live, stale


def _summary(info: dict) -> str:
    label = info.get("label") or "-"
    branch = info.get("branch") or "-"
    return (
        f"label={label!r} branch={branch} vite={info.get('vitePort')} "
        f"control={info.get('controlPort')} pid={info.get('pid')}"
    )


def _pick(root: Path, instance: str) -> dict:
    live = _scan(root)[0]
    for info in live:
        if str(info.get("instance")) == instance:
            return info
    listing = "\n".join(f"    -i {info.get('instance')}  {_summary(info)}" for info in live)
    detail = f"\nLive instances there:\n{listing}" if listing else "\nNo instances are live there."
    raise _NotStarted(f"No live dev instance {instance!r} for {root}.{detail}")


def _multiple(live: list[dict]) -> str:
    listing = "\n".join(f"    -i {info.get('instance')}  {_summary(info)}" for info in live)
    return (
        f"{len(live)} live dev instances for this checkout. A command must never drive "
        f"the wrong window, so name one:\n{listing}"
    )


def _resolve(instance: str | None, checkout: str | None) -> dict:
    """Pick the target instance, refusing rather than guessing at every fork."""
    if checkout:
        root = Path(checkout).expanduser().resolve()
        if not instance:
            live = _scan(root)[0]
            choices = " ".join(f"-i {info.get('instance')}" for info in live)
            hint = f" Live there: {choices}" if choices else " No instances are live there."
            raise SystemExit(
                "-c/--checkout targets another checkout, so it needs -i/--instance; "
                f"picking one for you could drive the wrong window.{hint}"
            )
        return _pick(root, instance)
    if instance:
        return _pick(REPO_DIR, instance)
    from_env = os.environ.get("YTM_INSTANCE", "").strip()
    live = _scan(REPO_DIR)[0]
    if from_env:
        for info in live:
            if str(info.get("instance")) == from_env:
                return info
    if len(live) == 1:
        return live[0]
    if not live:
        foreign = _foreign_roots(REPO_DIR)
        if foreign:
            # A record here that names another checkout is the old shared
            # `.dev.json` case. Refuse loudly; `-c` is the only way past it.
            others = ", ".join(foreign)
            raise SystemExit(
                f"Discovery file(s) here belong to another checkout ({others}). "
                f"Driving one is deliberate: add -c <path> -i <id>. "
                f"Start this one with .\\start.ps1"
            )
        raise _NotStarted(f"No running dev instance ({INSTANCES_DIR}). Start one with .\\start.ps1")
    raise SystemExit(_multiple(live))


def _base_url(args) -> str:
    info = _resolve(getattr(args, "instance", None), getattr(args, "checkout", None))
    return f"http://127.0.0.1:{info['controlPort']}"


def _request(base: str, method: str, route: str, body: dict | None = None, timeout: float = 60.0):
    url = base + route
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise SystemExit(f"HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Cannot reach the dev instance at {url}: {error.reason}") from error


def _print(value) -> None:
    print(json.dumps(value, indent=2, default=str))


def _human_age(started_at) -> str:
    try:
        seconds = max(0, int(time.time() - float(started_at)))
    except (TypeError, ValueError):
        return "-"
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h{(seconds % 3600) // 60:02d}m"
    return f"{seconds // 86400}d{(seconds % 86400) // 3600}h"


def _table_row(info: dict) -> tuple[str, ...]:
    health = info.get("_health") or {}
    loaded = health.get("loaded", info.get("loaded"))
    return (
        str(info.get("instance", "?")),
        str(info.get("label") or "-"),
        str(info.get("branch") or "-"),
        str(info.get("pid", "-")),
        str(info.get("vitePort", "-")),
        str(info.get("controlPort", "-")),
        "yes" if loaded else "no",
        _human_age(info.get("startedAt")),
    )


def _table(headers: tuple[str, ...], rows: list[tuple[str, ...]]) -> str:
    widths = [len(head) for head in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))
    lines = ["  ".join(head.ljust(widths[index]) for index, head in enumerate(headers))]
    lines.append("  ".join("-" * width for width in widths))
    lines.extend(
        "  ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)) for row in rows
    )
    return "\n".join(lines)


def _worktree_roots() -> list[Path]:
    """Every checkout `git worktree list` reports, this one first."""
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_DIR), "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return [REPO_DIR]
    roots: list[Path] = []
    seen: set[str] = set()
    for line in result.stdout.splitlines():
        if not line.startswith("worktree "):
            continue
        root = Path(line[len("worktree ") :].strip())
        key = os.path.normcase(str(root))
        if key not in seen:
            seen.add(key)
            roots.append(root)
    if os.path.normcase(str(REPO_DIR)) not in seen:
        roots.insert(0, REPO_DIR)
    return roots


def _scan_roots(args) -> list[Path]:
    checkout = getattr(args, "checkout", None)
    if checkout:
        return [Path(checkout).expanduser().resolve()]
    if args.worktrees:
        return _worktree_roots()
    return [REPO_DIR]


def _prune(stale: list[dict], live_ids: set[str]) -> None:
    """Delete dead discovery files. A file for a live id is a sibling, not litter."""
    for info in stale:
        ident = str(info.get("instance"))
        if ident in live_ids:
            continue
        path = info.get("_file")
        try:
            Path(str(path)).unlink()
        except OSError as error:
            print(f"Could not prune {path}: {error}")
            continue
        print(f"Pruned {path}")


def _cmd_list(args) -> None:
    roots = _scan_roots(args)
    wanted = getattr(args, "instance", None)
    for index, root in enumerate(roots):
        live, stale = _scan(root)
        if args.prune:
            _prune(stale, {str(info.get("instance")) for info in live})
        shown = [info for info in live if not wanted or str(info.get("instance")) == wanted]
        if len(roots) > 1:
            if index:
                print()
            print(f"{root}")
        if shown:
            print(_table(_LIST_HEADERS, [_table_row(info) for info in shown]))
        else:
            print(f"No live dev instances for {root}.")


def _cmd_health(args) -> None:
    _print(_request(args.base, "GET", "/health"))


def _cmd_wait(args) -> None:
    """Block until the target instance has loaded its page.

    The target is resolved on every pass, not once, so this can be run the
    moment `start.ps1` returns: the control server writes its discovery file
    partway through startup, and until then there is nothing to address.
    """
    deadline = time.monotonic() + args.timeout
    last = ""
    while time.monotonic() < deadline:
        try:
            base = args.base or _base_url(args)
        except _NotStarted as error:
            last = str(error)
            time.sleep(0.5)
            continue
        try:
            health = _request(base, "GET", "/health", timeout=2.0)
        except SystemExit:
            time.sleep(0.5)
            continue
        if health.get("loaded"):
            _print(health)
            return
        time.sleep(0.5)
    detail = f" Last: {last}" if last else ""
    raise SystemExit(f"Page did not finish loading within {args.timeout:.0f}s.{detail}")


def _cmd_call(args) -> None:
    if args.json_file:
        try:
            values = json.loads(Path(args.json_file).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit(f"Could not read {args.json_file}: {error}") from error
    elif args.json:
        try:
            values = json.loads(args.json)
        except json.JSONDecodeError as error:
            raise SystemExit(f"Arguments are not JSON: {error}") from error
    else:
        # Raw strings. PowerShell strips double quotes on the way to a native
        # command, so plain arguments avoid the quoting trap entirely.
        values = list(args.arguments)
    if not isinstance(values, list):
        raise SystemExit("Arguments must be a JSON list or plain values")
    _print(_request(args.base, "POST", "/call", {"method": args.method, "args": values}))


def _cmd_eval(args) -> None:
    _print(_request(args.base, "POST", "/eval", {"expression": args.expression}))


def _cmd_logs(args) -> None:
    query = f"?level={args.level}&limit={args.limit}"
    _print(_request(args.base, "GET", f"/logs{query}"))


def _cmd_screenshot(args) -> None:
    query = f"?path={urllib.parse.quote(args.path)}" if args.path else ""
    _print(_request(args.base, "GET", f"/screenshot{query}"))


def _cmd_stop(args) -> None:
    """Ask the instance to close its window, which ends the process cleanly."""
    _print(_request(args.base, "POST", "/stop"))


def main(argv: list[str] | None = None) -> int:
    # On a parent as well as each subcommand, so `-i` works before or after the
    # verb: `cli.py -i a health` and `cli.py health -i a` behave the same.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "-i", "--instance", default=argparse.SUPPRESS, metavar="ID",
        help="instance id (default: YTM_INSTANCE, else the only live one)",
    )
    common.add_argument(
        "-c", "--checkout", default=argparse.SUPPRESS, metavar="PATH",
        help="another checkout's instances; requires -i",
    )

    parser = argparse.ArgumentParser(
        prog="dev.cli", description="Drive a running dev instance.", parents=[common]
    )
    sub = parser.add_subparsers(dest="command", required=True)

    listing = sub.add_parser(
        "list", aliases=["ls"], parents=[common], help="list live instances for this checkout"
    )
    listing.add_argument("--worktrees", action="store_true", help="scan every git worktree checkout")
    listing.add_argument("--prune", action="store_true", help="delete dead discovery files")
    listing.set_defaults(func=_cmd_list)

    sub.add_parser(
        "health", parents=[common], help="pid, ports, and whether the page loaded"
    ).set_defaults(func=_cmd_health)

    wait = sub.add_parser("wait", parents=[common], help="block until the page has loaded")
    wait.add_argument("--timeout", type=float, default=90.0)
    wait.set_defaults(func=_cmd_wait)

    call = sub.add_parser("call", parents=[common], help="call a public Python API method")
    call.add_argument("method")
    call.add_argument("arguments", nargs="*", help="plain string arguments")
    call.add_argument("--json", default="", help="arguments as a JSON list")
    call.add_argument("--json-file", default="", help="path to a file holding a JSON list")
    call.set_defaults(func=_cmd_call)

    evaluate = sub.add_parser("eval", parents=[common], help="run JavaScript in the page")
    evaluate.add_argument("expression")
    evaluate.set_defaults(func=_cmd_eval)

    logs = sub.add_parser("logs", parents=[common], help="Python, renderer, and Vite logs")
    logs.add_argument("--level", default="", help="debug, info, warning, error")
    logs.add_argument("--limit", type=int, default=200)
    logs.set_defaults(func=_cmd_logs)

    shot = sub.add_parser("screenshot", parents=[common], help="capture the window to a PNG")
    shot.add_argument("path", nargs="?", default="")
    shot.set_defaults(func=_cmd_screenshot)

    stop = sub.add_parser("stop", parents=[common], help="close the running instance")
    stop.set_defaults(func=_cmd_stop)

    args = parser.parse_args(argv)
    if args.func is _cmd_list:
        args.func(args)
        return 0
    # `wait` resolves its target inside its own retry loop, so it can be run
    # before the instance it names has finished starting.
    args.base = None if args.func is _cmd_wait else _base_url(args)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
