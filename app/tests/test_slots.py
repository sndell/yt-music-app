"""The dev slot allocator. Offline: no git, no real ports.

Every test points the registry at a tmp_path, stubs the port probe, and
stubs the sibling-worktree scan, so nothing touches the checkout or the
machine.
"""

import json
import os
from pathlib import Path

import pytest

from dev import identity, slots

# Not a valid pid on Windows, and rejected by kill on other platforms.
DEAD_PID = 2_147_483_647


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    registry = tmp_path / "registry"
    slot_file = tmp_path / ".dev-slot"
    monkeypatch.setattr(slots, "registry_dir", lambda: registry)
    monkeypatch.setattr(slots, "port_in_use", lambda port: False)
    monkeypatch.setattr(slots, "preferred_slots", lambda: {})
    monkeypatch.setattr(slots, "SLOT_FILE", slot_file)
    monkeypatch.setattr(slots, "LEGACY_SLOT_FILES", ())
    monkeypatch.delenv("DEV_UI_SLOT", raising=False)
    return registry, slot_file


def write_claim(
    registry: Path,
    slot: int,
    *,
    checkout: str = "C:/other-checkout",
    pid: int = 0,
    role: str = "checkout",
) -> dict:
    directory = registry / "slots"
    directory.mkdir(parents=True, exist_ok=True)
    record = {
        "slot": slot,
        "checkout": checkout,
        "pid": os.getpid() if pid == 0 else pid,
        "role": role,
        "started": "2026-01-01T00:00:00+00:00",
    }
    (directory / f"{slot}.json").write_text(json.dumps(record), encoding="utf-8")
    return record


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_ports_for_offsets() -> None:
    assert slots.ports_for(0) == (8765, 5173, 9222)
    assert slots.ports_for(3) == (8768, 5176, 9225)


def test_reuses_preferred_slot_when_free(env: tuple[Path, Path]) -> None:
    registry, slot_file = env
    slot_file.write_text("3", encoding="utf-8")

    assert slots.ensure_checkout_slot() == 3
    assert slot_file.read_text(encoding="utf-8") == "3"

    claim = read_json(registry / "slots" / "3.json")
    assert claim["slot"] == 3
    assert claim["role"] == "checkout"
    assert claim["checkout"] == identity.checkout()


def test_moves_and_rewrites_when_preferred_claimed(env: tuple[Path, Path]) -> None:
    registry, slot_file = env
    slot_file.write_text("3", encoding="utf-8")
    write_claim(registry, 3, checkout="C:/other-checkout", pid=os.getpid())

    slot = slots.ensure_checkout_slot()

    assert slot == 1
    assert slot_file.read_text(encoding="utf-8") == "1"
    assert read_json(registry / "slots" / "1.json")["checkout"] == identity.checkout()
    assert read_json(registry / "slots" / "3.json")["checkout"] == "C:/other-checkout"


def test_stale_claim_is_ignored(env: tuple[Path, Path]) -> None:
    registry, slot_file = env
    slot_file.write_text("3", encoding="utf-8")
    write_claim(registry, 3, checkout="C:/gone-checkout", pid=DEAD_PID)
    assert slots._pid_alive(DEAD_PID) is False

    assert slots.ensure_checkout_slot() == 3
    assert slot_file.read_text(encoding="utf-8") == "3"
    assert read_json(registry / "slots" / "3.json")["checkout"] == identity.checkout()


def test_attaches_without_a_second_claim(env: tuple[Path, Path]) -> None:
    registry, slot_file = env
    slot_file.write_text("3", encoding="utf-8")
    existing = write_claim(registry, 5, checkout=identity.checkout(), pid=os.getpid())

    assert slots.ensure_checkout_slot() == 5

    files = sorted(path.name for path in (registry / "slots").glob("*.json"))
    assert files == ["5.json"]
    assert read_json(registry / "slots" / "5.json") == existing
    assert slot_file.read_text(encoding="utf-8") == "3"


def test_slot_free_sees_a_live_claim(env: tuple[Path, Path]) -> None:
    registry, _ = env
    write_claim(registry, 2, checkout="C:/other-checkout", pid=os.getpid())

    assert slots.slot_free(2) is False
    assert slots.slot_free(3) is True


def test_allocate_instance_slot_takes_the_first_free(env: tuple[Path, Path]) -> None:
    registry, _ = env
    write_claim(registry, 1, checkout="C:/other-checkout", pid=os.getpid())

    assert slots.allocate_instance_slot() == 2
    assert read_json(registry / "slots" / "2.json")["role"] == "instance"


def test_cli_ensure_prints_the_slot(
    env: tuple[Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    _, slot_file = env
    slot_file.write_text("2", encoding="utf-8")

    assert slots.main(["ensure"]) == 0
    assert capsys.readouterr().out.strip() == "2"


def test_worktree_without_a_slot_never_resolves_to_zero(
    env: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Slot 0 is the main checkout's ports; a worktree must never take them."""
    monkeypatch.setattr(slots, "is_linked_worktree", lambda: True)

    assert slots.resolve_checkout_slot() != 0


def test_resolve_checkout_slot_persists_without_claiming(
    env: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    registry, slot_file = env
    monkeypatch.setattr(slots, "is_linked_worktree", lambda: True)

    slot = slots.resolve_checkout_slot()

    assert slot >= 1
    assert slot_file.read_text(encoding="utf-8") == str(slot)
    # Tooling that only needs the number must not look like a live session.
    assert not (registry / "slots" / f"{slot}.json").exists()


def test_env_slot_wins_over_allocating(
    env: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, slot_file = env
    monkeypatch.setattr(slots, "is_linked_worktree", lambda: True)
    monkeypatch.setenv("DEV_UI_SLOT", "4")

    assert slots.resolve_checkout_slot() == 4
    assert slot_file.read_text(encoding="utf-8") == "4"


def test_claim_true_still_writes_a_live_claim(
    env: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    registry, _ = env
    monkeypatch.setattr(slots, "is_linked_worktree", lambda: True)

    slot = slots.ensure_checkout_slot(claim=True)

    assert (registry / "slots" / f"{slot}.json").exists()
