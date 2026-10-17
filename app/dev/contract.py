"""Generate the TypeScript API surface from the Python declarations.

    python app\\dev\\contract.py            write the generated files
    python app\\dev\\contract.py --check    exit 1 when a file is stale

Stdlib only on purpose, the same bet ``app/dev/cli.py`` makes, so any python on
PATH runs it. It parses the declarations; it does not import the app, so no
ytmusicapi, no window, no cache.

The generator writes:
  ui/src/lib/api/generated/methods.ts   ApiMethods, ApiParams, ApiResponse, InternalMethods
  ui/src/lib/api/generated/bridge.ts    PyBridge, one wrapper per shipped method
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "MusicApi": ROOT / "app/features/music_api.py",
    "Api": ROOT / "app/main.py",
}
PINNED = {
    "PlaylistPrivacy",
    "LikeStatus",
    "SearchFilter",
    "SearchScope",
    "PlaylistItemRef",
    "PlaylistPatch",
    "DevLogEntry",
}
OWN_NAMES = {"ApiMethods", "ApiMethodName", "ApiParams", "ApiResponse", "InternalMethods"}
GENERATED_DIR = ROOT / "ui/src/lib/api/generated"
METHODS_TS = GENERATED_DIR / "methods.ts"
BRIDGE_TS = GENERATED_DIR / "bridge.ts"

SIMPLE_TYPES = {"str": "string", "int": "number", "float": "number", "bool": "boolean", "Any": "unknown"}


class ContractError(Exception):
    """The generator cannot express something; the message names the site."""


@dataclass
class Param:
    name: str
    ts_type: str
    optional: bool
    default: str | None


@dataclass
class Method:
    name: str
    ts_name: str
    access: str
    returns: str
    params: list[Param]
    cache: str | None
    dev_only: bool
    reason: str
    owner: str
    doc: str
    index: int = field(default=0)


def _annotation(node: ast.expr | None, where: str) -> str:
    if node is None:
        raise ContractError(f"{where}: no annotation")
    if isinstance(node, ast.Name):
        if node.id in SIMPLE_TYPES:
            return SIMPLE_TYPES[node.id]
        if node.id in PINNED:
            return node.id
        raise ContractError(f"{where}: {node.id} is not a known type; add it to the declaration")
    if isinstance(node, ast.Constant) and node.value is None:
        return "null"
    if isinstance(node, ast.Subscript):
        outer = node.value
        if isinstance(outer, ast.Name) and outer.id == "list":
            return f"{_annotation(node.slice, where)}[]"
        if isinstance(outer, ast.Name) and outer.id == "dict":
            slice_value = node.slice
            if isinstance(slice_value, ast.Tuple) and len(slice_value.elts) == 2:
                return f"Record<string, {_annotation(slice_value.elts[1], where)}>"
        raise ContractError(f"{where}: unsupported subscript {ast.dump(node)[:60]}")
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        left = _annotation(node.left, where)
        right = _annotation(node.right, where)
        return f"{left} | {right}"
    raise ContractError(f"{where}: unsupported annotation {ast.dump(node)[:60]}")


def _module_constants(tree: ast.Module) -> dict[str, str]:
    """Simple module-level literals, so a default like `= LIMIT` still renders."""
    constants: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        try:
            constants[target.id] = _literal(node.value)
        except ContractError:
            continue
    return constants


def _literal(node: ast.expr) -> str:
    if isinstance(node, ast.Constant):
        value = node.value
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return json.dumps(value)
    raise ContractError(f"not a literal: {ast.dump(node)[:60]}")


def _default_literal(node: ast.expr, where: str, constants: dict[str, str]) -> str:
    if isinstance(node, ast.Name) and node.id in constants:
        return constants[node.id]
    try:
        return _literal(node)
    except ContractError as exc:
        raise ContractError(f"{where}: default is not a literal ({exc})") from exc


def _spec_keywords(node: ast.FunctionDef, where: str) -> tuple[str, dict[str, object]] | None:
    """(access, keywords) for the one api decorator on this function."""
    for decorator in node.decorator_list:
        if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
            continue
        if getattr(decorator.func.value, "id", "") != "api":
            continue
        access = decorator.func.attr
        if access not in {"read", "write", "internal"}:
            continue
        values: dict[str, object] = {}
        for keyword in decorator.keywords:
            if keyword.arg is None:
                raise ContractError(f"{where}: **kwargs is not allowed")
            try:
                values[keyword.arg] = ast.literal_eval(keyword.value)
            except ValueError as exc:
                raise ContractError(f"{where}: {keyword.arg}= must be a literal ({exc})") from exc
        return access, values
    return None


def _doc(node: ast.FunctionDef) -> str:
    text = ast.get_docstring(node) or ""
    return text.strip().splitlines()[0].strip() if text.strip() else ""


def methods() -> list[Method]:
    out: list[Method] = []
    index = 0
    for owner, path in SOURCES.items():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        constants = _module_constants(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef) or node.name != owner:
                continue
            for item in node.body:
                if not isinstance(item, ast.FunctionDef) or item.name.startswith("_"):
                    continue
                where = f"{path.name}:{item.name}"
                found = _spec_keywords(item, where)
                if found is None:
                    raise ContractError(
                        f"{where}: public but undeclared. Add @api.read, @api.write or "
                        "@api.internal, or start the name with _."
                    )
                access, values = found
                returns = values.get("returns")
                if not isinstance(returns, str):
                    raise ContractError(f"{where}: returns= is required and must be a type text")
                overrides = values.get("params") or {}
                if not isinstance(overrides, dict):
                    raise ContractError(f"{where}: params= must be a dict of type texts")
                ts_name = values.get("ts_name") or _camel(item.name)
                args = list(item.args.posonlyargs) + list(item.args.args)
                if args and args[0].arg == "self":
                    args = args[1:]
                if item.args.vararg or item.args.kwarg or item.args.kwonlyargs:
                    raise ContractError(f"{where}: only positional parameters are allowed")
                defaults = [None] * (len(args) - len(item.args.defaults)) + list(item.args.defaults)
                params: list[Param] = []
                for arg, default in zip(args, defaults):
                    key = _camel(arg.arg)
                    if key in overrides:
                        ts_type = str(overrides[key])
                    else:
                        ts_type = _annotation(arg.annotation, f"{where}.{arg.arg}")
                    optional = default is not None
                    literal = None
                    if default is not None:
                        literal = _default_literal(default, f"{where}.{arg.arg}", constants)
                        if literal == "null" and "null" not in ts_type:
                            ts_type = f"{ts_type} | null"
                    params.append(Param(key, ts_type, optional, literal))
                index += 1
                out.append(
                    Method(
                        name=item.name,
                        ts_name=ts_name,
                        access=access,
                        returns=returns,
                        params=params,
                        cache=values.get("cache") if isinstance(values.get("cache"), str) else None,
                        dev_only=bool(values.get("dev_only", False)),
                        reason=str(values.get("reason", "")),
                        owner=owner,
                        doc=_doc(item),
                        index=index,
                    )
                )
    return out


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


HEADER = (
    "// GENERATED by app/dev/contract.py from the declarations in\n"
    "// app/features/music_api.py and app/main.py. Do not edit.\n"
    "// Regenerate: python app\\dev\\contract.py\n"
)


def render_methods(items: list[Method]) -> str:
    shipped = [item for item in items if item.access != "internal"]
    internal = [item for item in items if item.access == "internal"]
    body: list[str] = []
    body.append("export interface ApiMethods {")
    for item in shipped:
        signature = ", ".join(f"{param.name}{'?' if param.optional else ''}: {param.ts_type}" for param in item.params)
        if item.doc:
            body.append(f"  /** {item.doc} */")
        body.append(f"  {item.name}: {{ params: [{signature}]; response: {item.returns} }};")
    body.append("}")
    body.append("")
    body.append("export type ApiMethodName = keyof ApiMethods;")
    body.append('export type ApiParams<M extends ApiMethodName> = ApiMethods[M]["params"];')
    body.append('export type ApiResponse<M extends ApiMethodName> = ApiMethods[M]["response"];')
    if internal:
        body.append("")
        body.append("/** Reachable from the page, deliberately outside the UI contract. */")
        body.append("export interface InternalMethods {")
        for item in internal:
            signature = ", ".join(f"{param.name}{'?' if param.optional else ''}: {param.ts_type}" for param in item.params)
            body.append(f"  {item.name}: {{ params: [{signature}]; response: {item.returns} }};")
        body.append("}")
    body.append("")
    text = "\n".join(body)
    return HEADER + "\n" + _type_imports(text) + text


def _exported_names() -> list[str]:
    """Type names ui/src/lib/api/types.ts exports, which generated text may use."""
    text = (ROOT / "ui/src/lib/api/types.ts").read_text(encoding="utf-8")
    names = set(re.findall(r"export (?:interface|type) ([A-Za-z][A-Za-z0-9_]*)", text))
    return sorted(names - OWN_NAMES)


def _type_imports(text: str) -> str:
    """One import for the hand-written shapes this generated text refers to.

    Comment lines are skipped, so a doc sentence that happens to name a type
    does not pull in an unused import.
    """
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(("//", "*", "/*")))
    used = sorted(name for name in _exported_names() if re.search(rf"\b{name}\b", code))
    if not used:
        return ""
    return f'import type {{ {", ".join(used)} }} from "../types";\n\n'


def render_bridge(items: list[Method]) -> str:
    shipped = sorted((item for item in items if item.access != "internal"), key=lambda item: item.ts_name)
    body: list[str] = ['import { callPython } from "../transport";', ""]
    body.append("/** Type-safe access to every shipped Python API method. */")
    body.append("export const PyBridge = {")
    for item in shipped:
        signature = ", ".join(
            f"{param.name}: {param.ts_type}"
            + (f" = {param.default}" if param.optional and param.default is not None else "")
            + ("" if param.optional else "")
            for param in item.params
        )
        args = ", ".join(param.name for param in item.params)
        call = f'callPython("{item.name}"' + (f", {args}" if args else "") + ")"
        if item.doc:
            body.append(f"  /** {item.doc} */")
        body.append(f"  {item.ts_name}: ({signature}) => {call},")
    body.append("} as const;")
    body.append("")
    text = "\n".join(body)
    return HEADER + "\n" + _type_imports(text) + text


def write(path: Path, text: str, check: bool) -> bool:
    current = path.read_text(encoding="utf-8") if path.exists() else ""
    if current == text:
        return True
    if check:
        print(f"stale: {path.relative_to(ROOT)}")
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote: {path.relative_to(ROOT)}")
    return True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    try:
        items = methods()
    except ContractError as exc:
        print(f"contract: {exc}")
        return 1
    names = [item.name for item in items]
    duplicates = {name for name in names if names.count(name) > 1}
    if duplicates:
        print(f"contract: declared twice: {sorted(duplicates)}")
        return 1
    print(f"contract: {len(items)} methods ({sum(1 for i in items if i.access == 'write')} writes)")
    ok = True
    ok &= write(METHODS_TS, render_methods(items), args.check)
    ok &= write(BRIDGE_TS, render_bridge(items), args.check)
    if args.check and not ok:
        print("contract: regenerate with python app\\dev\\contract.py")
        return 1
    if args.check:
        print("contract: generated files are current")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
