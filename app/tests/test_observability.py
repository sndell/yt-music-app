"""The dev-only log ring buffers behind the probe's /logs and /state."""

import logging

from dev.observability import MAX_TEXT, PythonLogRing, RendererLog


class TestPythonLogRing:
    def test_records_and_filters_by_level(self) -> None:
        ring = PythonLogRing(maxlen=10)
        logger = logging.getLogger("tests.python_ring")
        logger.handlers = [ring]
        logger.setLevel(logging.DEBUG)
        logger.propagate = False

        logger.info("hello")
        logger.error("boom")

        assert [entry["message"] for entry in ring.snapshot()] == ["hello", "boom"]
        assert [entry["message"] for entry in ring.snapshot(level="error")] == ["boom"]

    def test_keeps_only_the_most_recent(self) -> None:
        ring = PythonLogRing(maxlen=3)
        logger = logging.getLogger("tests.python_ring_small")
        logger.handlers = [ring]
        logger.setLevel(logging.INFO)
        logger.propagate = False

        for index in range(5):
            logger.info("line %d", index)

        assert [entry["message"] for entry in ring.snapshot()] == ["line 2", "line 3", "line 4"]


class TestRendererLog:
    def test_accepts_a_batch_and_reports_the_last_error(self) -> None:
        log = RendererLog(maxlen=10)
        log.add(
            {
                "entries": [
                    {"level": "info", "message": "a"},
                    {"level": "error", "message": "bad"},
                ]
            }
        )
        assert [entry["message"] for entry in log.snapshot()] == ["a", "bad"]
        last_error = log.last_error()
        assert last_error is not None and last_error["message"] == "bad"
        assert [entry["message"] for entry in log.snapshot(level="error")] == ["bad"]

    def test_clips_long_messages_and_unknown_levels(self) -> None:
        log = RendererLog(maxlen=10)
        log.add({"level": "shout", "message": "x" * (MAX_TEXT + 500)})
        entry = log.snapshot()[0]
        assert len(entry["message"]) <= MAX_TEXT
        assert entry["level"] == "info"
