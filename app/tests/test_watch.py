"""The watcher's restart log. It writes to a tmp file, not the checkout."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dev import watch


@pytest.fixture
def log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "restarts.jsonl"
    monkeypatch.setattr(watch, "RESTART_LOG", path)
    return path


def test_append_restart_log_records_one_json_line(log: Path) -> None:
    """A crash here used to be invisible: it killed the watcher on start."""
    watch.append_restart_log("start", 3, ["app/main.py"], 4321)
    watch.append_restart_log("exit", 3, ["app/main.py"], 4321, 0)

    records = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert [record["event"] for record in records] == ["start", "exit"]
    first = records[0]
    assert first["generation"] == 3
    assert first["files"] == ["app/main.py"]
    assert first["pid"] == 4321
    assert isinstance(first["slot"], int)
    assert "code" not in first
    assert records[1]["code"] == 0
