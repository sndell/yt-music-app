"""The declared API surface: one place a method's facts live.

Every public method on an `ApiSurface` subclass carries exactly one decorator:
`@api.read`, `@api.write`, or `@api.internal`. `__init_subclass__` checks that
at import time, so a method added without a declaration fails in the dev window
with its own name, and `app/dev/contract.py` generates the TypeScript from the
same declarations. Nothing about the seam is written twice.

`returns` is the TypeScript type of the response. Layer 3 replaces these strings
with declared schemas and derives the text; until then the string is the truth.
"""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass, replace
from typing import Any, Callable

logger = logging.getLogger(__name__)

READ = "read"
WRITE = "write"
INTERNAL = "internal"

# A frozen build must open even with a broken declaration; a dev window must not.
FROZEN = bool(getattr(sys, "frozen", False))


class ApiSurfaceError(Exception):
    """A public method and its declaration do not agree."""


@dataclass(frozen=True, slots=True)
class MethodSpec:
    name: str  # wire name; pywebview passes arguments positionally
    ts_name: str  # camelCase member of PyBridge
    access: str  # read | write | internal
    returns: Any  # a TypeScript type text today, a schema in layer 3
    params: dict[str, str]  # overrides for annotations the generator cannot use
    cache: str | None  # cache family label; wired in layer 4
    dev_only: bool
    reason: str  # required for internal
    owner: str  # the class that defines the method


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


def _declare(
    access: str,
    returns: Any,
    params: dict[str, str] | None,
    cache: str | None,
    ts_name: str | None,
    dev_only: bool,
    reason: str,
) -> Callable[[Any], Any]:
    def wrap(fn: Any) -> Any:
        fn._api_spec = MethodSpec(
            name=fn.__name__,
            ts_name=ts_name or camel(fn.__name__),
            access=access,
            returns=returns,
            params=dict(params or {}),
            cache=cache,
            dev_only=dev_only,
            reason=reason,
            owner="",
        )
        return fn

    return wrap


class Registry:
    """The decorators. One instance, `api`, is what methods import."""

    def read(
        self,
        returns: Any,
        *,
        cache: str | None = None,
        params: dict[str, str] | None = None,
        ts_name: str | None = None,
    ) -> Callable[[Any], Any]:
        return _declare(READ, returns, params, cache, ts_name, False, "")

    def write(
        self,
        returns: Any,
        *,
        params: dict[str, str] | None = None,
        ts_name: str | None = None,
    ) -> Callable[[Any], Any]:
        return _declare(WRITE, returns, params, None, ts_name, False, "")

    def internal(
        self,
        *,
        reason: str,
        returns: Any = None,
        params: dict[str, str] | None = None,
        ts_name: str | None = None,
        dev_only: bool = False,
    ) -> Callable[[Any], Any]:
        if not reason:
            raise ApiSurfaceError("@api.internal needs a reason")
        return _declare(INTERNAL, returns, params, None, ts_name, dev_only, reason)


api = Registry()


def _own_public_methods(cls: type) -> list[str]:
    """Public methods the class itself defines (not inherited)."""
    names: list[str] = []
    for name, value in vars(cls).items():
        if name.startswith("_") or not callable(value):
            continue
        if isinstance(value, (staticmethod, classmethod, property)):
            continue
        names.append(name)
    return names


def collect(cls: type) -> dict[str, MethodSpec]:
    """Every declared method of ``cls``, including inherited ones.

    The owner is the class that defines the function, which is what an error
    message should name.
    """
    specs: dict[str, MethodSpec] = {}
    for klass in reversed(cls.__mro__):
        for name, value in vars(klass).items():
            spec = getattr(value, "_api_spec", None)
            if spec is not None:
                specs[name] = replace(spec, owner=klass.__name__)
    return specs


def surface(cls: type, owner_names: tuple[str, ...] = ("MusicApi", "Api")) -> dict[str, MethodSpec]:
    """The declared surface, or an error naming what is missing or duplicated."""
    specs = collect(cls)
    problems: list[str] = []
    seen_ts: dict[str, str] = {}

    for klass in cls.__mro__:
        if klass.__name__ not in owner_names:
            continue
        for name in _own_public_methods(klass):
            if name not in specs:
                problems.append(
                    f"{klass.__name__}.{name} is public but undeclared. Add @api.read, "
                    "@api.write or @api.internal, or start the name with _."
                )
    for name, spec in specs.items():
        if spec.ts_name in seen_ts:
            problems.append(f"{name} and {seen_ts[spec.ts_name]} both map to PyBridge.{spec.ts_name}")
        seen_ts[spec.ts_name] = name
    if problems:
        raise ApiSurfaceError("\n".join(problems))
    return specs


class ApiSurface:
    """Base for the classes pywebview exposes."""

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        try:
            surface(cls)
        except ApiSurfaceError as exc:
            if FROZEN:
                logger.error("API surface problem: %s", exc)
            else:
                raise
