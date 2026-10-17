"""Fail on the half-applied changes the agent notes used to only describe.

Static: reads files, imports nothing from the app, touches no cache and no
network. Prints one line per problem and exits 1. ``--report`` prints the same
list and exits 0, for the first look before a rule is enforced.

What it checks:
  * the generated TypeScript is current with the Python declarations
  * the media-key actions Python dispatches equal the actions the UI handles
  * only the transport and the dev log forwarder touch window.pywebview

The API contract itself is generated now, so a name or an argument count cannot
drift; ``app/dev/contract.py --check`` is what proves it.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

MEDIA_CONTROLS = ROOT / "app/util/media_controls.py"
APP_EVENTS = ROOT / "ui/src/features/player/lib/appEvents.ts"
UI_SRC = ROOT / "ui/src"

# window.pywebview belongs to the transport; the dev log forwarder is the one
# other caller, and both are named here so a new direct use fails the check.
PYWEBVIEW_ALLOWED = {
    "ui/src/lib/api/transport.ts",
    "ui/src/dev/rendererLog.ts",
    "ui/src/types/webview.d.ts",
}

PY_EVENT_LITERAL = re.compile(r'"([a-z]+)"')


def generated() -> list[str]:
    """The generator proves the TypeScript matches the Python declarations."""
    result = subprocess.run(
        [sys.executable, str(ROOT / "app/dev/contract.py"), "--check"],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode == 0:
        return []
    detail = (result.stdout or "").strip() or (result.stderr or "").strip()
    return detail.splitlines() or ["app/dev/contract.py --check failed"]


def python_events() -> set[str]:
    text = MEDIA_CONTROLS.read_text(encoding="utf-8")
    match = re.search(r"_COMMANDS\s*=\s*\{([^}]*)\}", text)
    if not match:
        raise SystemExit("no _COMMANDS dict in app/util/media_controls.py")
    return set(PY_EVENT_LITERAL.findall(match.group(1)))


def ui_events() -> set[str]:
    if not APP_EVENTS.exists():
        return set()
    return set(PY_EVENT_LITERAL.findall(APP_EVENTS.read_text(encoding="utf-8")))


def pywebview_uses() -> list[str]:
    found: list[str] = []
    for path in sorted(UI_SRC.rglob("*.ts*")):
        rel = path.relative_to(ROOT).as_posix()
        if rel in PYWEBVIEW_ALLOWED:
            continue
        if "window.pywebview" in path.read_text(encoding="utf-8"):
            found.append(rel)
    return found


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", action="store_true", help="print problems, always exit 0")
    args = parser.parse_args(argv)

    problems: list[str] = []

    problems.extend(generated())

    dispatched = python_events()
    handled = ui_events()
    if not APP_EVENTS.exists():
        problems.append("ui/src/features/player/lib/appEvents.ts: missing")
    elif dispatched != handled:
        problems.append(f"events: Python dispatches {sorted(dispatched)}, the UI handles {sorted(handled)}")

    for rel in pywebview_uses():
        problems.append(f"{rel}: uses window.pywebview directly; go through PyBridge")

    if problems:
        print(f"checks: {len(problems)} problem(s)")
        for line in problems:
            print(f"  {line}")
        return 0 if args.report else 1
    print("checks: generated contract, events and pywebview use all agree")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
