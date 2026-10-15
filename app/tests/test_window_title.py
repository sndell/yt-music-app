"""The window title names the worktree, so parallel windows are easy to tell apart."""

import pytest

from dev import identity


@pytest.fixture(autouse=True)
def _reset_title(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(identity, "_title", None)


def test_main_checkout_keeps_the_plain_title(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(identity, "is_frozen", lambda: False)
    monkeypatch.setattr(identity, "is_linked_worktree", lambda: False)
    monkeypatch.setattr(identity, "dev_slot", lambda: 0)
    monkeypatch.setattr(identity, "ui_slot", lambda: 0)

    assert identity.window_title() == "YTMusic"


def test_worktree_uses_its_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(identity, "is_frozen", lambda: False)
    monkeypatch.setattr(identity, "is_linked_worktree", lambda: True)
    monkeypatch.setattr(identity, "_branch_name", lambda: "fix-slots")
    monkeypatch.setattr(identity, "dev_slot", lambda: 3)
    monkeypatch.setattr(identity, "ui_slot", lambda: 3)

    assert identity.window_title() == "YTMusic - fix-slots"


def test_extra_instance_adds_its_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(identity, "is_frozen", lambda: False)
    monkeypatch.setattr(identity, "is_linked_worktree", lambda: True)
    monkeypatch.setattr(identity, "_branch_name", lambda: "fix-slots")
    monkeypatch.setattr(identity, "dev_slot", lambda: 7)
    monkeypatch.setattr(identity, "ui_slot", lambda: 3)

    assert identity.window_title() == "YTMusic - fix-slots (slot 7)"


def test_frozen_keeps_the_plain_title(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(identity, "is_frozen", lambda: True)

    assert identity.window_title() == "YTMusic"
