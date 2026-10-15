"""The playlist payload cached when a playlist is created.

YouTube Music serves a stub browse page for a playlist it is still preparing,
and ytmusicapi cannot parse that stub, so a freshly created playlist read back
as nothing and the playlist view sat on its loader. ``create_playlist`` now
caches the header it already knows, so the first read has something to show.
"""

import features.music_api as music_api
from features.music_api import CACHE_KEY_PLAYLIST_PREFIX, MusicApi


class _RecordingCache:
    def __init__(self):
        self.entries = {}

    def get(self, key):
        return self.entries.get(key)

    def set(self, key, value, expire=None):
        self.entries[key] = value

    def delete(self, key):
        return self.entries.pop(key, None) is not None


class _FakeYTMusic:
    def __init__(self, playlist_id="PLnew"):
        self.playlist_id = playlist_id
        self.created = []

    def create_playlist(self, title, description, privacy_status, video_ids=None):
        self.created.append((title, description, privacy_status, video_ids))
        return self.playlist_id


def _api(fake, monkeypatch, cache):
    monkeypatch.setattr(music_api, "cache", cache)
    api = MusicApi.__new__(MusicApi)  # bypass __init__: no auth, no network
    api._get_ytmusic = lambda: fake
    api._is_authenticated = lambda: True
    return api


class TestCreatePlaylistCache:
    def test_caches_the_new_empty_playlist(self, monkeypatch) -> None:
        cache = _RecordingCache()
        api = _api(_FakeYTMusic(), monkeypatch, cache)

        assert api.create_playlist("Road trip", "songs later", "UNLISTED") == {"playlistId": "PLnew"}

        payload = cache.get(f"{CACHE_KEY_PLAYLIST_PREFIX}PLnew")
        assert payload is not None
        assert payload["id"] == "PLnew"
        assert payload["title"] == "Road trip"
        assert payload["description"] == "songs later"
        assert payload["privacy"] == "UNLISTED"
        assert payload["owned"] is True
        assert payload["tracks"] == []
        assert payload["trackCount"] == 0

    def test_the_first_read_serves_the_cached_header(self, monkeypatch) -> None:
        cache = _RecordingCache()
        api = _api(_FakeYTMusic(), monkeypatch, cache)
        api.create_playlist("Road trip", "", "PRIVATE")

        payload = api.get_playlist_items("PLnew")

        assert payload["title"] == "Road trip"
        assert payload["tracks"] == []
        assert payload["fromCache"] is True

    def test_a_playlist_created_with_songs_is_left_to_the_fetch(self, monkeypatch) -> None:
        # The create call reports no setVideoIds, so the track list cannot be
        # described without reading the playlist back.
        cache = _RecordingCache()
        api = _api(_FakeYTMusic(), monkeypatch, cache)

        api.create_playlist("Mix", "", "PRIVATE", ["v1", "v2"])

        assert cache.entries == {}
