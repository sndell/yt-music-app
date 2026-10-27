"""Updates from GitHub releases, for the portable onefile exe.

There is nothing to install: the update replaces the exe and starts it again.
Windows will not let a process delete or overwrite its own image, but it will
let the image be renamed. So the swap is done by a generated cmd script that
waits until the exe can be renamed, renames it to `<name>.old`, moves the
downloaded build into its place, and starts it. The old exe is removed on the
next start, which is also the moment the new build has proven it runs.

The check is one GitHub request, cached in memory for a few hours. The release
list rather than `/releases/latest`, because this repo tagged `alpha-1` and
`alpha-2` before it had versions, and those do not compare as numbers.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from util.app_paths import data_dir, is_frozen
from version import VERSION

logger = logging.getLogger(__name__)

REPO = "sndell/yt-music-app"
ASSET = "YTMusic.exe"
RELEASES_URL = f"https://api.github.com/repos/{REPO}/releases?per_page=30"
USER_AGENT = "YTMusic-updater/1.0"

# One check is plenty; the window can stay open for days.
CHECK_TTL = 6 * 60 * 60
# A failed check is not worth a request per click on Settings.
ERROR_TTL = 60
CHECK_TIMEOUT = 8
DOWNLOAD_TIMEOUT = 60

# Let the bridge reply and the page paint "Restarting" before the window goes.
RESTART_DELAY = 1.0

# The helper has no console, so `timeout` refuses its own input; ping is the
# sleep that works there. 120 tries is about two minutes.
_HELPER_TRIES = 120

_TAG = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


@dataclass(frozen=True)
class Release:
    tag: str
    version: str
    url: str
    size: int
    digest: str
    download: str


_LOCK = threading.Lock()
_release: Release | None = None
_history: list[dict] = []
_error = ""
_checked_at = 0.0


def version() -> str:
    """The version this process is running."""
    return VERSION


def status() -> dict:
    """The running version and the newest published release.

    `error` is empty when the check worked. A dev window still checks, so the
    row on Settings has something to show, but only the packaged exe installs.
    """
    current = version()
    release, error = _latest()
    available = release is not None and _is_newer(release.version, current)
    return {
        "current": current,
        "latest": release.version if release else "",
        "available": available,
        "frozen": is_frozen(),
        "url": release.url if release else "",
        "error": error,
    }


def history() -> dict:
    """Every published version, newest first, with what its notes describe.

    Comes from the same release list the update check reads, so opening the
    history costs no request when the check has already run.
    """
    _latest()
    with _LOCK:
        return {"releases": list(_history), "error": _error}


def warm() -> None:
    """Start the check in the background, so Settings opens on an answer."""
    threading.Thread(target=_latest, name="update-check", daemon=True).start()


def install() -> dict:
    """Download the newest release and hand the swap to the generated script.

    Returns as soon as the script is running; the caller closes the window.
    Raises RuntimeError with a sentence the page can show.
    """
    if not is_frozen():
        raise RuntimeError("Updates install in the packaged YTMusic.exe, not a dev window.")

    target = Path(sys.executable)
    if not target.is_file():
        raise RuntimeError(f"Cannot find the running exe at {target}.")

    release, error = _latest()
    if release is None:
        raise RuntimeError(error or "Could not read the newest release.")
    if not _is_newer(release.version, version()):
        raise RuntimeError(f"{version()} is already the newest release.")

    _check_writable(target)

    folder = update_dir()
    downloaded = folder / f"YTMusic-{release.version}.exe"
    _download(release, downloaded)
    script = _write_script(folder)
    _spawn(script, target, downloaded, release.version)

    logger.info("Update %s downloaded to %s; helper %s", release.version, downloaded, script)
    return {"version": release.version, "restarting": True}


def cleanup() -> None:
    """Forget the previous exe and any half-downloaded build.

    Runs at startup. By the time it does, the new exe has opened a window, so
    the `.old` copy is no longer needed, and a `*.part` can only be the remains
    of a download that never finished.
    """
    if not is_frozen():
        return

    old = Path(str(sys.executable) + ".old")
    try:
        if old.is_file():
            old.unlink()
            logger.info("Removed the previous exe at %s", old)
    except OSError as exc:
        logger.warning("Could not remove %s: %s", old, exc)

    folder = update_dir()
    for pattern in ("*.part", "*.exe"):
        for path in folder.glob(pattern):
            try:
                path.unlink()
            except OSError as exc:
                logger.warning("Could not remove %s: %s", path, exc)


def update_dir() -> Path:
    folder = data_dir() / "update"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _latest() -> tuple[Release | None, str]:
    """The newest release, from the cached check or a fresh one."""
    global _release, _history, _error, _checked_at

    with _LOCK:
        now = time.time()
        if _release is not None and now - _checked_at < CHECK_TTL:
            return _release, ""
        if _error and now - _checked_at < ERROR_TTL:
            return None, _error
        try:
            payload = _fetch_releases()
            _history = _parse_history(payload)
            _release = _pick_latest(payload)
            _error = ""
        except Exception as exc:  # offline, rate limited, or a shape we cannot read
            _release = None
            _error = _describe(exc)
            logger.info("Update check failed: %s", _error)
        _checked_at = now
        return _release, _error


def _fetch_releases() -> list:
    payload = _get_json(RELEASES_URL, CHECK_TIMEOUT)
    if not isinstance(payload, list):
        raise RuntimeError("GitHub returned an unexpected release list.")
    return payload


def _pick_latest(payload: list) -> Release:
    found: list[tuple[tuple[int, int, int], Release]] = []
    for item in payload:
        if not isinstance(item, dict) or item.get("draft") or item.get("prerelease"):
            continue
        tag = str(item.get("tag_name") or "")
        key = _version_key(tag)
        if key is None:
            continue
        asset = _exe_asset(item)
        if asset is None:
            continue
        found.append(
            (
                key,
                Release(
                    tag=tag,
                    version=tag.lstrip("v"),
                    url=str(item.get("html_url") or ""),
                    size=_as_size(asset.get("size")),
                    digest=str(asset.get("digest") or ""),
                    download=str(asset["browser_download_url"]),
                ),
            )
        )

    if not found:
        raise RuntimeError("No release has a YTMusic.exe asset.")
    return max(found, key=lambda pair: pair[0])[1]


def _parse_history(payload: list) -> list[dict]:
    found: list[tuple[tuple[int, int, int], dict]] = []
    for item in payload:
        if not isinstance(item, dict) or item.get("draft") or item.get("prerelease"):
            continue
        tag = str(item.get("tag_name") or "")
        key = _version_key(tag)
        if key is None:
            continue
        summary, changes = _notes(str(item.get("body") or ""))
        found.append(
            (
                key,
                {
                    "version": tag.lstrip("v"),
                    "date": str(item.get("published_at") or ""),
                    "url": str(item.get("html_url") or ""),
                    "summary": summary,
                    "changes": changes,
                },
            )
        )
    found.sort(key=lambda pair: pair[0], reverse=True)
    return [entry for _, entry in found]


# A trailing "([#77](...), [abc1234](...))" credit list after a title.
_CREDITS = re.compile(r"\s*\((?:\[[^\]]*\]\([^)]*\)(?:\s*,\s*)?)+\)")
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_ORPHAN_SPACE = re.compile(r"\s+([.,;:!?])")


def _plain(text: str) -> str:
    """The words of a line of notes, without the markup a dialog cannot show.

    Credits go first, while the links that make them a credit list are still
    there; replacing a link with its label first would leave "(#77, #78)".
    """
    text = _CREDITS.sub("", text)
    text = _LINK.sub(r"\1", text).replace("**", "").replace("`", "")
    return " ".join(_ORPHAN_SPACE.sub(r"\1", text).split())


def _split_bullet(raw: str) -> tuple[str, str]:
    """The title a bullet leads with, and the sentence that explains it.

    The notes have used "**Title.** explanation" and "**Title** ([#7](…)):
    explanation". A bullet with no title of its own keeps all its words.
    """
    if raw.startswith("**"):
        end = raw.find("**", 2)
        if end > 2:
            title = _plain(raw[2:end]).rstrip(" .:")
            rest = _plain(raw[end + 2 :]).lstrip(" .:—–-")
            return title, rest
    text = _plain(raw)
    head, sep, tail = text.partition(": ")
    if sep and len(head) <= 60:
        return head.rstrip(" ."), tail
    return text, ""


def _notes(body: str) -> tuple[str, list[dict]]:
    """A release's notes as an opening sentence and the changes it lists.

    The notes have used two shapes: a `### Heading` with a paragraph under it,
    and a bullet that leads with a bold title. Reading both into a title and the
    sentence that explains it is what lets the dialog say what a change means
    instead of only naming it. The Install section closes every release and is
    not a change.
    """
    summary: list[str] = []
    changes: list[dict] = []
    # The change the paragraphs that follow are explaining.
    owner: dict | None = None
    minor = False

    for raw in body.replace("﻿", "").splitlines():
        line = raw.strip()
        if line.lower().startswith("## install"):
            break
        if line.startswith("## "):
            # "## What's new since v0.4.2" is a label, not a change; the oldest
            # release opened its extra list with "## Also included" instead.
            if _plain(line[3:]).lower() == "also included":
                minor = True
            owner = None
            continue
        if line.startswith("### "):
            text = _plain(line[4:])
            if text.lower() == "also included":
                minor = True
                owner = None
                continue
            owner = {"title": text, "detail": "", "minor": False}
            changes.append(owner)
            continue
        if line.startswith(("- ", "* ")):
            raw_item = line[2:].strip()
            if minor:
                # A smaller item is one short line in the notes; splitting it
                # would leave a title with no explanation under it.
                item = {"title": _plain(raw_item), "detail": "", "minor": True}
                changes.append(item)
                owner = None
                continue
            title, detail = _split_bullet(raw_item)
            if not title:
                continue
            item = {"title": title, "detail": detail, "minor": False}
            changes.append(item)
            owner = None if detail else item
            continue
        if not line:
            continue
        text = _plain(line)
        if owner is not None:
            owner["detail"] = f"{owner['detail']} {text}".strip()
        elif not changes:
            # A paragraph before the first change opens the release.
            summary.append(text)

    for change in changes:
        # A detail taken from after a title's colon continues that sentence.
        detail = change["detail"]
        if detail[:1].islower():
            change["detail"] = detail[:1].upper() + detail[1:]
    return " ".join(summary), changes


def _exe_asset(release: dict) -> dict | None:
    assets = release.get("assets")
    if not isinstance(assets, list):
        return None
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        if asset.get("name") != ASSET or asset.get("state") != "uploaded":
            continue
        if asset.get("browser_download_url"):
            return asset
    return None


def _download(release: Release, destination: Path) -> None:
    """Fetch the asset, prove it is the published one, then name it final.

    A truncated download or an HTML error page must never be able to replace a
    working exe, so the bytes only take the final name after the size and the
    sha256 both match what the release lists.
    """
    partial = destination.with_name(destination.name + ".part")
    digest = hashlib.sha256()
    written = 0
    try:
        with urlopen(
            Request(release.download, headers={"User-Agent": USER_AGENT}),
            timeout=DOWNLOAD_TIMEOUT,
        ) as response, open(partial, "wb") as handle:
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
                digest.update(chunk)
                written += len(chunk)
    except (HTTPError, URLError, OSError) as exc:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Could not download {release.tag}: {_describe(exc)}") from exc

    if release.size and written != release.size:
        partial.unlink(missing_ok=True)
        raise RuntimeError(
            f"{release.tag} arrived as {written} bytes, not the {release.size} the release lists."
        )
    if release.digest.startswith("sha256:") and digest.hexdigest() != release.digest[7:]:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"{release.tag} does not match the sha256 the release lists.")

    os.replace(partial, destination)
    logger.info("Downloaded %s (%s bytes, sha256 %s)", release.tag, written, digest.hexdigest()[:12])


def _check_writable(target: Path) -> None:
    """Fail with the folder's name, not halfway through a swap."""
    folder = target.parent
    probe = folder / ".write-test"
    try:
        probe.write_text("", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        raise RuntimeError(
            f"{folder} is not writable, so the exe cannot be replaced. "
            "Move YTMusic.exe somewhere this account owns and try again."
        ) from exc
    if not os.access(target, os.W_OK):
        raise RuntimeError(
            f"{target.name} is read-only. Clear the read-only attribute and try again."
        )


def _spawn(script: Path, target: Path, downloaded: Path, version: str) -> None:
    """Run the helper outside this process, with no window of its own.

    The paths go through the environment because cmd expands `%` inside a
    quoted argument too, and a folder name may contain one.

    PyInstaller's onefile bootloader tells its child where the extraction
    folder is with `_PYI_APPLICATION_HOME_DIR`. Inherited by the helper and
    then by the new exe, that path is the folder this process's bootloader is
    deleting, and the new build dies in "Failed to load Python DLL" before it
    extracts anything. The helper clears the same names again, since it is the
    process that hands its environment to the exe.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("_PYI_") and key != "_MEIPASS2"
    }
    env.update(
        {
            "YTM_EXE": str(target),
            "YTM_NEW": str(downloaded),
            "YTM_LOG": str(script.parent / "install.log"),
            "YTM_VERSION": version,
        }
    )
    flags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
    subprocess.Popen(
        ["cmd.exe", "/c", str(script)],
        cwd=str(script.parent),
        env=env,
        close_fds=True,
        creationflags=flags,
    )


def _write_script(folder: Path) -> Path:
    script = folder / "install-update.cmd"
    script.write_text(_HELPER, encoding="ascii", newline="\r\n")
    return script


def _is_newer(candidate: str, current: str) -> bool:
    candidate_key = _version_key(candidate)
    current_key = _version_key(current)
    return candidate_key is not None and current_key is not None and candidate_key > current_key


def _version_key(text: str) -> tuple[int, int, int] | None:
    match = _TAG.match((text or "").strip())
    if match is None:
        return None
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def _get_json(url: str, timeout: float) -> object:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _describe(exc: Exception) -> str:
    if isinstance(exc, HTTPError):
        return f"GitHub answered HTTP {exc.code}."
    if isinstance(exc, URLError):
        return f"Could not reach GitHub: {exc.reason}"
    text = str(exc).strip()
    return text or exc.__class__.__name__


def _as_size(value: object) -> int:
    return value if isinstance(value, int) else 0


_HELPER = f"""@echo off
setlocal
rem Written by app/features/updates.py. Paths arrive in the environment because
rem cmd expands a % inside a quoted argument too, and a folder name may hold one.
set "EXE=%YTM_EXE%"
set "NEW=%YTM_NEW%"
set "LOG=%YTM_LOG%"
set "TRIES=0"

rem This script runs from the old onefile build, whose bootloader left its
rem extraction folder in the environment. The new exe would inherit it, look
rem for python3xx.dll in a folder that is being deleted, and fail before it
rem extracts its own. Clear them so `start` hands the exe a clean one.
set "_PYI_APPLICATION_HOME_DIR="
set "_PYI_ARCHIVE_FILE="
set "_PYI_PARENT_PROCESS_LEVEL="
set "_PYI_SPLASH_IPC="
set "_MEIPASS2="

:rename
rem Windows refuses to delete or overwrite a running image but allows a rename,
rem and a onefile exe runs as a bootloader plus the app process. A rename that
rem works is the only reliable sign both have let go.
move /y "%EXE%" "%EXE%.old" >nul 2>&1
if not errorlevel 1 goto install
set /a TRIES+=1
if %TRIES% geq {_HELPER_TRIES} goto timeout
rem The helper has no console, so `timeout` refuses its input; ping waits.
ping -n 2 127.0.0.1 >nul
goto rename

:install
move /y "%NEW%" "%EXE%" >nul 2>&1
if errorlevel 1 goto restore
echo [%date% %time%] installed %YTM_VERSION% >>"%LOG%" 2>&1
rem WebView2's own processes can outlive the window by a moment and hold the
rem profile in %LOCALAPPDATA%; starting too soon makes the new window fail.
ping -n 3 127.0.0.1 >nul
start "" "%EXE%"
exit /b 0

:restore
rem Put the old exe back, so double-clicking it still opens something.
move /y "%EXE%.old" "%EXE%" >nul 2>&1
echo [%date% %time%] could not put %YTM_VERSION% in place; kept the previous exe >>"%LOG%" 2>&1
exit /b 1

:timeout
echo [%date% %time%] timed out waiting for %EXE% to be released >>"%LOG%" 2>&1
exit /b 1
"""
