"""Direct audio URLs for the signed-in YouTube Music account.

The player response lists audio files. Premium accounts include the
256 kbps file. The URL is signed, so a small JavaScript solver (from
yt-dlp-ejs) runs on the bundled QuickJS binary before playback.

YouTube enforces proof-of-origin tokens on the Google Video Server in
per-account rollouts (yt-dlp calls this GVS PO token enforcement): the
player response still serves URLs, but fetching the bytes returns 403.
The signed-in web client is hit first, so every URL is verified with two
small ranged reads and, when the web client refuses, a VisionOS request
to the www endpoint, a client YouTube does not currently gate, serves
the file instead. android_vr is the second fallback; YouTube started
serving it URLs that answer the first range and 403 the rest, which is
why verification reads mid-file and not just the head.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests
import ytmusicapi
from yt_dlp_ejs.yt.solver import core as solver_core
from yt_dlp_ejs.yt.solver import lib as solver_lib

from util.app_paths import cache_dir

logger = logging.getLogger(__name__)

_SOLVE_TIMEOUT_SECONDS = 25
_CACHE_SKEW_SECONDS = 60
_QUALITY_RANK = {"AUDIO_QUALITY_HIGH": 3, "AUDIO_QUALITY_MEDIUM": 2, "AUDIO_QUALITY_LOW": 1}
_VERIFY_TIMEOUT_SECONDS = 8
_VERIFY_BYTES = 2047
# Only used when the head read reports no length at all. A real file shorter
# than this answers 416 at that offset, which the retry turns into its middle.
_FALLBACK_MIDDLE = 2_000_000
# The bridge call times out at 30s, so the whole candidate chain stays under it.
_STREAM_DEADLINE_SECONDS = 25

# Clients whose player responses serve plain URLs and whose files YouTube does
# not gate (as of October 2026). Requested anonymously on the www endpoint with
# the browser session's headers but no cookies or authorization. android_vr is
# kept last: its URLs pass the head read and 403 further in, so the mid-file
# verification is what disqualifies it.
_FALLBACK_CLIENTS: tuple[dict[str, Any], ...] = (
    {
        "name": "VISIONOS",
        "context": {
            "clientName": "VISIONOS",
            "clientVersion": "1.02",
            "deviceMake": "Apple",
            "deviceModel": "RealityDevice17,1",
            "osName": "visionOS",
            "osVersion": "26.5.23O471",
        },
        "clientNameHeader": ("101", "1.02"),
        "userAgent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Version/26.0 Safari/605.1.15"
        ),
    },
    {
        "name": "ANDROID_VR",
        "context": {
            "clientName": "ANDROID_VR",
            "clientVersion": "1.65.10",
            "deviceMake": "Oculus",
            "deviceModel": "Quest 3",
            "androidSdkVersion": 32,
            "osName": "Android",
            "osVersion": "12L",
        },
        "clientNameHeader": ("28", "1.65.10"),
        "userAgent": (
            "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; "
            "eureka-user Build/SQ3A.220605.009.A1) gzip"
        ),
    },
)

# Header names never sent to the www endpoint: the fallback presents itself as
# a different client and stays anonymous, so the web session's identity headers
# are dropped along with the ones the request itself defines.
_DROPPED_HEADERS = frozenset(
    {
        "authorization",
        "cookie",
        "origin",
        "referer",
        "x-origin",
        "x-youtube-client-name",
        "x-youtube-client-version",
        "content-length",
        "content-type",
        "host",
        "user-agent",
    }
)

_SOLVER_LOOP = r"""
let solveN = null;
let solveSig = null;

function armFromScript(script) {
  if (typeof script !== "string" || !script) throw new Error("player script has no solver");
  const box = { n: null, sig: null };
  Function("_result", script)(box);
  if (typeof box.n !== "function" || typeof box.sig !== "function") {
    throw new Error("player script did not yield solvers");
  }
  solveN = box.n;
  solveSig = box.sig;
}

