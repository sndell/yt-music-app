"""Write-status logic, including the delete case that used to report failure."""

import pytest

import features.music_api as music_api
from features.music_api import MusicApi, _delete_status, _edit_status, _playlist_contains_videos


class _FakeYTMusic:
    """Stands in for ytmusicapi's client, returning a canned edit response."""

    def __init__(self, result):
        self._result = result
        self.duplicates = None

    def add_playlist_items(self, playlist_id, videoIds=None, duplicates=False):  # noqa: N803 (ytmusicapi's name)
        self.duplicates = duplicates
        return self._result


class _FakeCache:
    def get(self, key):
        return None

    def set(self, *args, **kwargs):
        pass

    def delete(self, *args, **kwargs):
        pass


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


class TestPlaylistContainsVideos:
    def test_every_id_present(self) -> None:
        playlist = {"tracks": [{"videoId": "a"}, {"videoId": "b"}]}
        assert _playlist_contains_videos(playlist, ["a"]) is True
        assert _playlist_contains_videos(playlist, ["a", "b"]) is True

    def test_one_id_missing(self) -> None:
        playlist = {"tracks": [{"videoId": "a"}]}
        assert _playlist_contains_videos(playlist, ["a", "b"]) is False

    def test_empty_track_list_is_absent(self) -> None:
        assert _playlist_contains_videos({"tracks": []}, ["a"]) is False

    def test_unusable_payload_is_unknown(self) -> None:
        # An unusable payload means "ask YouTube again", not "absent".
        assert _playlist_contains_videos(None, ["a"]) is None
        assert _playlist_contains_videos({}, ["a"]) is None
        assert _playlist_contains_videos({"tracks": "nope"}, ["a"]) is None


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


def _api(fake: _FakeYTMusic, contains):
    """A MusicApi with the network client and duplicate check faked out."""
    api = MusicApi.__new__(MusicApi)  # bypass __init__: no auth, no network
    api._get_ytmusic = lambda: fake
    api._playlist_contains = lambda playlist_id, video_ids: contains
    return api


class TestAddPlaylistItems:
    def test_rejected_duplicate_is_reported_as_duplicate(self) -> None:
        # YouTube rejects the edit when the song is already there.
        api = _api(_FakeYTMusic({"status": "STATUS_FAILED"}), contains=True)
        assert api.add_playlist_items("PL", ["v1"]) == {
            "status": "DUPLICATE",
            "setVideoIds": {},
            "duplicate": True,
        }

    def test_failure_that_is_not_a_duplicate_still_raises(self) -> None:
        api = _api(_FakeYTMusic({"status": "STATUS_FAILED"}), contains=False)
        with pytest.raises(RuntimeError):
            api.add_playlist_items("PL", ["v1"])

    def test_success_reports_set_video_ids(self, monkeypatch) -> None:
        monkeypatch.setattr(music_api, "cache", _FakeCache())
        monkeypatch.setattr(music_api, "_record_playlist_stat", lambda *args, **kwargs: None)
        fake = _FakeYTMusic(
            {
                "status": "STATUS_SUCCEEDED",
                "playlistEditResults": [{"videoId": "v1", "setVideoId": "sv1"}],
            }
        )
        api = _api(fake, contains=False)
        assert api.add_playlist_items("PL", ["v1"]) == {
            "status": "STATUS_SUCCEEDED",
            "setVideoIds": {"v1": "sv1"},
            "duplicate": False,
        }
        assert fake.duplicates is False

    def test_force_add_forwards_duplicates(self, monkeypatch) -> None:
        monkeypatch.setattr(music_api, "cache", _FakeCache())
        monkeypatch.setattr(music_api, "_record_playlist_stat", lambda *args, **kwargs: None)
        fake = _FakeYTMusic(
            {
                "status": "STATUS_SUCCEEDED",
                "playlistEditResults": [{"videoId": "v1", "setVideoId": "sv1"}],
            }
        )
        api = _api(fake, contains=True)
        result = api.add_playlist_items("PL", ["v1"], duplicates=True)
        assert fake.duplicates is True
        assert result["duplicate"] is False
        assert result["setVideoIds"] == {"v1": "sv1"}

    def test_force_add_failure_is_still_an_error(self) -> None:
        # With duplicates on, a rejection is a real error, not a duplicate.
        api = _api(_FakeYTMusic({"status": "STATUS_FAILED"}), contains=True)
        with pytest.raises(RuntimeError):
            api.add_playlist_items("PL", ["v1"], duplicates=True)


class TestRemovePlaylistVideos:
    def test_looks_up_the_set_video_id_when_unknown(self) -> None:
        api = MusicApi.__new__(MusicApi)
        api.get_playlist_items = lambda playlist_id: {"tracks": [{"videoId": "v1", "setVideoId": "sv1"}]}
        captured: dict = {}

        def remove(playlist_id, items):
            captured["items"] = items
            return {"status": "STATUS_SUCCEEDED"}

        api.remove_playlist_items = remove

        assert api.remove_playlist_videos("PL", ["v1"]) == {"status": "STATUS_SUCCEEDED", "removed": 1}
        assert captured["items"] == [{"videoId": "v1", "setVideoId": "sv1"}]

    def test_known_set_video_id_skips_the_read(self) -> None:
        api = MusicApi.__new__(MusicApi)
        api.get_playlist_items = lambda playlist_id: pytest.fail("should not read the playlist")
        api.remove_playlist_items = lambda playlist_id, items: {"status": "STATUS_SUCCEEDED"}

        assert api.remove_playlist_videos("PL", ["v1"], {"v1": "sv1"}) == {
            "status": "STATUS_SUCCEEDED",
            "removed": 1,
        }

    def test_picks_the_last_copy(self) -> None:
        api = MusicApi.__new__(MusicApi)
        api.get_playlist_items = lambda playlist_id: {
            "tracks": [{"videoId": "v1", "setVideoId": "old"}, {"videoId": "v1", "setVideoId": "new"}]
        }
        captured: dict = {}

        def remove(playlist_id, items):
            captured["items"] = items
            return {"status": "STATUS_SUCCEEDED"}

        api.remove_playlist_items = remove

        api.remove_playlist_videos("PL", ["v1"])
        assert captured["items"] == [{"videoId": "v1", "setVideoId": "new"}]

    def test_absent_song_raises(self) -> None:
        api = MusicApi.__new__(MusicApi)
        api.get_playlist_items = lambda playlist_id: {"tracks": []}
        with pytest.raises(ValueError):
            api.remove_playlist_videos("PL", ["v1"])
