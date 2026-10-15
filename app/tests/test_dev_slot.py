"""tools/dev.py slot resolution, the cross-checkout guard, and worktree setup.

Each test loads tools/dev.py by path and stubs its collaborators, so nothing
binds a port, touches git, or writes into the real checkout.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parent.parent.parent
DEV_TOOL_PATH = REPO / "tools" / "dev.py"


def load_dev_tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("dev_tool", DEV_TOOL_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["dev_tool"] = module
    spec.loader.exec_module(module)
    return module


class FakeSlots:
    """Stand-in for app/dev/slots.py with the bits tools/dev.py calls."""

    def __init__(self, *, linked: bool, slot: int = 2, python: Path | None = None, main: Path | None = None) -> None:
        self.linked = linked
        self.slot = slot
        self.python = python
        self.main = main
        self.resolve_calls = 0

    def is_linked_worktree(self) -> bool:
        return self.linked

    def resolve_checkout_slot(self) -> int:
        self.resolve_calls += 1
        return self.slot

    def main_venv_python(self) -> Path | None:
        return self.python

    def main_checkout(self) -> Path | None:
        return self.main


@pytest.fixture
def devtool(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    module = load_dev_tool()
    # Never read the real slot files or environment by default.
    monkeypatch.setattr(module, "_slot_from_file", lambda: None)
    monkeypatch.delenv("DEV_SLOT", raising=False)
    monkeypatch.delenv("DEV_UI_SLOT", raising=False)
    return module


def test_worktree_without_a_slot_allocates_its_own(devtool: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeSlots(linked=True, slot=4)
    monkeypatch.setattr(devtool, "_load_slots", lambda: fake)

    assert devtool.dev_slot(None) == 4
    assert fake.resolve_calls == 1


def test_main_checkout_without_a_file_stays_zero(devtool: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeSlots(linked=False)
    monkeypatch.setattr(devtool, "_load_slots", lambda: fake)

    assert devtool.dev_slot(None) == 0
    assert fake.resolve_calls == 0


def test_explicit_slot_wins(devtool: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeSlots(linked=True, slot=4)
    monkeypatch.setattr(devtool, "_load_slots", lambda: fake)

    assert devtool.dev_slot(9) == 9
    assert fake.resolve_calls == 0


def test_env_slot_wins_over_allocating(devtool: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeSlots(linked=True, slot=4)
    monkeypatch.setattr(devtool, "_load_slots", lambda: fake)
    monkeypatch.setenv("DEV_UI_SLOT", "6")

    assert devtool.ui_slot() == 6
    assert fake.resolve_calls == 0


def test_guard_rejects_another_checkout(devtool: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(devtool, "current_checkout", lambda: "C:/mine")
    monkeypatch.setattr(devtool, "probe", lambda *a, **k: ({}, {"checkout": "C:/other"}))

    with pytest.raises(devtool.ToolError):
        devtool.guard_checkout(3)


def test_guard_allows_this_checkout(devtool: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(devtool, "current_checkout", lambda: "C:/mine")
    monkeypatch.setattr(devtool, "probe", lambda *a, **k: ({}, {"checkout": "C:/mine"}))

    devtool.guard_checkout(3)  # no raise


def test_guard_ignores_an_unreachable_probe(devtool: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    def down(*args: object, **kwargs: object) -> object:
        raise devtool.ToolError("down")

    monkeypatch.setattr(devtool, "probe", down)

    devtool.guard_checkout(3)  # no raise; the caller's own error path reports it


def test_install_ui_deps_skips_when_installed(
    devtool: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(devtool, "UI_DIR", tmp_path)
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / ".modules.yaml").write_text("ok", encoding="utf-8")

    assert devtool.install_ui_deps() is False


def test_setup_is_a_noop_in_the_main_checkout(devtool: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(devtool, "_load_slots", lambda: FakeSlots(linked=False))

    assert devtool.ensure_worktree_setup() == []


def test_setup_records_interpreter_and_auth(
    devtool: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_dir = tmp_path / "worktree" / "app"
    (app_dir / "dev").mkdir(parents=True)
    main = tmp_path / "main"
    (main / "app").mkdir(parents=True)
    (main / "app" / "browser.json").write_text("{}", encoding="utf-8")
    python = main / "app" / ".venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True)
    python.write_text("x", encoding="utf-8")

    fake = FakeSlots(linked=True, python=python, main=main)
    monkeypatch.setattr(devtool, "APP_DIR", app_dir)
    monkeypatch.setattr(devtool, "_load_slots", lambda: fake)
    monkeypatch.setattr(devtool, "install_ui_deps", lambda force=False, stream=False: False)

    done = devtool.ensure_worktree_setup()

    assert (app_dir / "dev" / ".dev-python").read_text(encoding="utf-8") == str(python)
    assert (app_dir / "browser.json").read_text(encoding="utf-8") == "{}"
    assert any("interpreter" in item for item in done)
    assert any("browser.json" in item for item in done)
