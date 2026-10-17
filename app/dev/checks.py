"""Fail on the half-applied changes the agent notes used to only describe.

Static: reads files, imports nothing from the app, touches no cache and no
network. Prints one line per problem and exits 1. ``--report`` prints the same
list and exits 0, for the first look before a rule is enforced.

What it checks:
  * every ApiMethods entry has a public Python method and a PyBridge wrapper,
    with the same number of required and optional arguments
  * every public method on MusicApi and Api is either in the contract or a
    named dev method
  * the media-key actions Python dispatches equal the actions the UI handles
  * only the transport and the dev log forwarder touch window.pywebview
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

MUSIC_API = ROOT / "app/features/music_api.py"
MAIN = ROOT / "app/main.py"
TYPES = ROOT / "ui/src/lib/api/types.ts"
BRIDGE = ROOT / "ui/src/lib/api/bridge.ts"
MEDIA_CONTROLS = ROOT / "app/util/media_controls.py"
APP_EVENTS = ROOT / "ui/src/features/player/lib/appEvents.ts"
UI_SRC = ROOT / "ui/src"

# pywebview exposes these, and they are deliberately outside the UI contract.
DEV_METHODS = {"dev_log"}

# window.pywebview belongs to the transport; the dev log forwarder is the one
# other caller, and both are named here so a new direct use fails the check.
PYWEBVIEW_ALLOWED = {
    "ui/src/lib/api/bridge.ts",
    "ui/src/dev/rendererLog.ts",
    "ui/src/types/webview.d.ts",
}

CONTRACT_BLOCK = re.compile(r"export interface ApiMethods \{(.*?)\n\}", re.S)
BRIDGE_CALL = re.compile(r'callPython\(\s*"([a-z_][a-z0-9_]*)"')
PY_EVENT_LITERAL = re.compile(r'"([a-z]+)"')


def _split_top_level(text: str) -> list[str]:
    """Split on commas that are not inside brackets; drop empty segments."""
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    for char in text:
        if char in "([{<":
            depth += 1
        elif char in ")]}>":
            depth -= 1
        if char == "," and depth == 0:
            parts.append("".join(current))
            current = []
            continue
        current.append(char)
    parts.append("".join(current))
    return [part.strip() for part in parts if part.strip()]


def _count_args(text: str) -> int:
    return len(_split_top_level(text))


def _optional_args(text: str) -> int:
    return sum(1 for part in _split_top_level(text) if "?" in part.split(":")[0])


def _match_bracket(text: str, start: int) -> int:
    """Index just past the bracket pair that starts at ``start``."""
    depth = 0
    for index in range(start, len(text)):
        if text[index] in "([{":
            depth += 1
        elif text[index] in ")]}":
            depth -= 1
            if depth == 0:
                return index + 1
    raise ValueError("unbalanced brackets")


def python_surface() -> dict[str, tuple[int, int]]:
    """Public API methods mapped to (required args, optional args)."""
    surface: dict[str, tuple[int, int]] = {}
    for path, class_name in ((MUSIC_API, "MusicApi"), (MAIN, "Api")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef) or node.name != class_name:
                continue
            for item in node.body:
                if not isinstance(item, ast.FunctionDef) or item.name.startswith("_"):
                    continue
                decorators = {getattr(d, "id", getattr(d, "attr", "")) for d in item.decorator_list}
                if "property" in decorators or "setter" in decorators:
                    continue
                positional = list(item.args.posonlyargs) + list(item.args.args)
                if positional and positional[0].arg == "self":
                    positional = positional[1:]
                required = len(positional) - len(item.args.defaults)
                surface[item.name] = (required, len(item.args.defaults))
    return surface


def ts_contract() -> dict[str, tuple[int, int]]:
    """ApiMethods entries mapped to (required params, optional params)."""
    block = CONTRACT_BLOCK.search(TYPES.read_text(encoding="utf-8"))
    if not block:
        raise SystemExit("no ApiMethods interface in ui/src/lib/api/types.ts")
    body = block.group(1)
    contract: dict[str, tuple[int, int]] = {}
    depth = 0
    index = 0
    while index < len(body):
        if depth == 0:
            match = re.compile(r"\s*([a-z_][a-z0-9_]*)\s*:\s*\{").match(body, index)
            if match:
                entry_end = _match_bracket(body, match.end() - 1)
                entry = body[match.end() : entry_end - 1]
                params = re.search(r"params\s*:\s*\[", entry)
                if params:
                    params_end = _match_bracket(entry, params.end() - 1)
                    inner = entry[params.end() : params_end - 1]
                    contract[match.group(1)] = (_count_args(inner) - _optional_args(inner), _optional_args(inner))
                index = entry_end
                continue
        char = body[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        index += 1
    return contract


def bridge_surface() -> dict[str, int]:
    """PyBridge wrappers mapped to the argument count they pass on."""
    text = BRIDGE.read_text(encoding="utf-8")
    bridge: dict[str, int] = {}
    for match in BRIDGE_CALL.finditer(text):
        open_paren = text.index("(", match.start())
        end = _match_bracket(text, open_paren)
        tail = text[match.end() : end - 1].lstrip(" ,")
        bridge[match.group(1)] = _count_args(tail)
    return bridge


def _bridge_range(python_method: tuple[int, int] | None, contract: tuple[int, int]) -> tuple[int, int]:
    """Argument counts the wrapper may pass: inside Python's and TS's ranges."""
    required_ts, optional_ts = contract
    if python_method is None:
        return required_ts, required_ts + optional_ts
    required_py, optional_py = python_method
    return max(required_ts, required_py), min(required_ts + optional_ts, required_py + optional_py)


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

    python_methods = python_surface()
    contract = ts_contract()
    bridge = bridge_surface()

    for name in sorted(contract):
        if name not in python_methods:
            problems.append(f"{name}: in ApiMethods, no public method on MusicApi or Api")
        if name not in bridge:
            problems.append(f"{name}: in ApiMethods, no PyBridge wrapper")
    for name in sorted(python_methods):
        if name not in contract and name not in DEV_METHODS:
            problems.append(f"{name}: public on the API classes, absent from ApiMethods")
    for name in sorted(bridge):
        if name not in contract:
            problems.append(f"{name}: PyBridge wrapper for a method not in ApiMethods")
            continue
        low, high = _bridge_range(python_methods.get(name), contract[name])
        if not low <= bridge[name] <= high:
            problems.append(
                f"{name}: PyBridge passes {bridge[name]} args; the contract allows {low} to {high}"
            )
    for name in sorted(set(contract) & set(python_methods)):
        required_py, optional_py = python_methods[name]
        required_ts, optional_ts = contract[name]
        if required_py + optional_py != required_ts + optional_ts:
            problems.append(
                f"{name}: Python takes {required_py + optional_py} args, ApiMethods declares "
                f"{required_ts + optional_ts}"
            )
        elif required_ts < required_py:
            # The TS side must not let a caller omit an argument Python requires.
            problems.append(
                f"{name}: ApiMethods marks {required_ts} required, Python requires {required_py}"
            )
    for name in sorted(DEV_METHODS):
        if name in contract:
            problems.append(f"{name}: a dev method, but it is declared in ApiMethods")

    dispatched = python_events()
    handled = ui_events()
    if not APP_EVENTS.exists():
        problems.append("ui/src/features/player/lib/appEvents.ts: missing")
    elif dispatched != handled:
        problems.append(
            f"events: Python dispatches {sorted(dispatched)}, the UI handles {sorted(handled)}"
        )

    for rel in pywebview_uses():
        problems.append(f"{rel}: uses window.pywebview directly; go through PyBridge")

    if problems:
        print(f"checks: {len(problems)} problem(s)")
        for line in problems:
            print(f"  {line}")
        return 0 if args.report else 1
    print("checks: api, events and pywebview use all agree")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
