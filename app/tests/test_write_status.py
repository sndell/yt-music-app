"""Write-status logic, including the delete case that used to report failure."""

import pytest

from features.music_api import _delete_status, _edit_status


class TestDeleteStatus:
    def test_raw_command_response_is_success(self) -> None:
        # A real successful delete returns the raw command dict: no "status" key.
        result = {"responseContext": {}, "command": {"handlePlaylistDeletionCommand": {}}}
        assert _delete_status(result) == "SUCCEEDED"

    def test_status_string_succeeded(self) -> None:
        assert _delete_status("STATUS_SUCCEEDED") == "SUCCEEDED"

    def test_failed_status_string_raises(self) -> None:
        with pytest.raises(RuntimeError):
            _delete_status("STATUS_FAILED")

    def test_empty_status_string_raises_with_fallback(self) -> None:
        with pytest.raises(RuntimeError, match="Could not delete the playlist"):
            _delete_status("")


class TestEditStatus:
    def test_succeeded_string(self) -> None:
        assert _edit_status("STATUS_SUCCEEDED", "fallback") == "STATUS_SUCCEEDED"

    def test_dict_with_succeeded(self) -> None:
        assert _edit_status({"status": "STATUS_SUCCEEDED"}, "fallback") == "STATUS_SUCCEEDED"

    def test_dict_without_succeeded_raises(self) -> None:
        with pytest.raises(RuntimeError):
            _edit_status({"status": "STATUS_FAILED"}, "Could not update the playlist")

    def test_empty_result_raises_with_fallback(self) -> None:
        with pytest.raises(RuntimeError, match="Could not update the playlist"):
            _edit_status("", "Could not update the playlist")