function arm(player, cachePath) {
  const prepared = jsc({
    type: "player",
    player: player,
    output_preprocessed: true,
    requests: [],
  });
  const script = prepared && prepared.preprocessed_player;
  armFromScript(script);
  if (typeof cachePath === "string" && cachePath) std.writeFile(cachePath, script);
}

function reply(payload) {
  std.out.puts(JSON.stringify(payload) + "\n");
  std.out.flush();
}

for (;;) {
  const raw = std.in.getline();
  if (raw === null) break;
  const line = String(raw).replace(/\r$/, "").trim();
  if (!line) continue;
  try {
    const message = JSON.parse(line);
    if (message.cached === true) armFromScript(std.loadFile(message.cachePath));
    else if (typeof message.player === "string") arm(message.player, message.cachePath);
    if (!solveN || !solveSig) throw new Error("audio solver is not ready");
    const out = { ok: true };
    if (typeof message.n === "string") out.n = solveN(message.n);
    if (typeof message.sig === "string") out.sig = solveSig(message.sig);
    reply(out);
  } catch (error) {
    reply({ ok: false, error: String(error && error.stack || error) });
  }
}
"""


def _qjs_path() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS")) / "qjs.exe"
    return Path(__file__).resolve().parents[1] / "third_party" / "qjs.exe"


def _solver_dir() -> Path:
    path = cache_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _solver_script() -> Path:
    from yt_dlp_ejs._version import version

    path = _solver_dir() / "stream-solver.js"
    marker = f"/* yt-dlp-ejs {version} stream-2 */\n"
    if path.is_file():
        with path.open(encoding="utf-8") as handle:
            if handle.readline() == marker:
                return path
    text = (
        marker
        + solver_lib()
        + "\nconst meriyah = lib.meriyah;\nconst astring = lib.astring;\n"
        + solver_core()
        + "\n"
        + _SOLVER_LOOP
    )
    # The cache dir can be shared by several windows, so the temp name is per
    # process; the replace target stays shared.
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)
    return path


class _StreamSolver:
    """One QuickJS process. The player script is loaded once, then each song is a function call."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen[bytes] | None = None
        self._armed_url: str | None = None
        self._stderr: list[str] = []

    def solve(self, player_url: str, player_js: str, throttle: str | None, signature: str | None) -> dict[str, str]:
        with self._lock:
            payload: dict[str, Any] = {}
            if self._armed_url != player_url or self._proc is None or self._proc.poll() is not None:
                cache_js = _solver_dir() / "player-solver.js"
                cache_url = _solver_dir() / "player-solver.url"
                saved = cache_url.read_text(encoding="utf-8") if cache_url.is_file() else ""
                if saved == player_url and cache_js.is_file():
                    payload["cached"] = True
                    payload["cachePath"] = str(cache_js)
                else:
                    payload["player"] = player_js
                    payload["cachePath"] = str(cache_js)
            if throttle is not None:
                payload["n"] = throttle
            if signature is not None:
                payload["sig"] = signature
            try:
                result = self._exchange(payload)
            except Exception:
                self._stop()
                raise
            if payload.get("player") or payload.get("cached"):
                self._armed_url = player_url
                if payload.get("player"):
                    url_path = _solver_dir() / "player-solver.url"
                    temporary = url_path.with_name(f"{url_path.name}.{os.getpid()}.tmp")
                    temporary.write_text(player_url, encoding="utf-8")
                    temporary.replace(url_path)
            solved: dict[str, str] = {}
            for key in ("n", "sig"):
                if key not in payload:
                    continue
                value = result.get(key)
                if not isinstance(value, str) or not value:
                    self._stop()
                    raise RuntimeError("YouTube Music did not produce a playable audio URL.")
                solved[key] = value
            return solved

    def _exchange(self, payload: dict[str, Any]) -> dict[str, Any]:
        proc = self._ensure()
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n")
        proc.stdin.flush()
        box: dict[str, bytes] = {}

        def read() -> None:
            assert proc.stdout is not None
            box["line"] = proc.stdout.readline()

        reader = threading.Thread(target=read, name="ytmusic-stream-solver", daemon=True)
        reader.start()
        reader.join(_SOLVE_TIMEOUT_SECONDS)
        if reader.is_alive():
            self._stop()
            raise TimeoutError("The audio stream took too long to prepare.")
        line = box.get("line", b"")
        if not line:
            detail = " ".join(self._stderr[-3:]).strip()
            self._stop()
            raise RuntimeError(detail or "The audio solver stopped.")
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            self._stop()
            raise RuntimeError("The audio solver returned an unreadable result.") from exc
        if not isinstance(parsed, dict) or not parsed.get("ok"):
            self._stop()
            message = parsed.get("error") if isinstance(parsed, dict) else None
            logger.warning("Audio solver failed: %s", message)
            raise RuntimeError("YouTube Music did not produce a playable audio URL.")
        return parsed

    def _ensure(self) -> subprocess.Popen[bytes]:
        if self._proc is not None and self._proc.poll() is None:
            return self._proc
        qjs = _qjs_path()
        if not qjs.is_file():
            raise RuntimeError("The audio solver is missing.")
        self._stderr = []
        proc = subprocess.Popen(
            [str(qjs), "--std", str(_solver_script())],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self._proc = proc
        self._armed_url = None

        def drain() -> None:
            if proc.stderr is None:
                return
            for raw in proc.stderr:
                text = raw.decode("utf-8", "replace").strip()
                if not text:
                    continue
                self._stderr.append(text)
                del self._stderr[:-8]

        threading.Thread(target=drain, name="ytmusic-stream-solver-log", daemon=True).start()
        return proc

    def _stop(self) -> None:
        proc = self._proc
        self._proc = None
        self._armed_url = None
        if proc is None or proc.poll() is not None:
            return
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass

    def close(self) -> None:
        with self._lock:
            self._stop()


_solver = _StreamSolver()
atexit.register(_solver.close)

_player_lock = threading.Lock()
_player_url: str | None = None
_player_js: str | None = None
_player_timestamp: int | None = None

_stream_lock = threading.Lock()
_streams: dict[str, tuple[float, dict[str, Any]]] = {}


def _player_source(ytmusic: ytmusicapi.YTMusic) -> tuple[str, str, int]:
    global _player_url, _player_js, _player_timestamp
    with _player_lock:
        if _player_url and _player_js and _player_timestamp is not None:
            return _player_url, _player_js, _player_timestamp
        url = ytmusic.get_basejs_url()
        response = ytmusic._send_get_request(url)
        script = response.text
        matched = None
        for token in ("signatureTimestamp:", "signatureTimestamp="):
            start = script.find(token)
            if start == -1:
                continue
            digits = []
            for char in script[start + len(token) : start + len(token) + 12]:
                if char.isdigit():
                    digits.append(char)
                elif digits:
                    break
            if digits:
                matched = int("".join(digits))
                break
        if matched is None:
            matched = ytmusic.get_signatureTimestamp(url)
        _player_url = url
        _player_js = script
        _player_timestamp = matched
        return url, script, matched


def _audio_formats(song: dict[str, Any]) -> list[dict[str, Any]]:
    streaming = song.get("streamingData")
    if not isinstance(streaming, dict):
        return []
    formats = streaming.get("adaptiveFormats")
    if not isinstance(formats, list):
        return []
    chosen: list[dict[str, Any]] = []
    for item in formats:
        if not isinstance(item, dict):
            continue
        mime = item.get("mimeType")
        if not isinstance(mime, str) or not mime.startswith("audio/"):
            continue
        if item.get("drmFamilies"):
            continue
        if not item.get("signatureCipher") and not item.get("cipher") and not item.get("url"):
            continue
        chosen.append(item)
    return chosen


def _best_audio(formats: list[dict[str, Any]]) -> dict[str, Any]:
    def rank(item: dict[str, Any]) -> tuple[int, int]:
        bitrate = item.get("bitrate")
        quality = item.get("audioQuality")
        return (
            int(bitrate) if isinstance(bitrate, int) else 0,
            _QUALITY_RANK.get(quality, 0) if isinstance(quality, str) else 0,
        )

    return max(formats, key=rank)


def _playback_url(fmt: dict[str, Any], solved: dict[str, str]) -> str:
    cipher = fmt.get("signatureCipher") or fmt.get("cipher")
    signature: str | None = None
    signature_param = "sig"
    if isinstance(cipher, str) and cipher:
        parts = dict(parse_qsl(cipher, keep_blank_values=True))
        raw = parts.get("url")
        signature = parts.get("s")
        signature_param = parts.get("sp") or "sig"
    else:
        raw = fmt.get("url") if isinstance(fmt.get("url"), str) else None
    if not isinstance(raw, str) or not raw:
        raise RuntimeError("YouTube Music did not return an audio URL.")
    parsed = urlparse(raw)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if "n" in query:
        replacement = solved.get("n")
        if not replacement:
            raise RuntimeError("YouTube Music did not produce a playable audio URL.")
        query["n"] = replacement
    if signature is not None:
        replacement = solved.get("sig")
        if not replacement:
            raise RuntimeError("YouTube Music did not produce a playable audio URL.")
        query[signature_param] = replacement
    return urlunparse(parsed._replace(query=urlencode(query)))


def _challenges(fmt: dict[str, Any]) -> tuple[str | None, str | None]:
    cipher = fmt.get("signatureCipher") or fmt.get("cipher")
    raw = None
    signature = None
    if isinstance(cipher, str) and cipher:
        parts = dict(parse_qsl(cipher, keep_blank_values=True))
        raw = parts.get("url")
        signature = parts.get("s")
    elif isinstance(fmt.get("url"), str):
        raw = fmt["url"]
    throttle = None
    if isinstance(raw, str) and raw:
        query = dict(parse_qsl(urlparse(raw).query, keep_blank_values=True))
        value = query.get("n")
        if isinstance(value, str) and value:
            throttle = value
    return throttle, signature if isinstance(signature, str) and signature else None


def _payload(chosen: dict[str, Any], url: str, expires: int) -> dict[str, Any]:
    bitrate = chosen.get("bitrate")
    quality = chosen.get("audioQuality")
    itag = chosen.get("itag")
    return {
        "url": url,
        "mimeType": chosen.get("mimeType") if isinstance(chosen.get("mimeType"), str) else "",
        "bitrate": int(bitrate) if isinstance(bitrate, int) else 0,
        "itag": int(itag) if isinstance(itag, int) else 0,
        "audioQuality": quality if isinstance(quality, str) else "",
        "expiresInSeconds": expires,
    }


def _total_bytes(response: requests.Response) -> int | None:
    """The whole file's size: the Content-Range of a 206, the Content-Length of a plain 200."""
    content_range = response.headers.get("Content-Range") or ""
    _, _, total = content_range.partition("/")
    if total.isdigit():
        return int(total)
    length = response.headers.get("Content-Length") or ""
    if response.status_code == 200 and length.isdigit():
        return int(length)
    return None


def _range_read(
    url: str, headers: dict[str, str], start: int, timeout: float
) -> tuple[int, int | None, str]:
    """One small ranged read: its status, the file's size when the answer names it, and its type."""
    response = requests.get(
        url,
        headers={**headers, "Range": f"bytes={start}-{start + _VERIFY_BYTES}"},
        timeout=timeout,
        stream=True,
    )
    with response:
        content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        return response.status_code, _total_bytes(response), content_type


def _verify(url: str, user_agent: str, deadline: float) -> tuple[bool, str]:
    """Two small ranged reads: the head and the middle of the file.

    A URL that answers the first range and refuses the rest is exactly what
    YouTube serves gate-kept clients, so the head alone proves nothing. The
    middle comes from the file's own length, because a fixed offset is past the
    end of a short song and YouTube answers that with 416.
    """
    headers = {"User-Agent": user_agent}
    timeout = max(2.0, min(_VERIFY_TIMEOUT_SECONDS, deadline - time.time()))
    try:
        status, total, content_type = _range_read(url, headers, 0, timeout)
        if status not in (200, 206) or not content_type.startswith("audio/"):
            return False, f"HTTP {status} {content_type or 'without a content type'}"
        middle = total // 2 if total else _FALLBACK_MIDDLE
        deep_status, deep_total, _ = _range_read(url, headers, middle, timeout)
        # A 416 still names the file's length, so it means the offset was wrong
        # and not that the URL is refused: retry at the middle of the real file.
        if deep_status == 416 and deep_total and 0 < deep_total // 2 < middle:
            deep_status, _, _ = _range_read(url, headers, deep_total // 2, timeout)
        if deep_status not in (200, 206):
            return False, f"HTTP {deep_status} on a mid-file range"
    except requests.RequestException as exc:
        return False, f"{exc.__class__.__name__}"
    return True, f"HTTP {status} {content_type}"


def _captured_headers(ytmusic: ytmusicapi.YTMusic) -> dict[str, str]:
    return {
        key: value
        for key, value in dict(ytmusic.headers).items()
        if key.lower() not in _DROPPED_HEADERS
    }


def _web_music_stream(ytmusic: ytmusicapi.YTMusic, video_id: str) -> tuple[dict[str, Any], str]:
    """The signed-in account's own client. Highest quality, but gated first."""
    player_url, player_js, timestamp = _player_source(ytmusic)
    song = ytmusic.get_song(video_id, timestamp)
    if not isinstance(song, dict):
        raise RuntimeError("YouTube Music did not return this song.")
    playability = song.get("playabilityStatus")
    status = playability.get("status") if isinstance(playability, dict) else None
    if status != "OK":
        reason = playability.get("reason") if isinstance(playability, dict) else None
        raise RuntimeError(reason if isinstance(reason, str) and reason else "This song can't be played.")
    formats = _audio_formats(song)
    if not formats:
        raise RuntimeError("YouTube Music did not return an audio stream.")
    chosen = _best_audio(formats)
    throttle, signature = _challenges(chosen)
    solved = _solver.solve(player_url, player_js, throttle, signature) if throttle or signature else {}
    payload = _payload(chosen, _playback_url(chosen, solved), _expires(song))
    agent = next(
        (value for key, value in dict(ytmusic.headers).items() if key.lower() == "user-agent"),
        "Mozilla/5.0",
    )
    return payload, agent


def _fallback_stream(
    video_id: str, client: dict[str, Any], session_headers: dict[str, str], timestamp: int, deadline: float
) -> tuple[dict[str, Any], str]:
    """One ungated client, requested anonymously on the www endpoint."""
    name = client["name"]
    timeout = max(2.0, min(_VERIFY_TIMEOUT_SECONDS, deadline - time.time()))
    headers = dict(session_headers)
    headers["Content-Type"] = "application/json"
    headers["User-Agent"] = client["userAgent"]
    client_name, client_version = client["clientNameHeader"]
    headers["X-YouTube-Client-Name"] = client_name
    headers["X-YouTube-Client-Version"] = client_version
    headers["Origin"] = "https://www.youtube.com"
    headers["X-Origin"] = "https://www.youtube.com"
    response = requests.post(
        "https://www.youtube.com/youtubei/v1/player",
        params={"key": "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30", "prettyPrint": "false"},
        json={
            "context": {"client": client["context"]},
            "video_id": video_id,
            "playbackContext": {"contentPlaybackContext": {"signatureTimestamp": timestamp}},
            "contentCheckOk": True,
            "racyCheckOk": True,
        },
        headers=headers,
        timeout=timeout,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"HTTP {response.status_code}")
    data = response.json()
    playability = data.get("playabilityStatus")
    status = playability.get("status") if isinstance(playability, dict) else None
    if status != "OK":
        reason = playability.get("reason") if isinstance(playability, dict) else None
        raise RuntimeError(reason if isinstance(reason, str) and reason else f"{name} refused this song")
    formats = _audio_formats(data)
    if not formats:
        raise RuntimeError(f"{name} served no audio formats")
    chosen = _best_audio(formats)
    # These clients answer with plain URLs. A signed format means YouTube
    # changed the client again; the web candidate remains the solver's user.
    if not chosen.get("url") or chosen.get("signatureCipher") or chosen.get("cipher"):
        raise RuntimeError(f"{name} stopped serving plain URLs")
    payload = _payload(chosen, chosen["url"], _expires(data))
    return payload, client["userAgent"]


def _expires(song: dict[str, Any]) -> int:
    streaming = song.get("streamingData")
    expires_raw = streaming.get("expiresInSeconds") if isinstance(streaming, dict) else None
    try:
        return int(expires_raw)
    except (TypeError, ValueError):
        return 6 * 60 * 60


def audio_stream(ytmusic: ytmusicapi.YTMusic, video_id: str, refresh: bool = False) -> dict[str, Any]:
    """Return the best direct audio URL for this account and song."""
    now = time.time()
    with _stream_lock:
        if refresh:
            _streams.pop(video_id, None)
        cached = _streams.get(video_id)
        if cached is not None and cached[0] > now:
            return dict(cached[1])

    deadline = time.time() + _STREAM_DEADLINE_SECONDS
    timestamp = _player_source(ytmusic)[2]
    if not isinstance(timestamp, int):
        timestamp = int(time.strftime("%Y%m%d"))
    session_headers = _captured_headers(ytmusic)
    candidates: list[tuple[str, Any]] = [
        ("web", lambda: _web_music_stream(ytmusic, video_id))
    ]
    candidates.extend(
        (
            client["name"],
            lambda client=client: _fallback_stream(video_id, client, session_headers, timestamp, deadline),
        )
        for client in _FALLBACK_CLIENTS
    )

    failures: list[str] = []
    for name, attempt in candidates:
        try:
            payload, user_agent = attempt()
        except Exception as exc:  # noqa: BLE001 - every candidate failure means the next one
            failures.append(f"{name}: {exc}")
            logger.warning("Audio stream %s: %s attempt failed: %s", video_id, name, exc)
            continue
        verified, detail = _verify(payload["url"], user_agent, deadline)
        if not verified:
            failures.append(f"{name}: {detail}")
            logger.warning("Audio stream %s: %s URL refused: %s", video_id, name, detail)
            continue
        logger.info(
            "Audio stream %s itag=%s bitrate=%s quality=%s (%s, %s)",
            video_id,
            payload["itag"],
            payload["bitrate"],
            payload["audioQuality"] or "unknown",
            name,
            detail,
        )
        with _stream_lock:
            _streams[video_id] = (
                time.time() + max(30, payload["expiresInSeconds"] - _CACHE_SKEW_SECONDS),
                dict(payload),
            )
            if len(_streams) > 32:
                oldest = min(_streams, key=lambda key: _streams[key][0])
                _streams.pop(oldest, None)
        return payload
    raise RuntimeError("YouTube refused to stream this song. " + "; ".join(failures))


def warm(ytmusic: ytmusicapi.YTMusic) -> None:
    """Fetch the player script and arm the solver, off the calling thread.

    The first stream of a session is the slow one: the player script has to be
    downloaded and parsed into the two challenge solvers before any song can
    play. None of that depends on the song, so the window asks for it while the
    user is still browsing and the first press only waits for its own request.
    Best effort: a failed warm-up leaves the first song to do the work itself.
    """
    threading.Thread(target=_warm, args=(ytmusic,), name="ytmusic-stream-warm", daemon=True).start()


def _warm(ytmusic: ytmusicapi.YTMusic) -> None:
    started = time.time()
    try:
        player_url, player_js, _ = _player_source(ytmusic)
        # No challenge to solve yet; the payload only carries the player script,
        # which is what arms the solver process.
        _solver.solve(player_url, player_js, None, None)
        logger.info("Audio solver armed in %.2fs", time.time() - started)
    except Exception as exc:  # noqa: BLE001 - the first song can retry the same work
        logger.info("Audio solver warm-up skipped: %s", exc)
