"""Add times for playlist tracks, read from the playlist browse response.

ytmusicapi parses the same response but drops ``playlistItemData.voteSortValue``,
so the tests cover the two joins that put it back: the exact ``setVideoId`` one
owned playlists allow, and the ordered ``videoId`` fallback for anyone else's.
"""

import pytest

import features.music_api as music_api
from features.music_api import MusicApi, _apply_added_dates, _PlaylistDateCapture, _walk_playlist_item_data


def _response(items):
    """A browse response shaped like the real one, wrapped and all."""
    return {
        "contents": {
            "musicPlaylistShelfRenderer": {
                "contents": [
                    {"musicResponsiveListItemRenderer": {"playlistItemData": item}} for item in items
                ]
            }
        }
    }


class _FakeCache:
    def get(self, key):
        return None

    def set(self, *args, **kwargs):
        pass

    def delete(self, *args, **kwargs):
        pass


class _FakeYTMusic:
    """Stands in for ytmusicapi: pages the response, then drops the add times."""

    def __init__(self, pages):
        self.pages = list(pages)
        self._next = 0
        self.requests = 0

    def _send_request(self, endpoint, body, additional_params=""):
        self.requests += 1
        page = self.pages[self._next]
        self._next += 1
        return page

    def get_playlist(self, playlist_id, limit=None):
        tracks = []
        while self._next < len(self.pages):
            page = self._send_request("browse", {"browseId": "VL" + playlist_id})
            for item in _walk_playlist_item_data(page):
                tracks.append({"videoId": item["videoId"], "setVideoId": item.get("playlistSetVideoId")})
        return {"title": "Mix", "tracks": tracks, "thumbnails": []}


class TestWalkPlaylistItemData:
    def test_yields_every_item_in_page_order(self) -> None:
        page = _response(
            [
                {"videoId": "a", "voteSortValue": 1},
                {"videoId": "b", "voteSortValue": 2},
            ]
        )
        assert [item["videoId"] for item in _walk_playlist_item_data(page)] == ["a", "b"]


class TestApplyAddedDates:
    def test_joins_owned_tracks_on_set_video_id(self) -> None:
        tracks = [{"videoId": "a", "setVideoId": "sv1"}, {"videoId": "b", "setVideoId": "sv2"}]
        items = [
            {"videoId": "a", "playlistSetVideoId": "sv1", "voteSortValue": 100},
            {"videoId": "b", "playlistSetVideoId": "sv2", "voteSortValue": 200},
        ]
        assert _apply_added_dates(tracks, items) == 2
        assert [track["addedAt"] for track in tracks] == [100, 200]

    def test_falls_back_to_video_id_order_without_set_video_ids(self) -> None:
        # Someone else's playlist parses without a setVideoId per track, so the
        # first raw appearance of a song supplies the time for the first track.
        tracks = [{"videoId": "a", "setVideoId": None}, {"videoId": "a", "setVideoId": None}]
        items = [
            {"videoId": "a", "playlistSetVideoId": "one", "voteSortValue": 100},
            {"videoId": "a", "playlistSetVideoId": "two", "voteSortValue": 200},
        ]
        assert _apply_added_dates(tracks, items) == 2
        assert [track["addedAt"] for track in tracks] == [100, 200]

    def test_leaves_tracks_without_a_time_alone(self) -> None:
        tracks = [{"videoId": "a", "setVideoId": "sv1"}, {"videoId": "b", "setVideoId": "sv2"}]
        items = [{"videoId": "a", "playlistSetVideoId": "sv1", "voteSortValue": 0}]
        assert _apply_added_dates(tracks, items) == 0
        assert all("addedAt" not in track for track in tracks)

    def test_survives_a_payload_the_wrong_shape(self) -> None:
        assert _apply_added_dates(None, [{"videoId": "a", "voteSortValue": 1}]) == 0
        assert _apply_added_dates(["nope"], ["nope"]) == 0


class TestCapture:
    def test_records_items_seen_while_it_is_open(self) -> None:
        ytmusic = _FakeYTMusic([_response([{"videoId": "a", "voteSortValue": 7}])])
        with _PlaylistDateCapture(ytmusic) as capture:
            ytmusic._send_request("browse", {"browseId": "VLLM"})
        assert capture.items == [{"videoId": "a", "voteSortValue": 7}]

    def test_stops_recording_once_it_closes(self) -> None:
        ytmusic = _FakeYTMusic([_response([{"videoId": "a", "voteSortValue": 7}])] * 2)
        with _PlaylistDateCapture(ytmusic) as capture:
            ytmusic._send_request("browse", {})
        ytmusic._send_request("browse", {})
        assert capture.items == [{"videoId": "a", "voteSortValue": 7}]

    def test_installs_the_recorder_only_once(self) -> None:
        ytmusic = _FakeYTMusic([])
        with _PlaylistDateCapture(ytmusic):
            pass
        installed = ytmusic._date_recorder
        with _PlaylistDateCapture(ytmusic) as capture:
            with _PlaylistDateCapture(ytmusic) as inner:
                pass
            assert inner.items == []
        assert ytmusic._date_recorder is installed
        assert capture.items == []

    def test_clears_the_sink_after_an_error(self) -> None:
        ytmusic = _FakeYTMusic([])
        with pytest.raises(IndexError):
            with _PlaylistDateCapture(ytmusic):
                ytmusic._send_request("browse", {})
        assert getattr(music_api._date_sinks, "stack", []) == []


class TestGetPlaylistItems:
    def _api(self, fake, monkeypatch):
        monkeypatch.setattr(music_api, "cache", _FakeCache())
        monkeypatch.setattr(music_api, "_inline_playlist_thumbnails", lambda playlists: None)
        api = MusicApi.__new__(MusicApi)  # bypass __init__: no auth, no network
        api._get_ytmusic = lambda: fake
        api._is_authenticated = lambda: True
        return api

    def test_stamps_add_times_across_pages(self, monkeypatch) -> None:
        fake = _FakeYTMusic(
            [
                _response([{"videoId": "a", "playlistSetVideoId": "sv1", "voteSortValue": 100}]),
                _response([{"videoId": "b", "playlistSetVideoId": "sv2", "voteSortValue": 200}]),
            ]
        )
        playlist = self._api(fake, monkeypatch).get_playlist_items("PL")
        assert [track["addedAt"] for track in playlist["tracks"]] == [100, 200]

    def test_no_add_time_leaves_the_playlist_usable(self, monkeypatch) -> None:
        # An unavailable item can carry no voteSortValue; the track still loads.
        fake = _FakeYTMusic([_response([{"videoId": "a", "playlistSetVideoId": "sv1"}])])
        playlist = self._api(fake, monkeypatch).get_playlist_items("PL")
        assert playlist["tracks"] == [{"videoId": "a", "setVideoId": "sv1"}]
