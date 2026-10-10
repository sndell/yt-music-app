"""Give the YouTube embed the same login the API already has.

Sign-in stores the account cookies for Python. The embed is a youtube.com frame
inside the app page, so Edge will not send those cookies unless they are on
.youtube.com and allowed on a third-party request. Dev works because that
profile already has them. The packaged profile often does not.
"""

from __future__ import annotations

import json
import logging

from util.app_paths import data_dir

logger = logging.getLogger(__name__)


def _cookie_header() -> str | None:
    path = data_dir() / "browser.json"
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Could not read login cookies: %s", exc)
        return None
    cookie = payload.get("cookie") if isinstance(payload, dict) else None
    return cookie if isinstance(cookie, str) and cookie else None


def _pairs(header: str) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for part in header.split(";"):
        name, separator, value = part.strip().partition("=")
        if separator and name:
            pairs.append((name, value))
    return pairs


def write_login_cookies(core: object) -> None:
    """Copy browser.json cookies onto .youtube.com for this WebView2 profile."""
    header = _cookie_header()
    if not header:
        return

    from System import DateTime
    from Microsoft.Web.WebView2.Core import CoreWebView2CookieSameSiteKind

    same_site = getattr(CoreWebView2CookieSameSiteKind, "None")
    expires = DateTime.UtcNow.AddDays(30)
    manager = core.CookieManager  # type: ignore[attr-defined]
    written = 0
    for name, value in _pairs(header):
        cookie = manager.CreateCookie(name, value, ".youtube.com", "/")
        cookie.IsSecure = True
        cookie.IsHttpOnly = True
        cookie.SameSite = same_site
        cookie.Expires = expires
        manager.AddOrUpdateCookie(cookie)
        written += 1
    logger.info("Synced %d YouTube login cookies into the embed", written)


def sync_login_cookies() -> None:
    """Write the saved login into the open app window. Safe to call off the UI thread."""
    from System import Func, Type

    from util.webview_controller import WebViewController

    window = WebViewController._window
    native = getattr(window, "native", None) if window is not None else None
    if native is None:
        return

    def run() -> None:
        write_login_cookies(native.webview.CoreWebView2)

    try:
        if native.InvokeRequired:
            native.Invoke(Func[Type](run))
        else:
            run()
    except Exception as exc:
        logger.warning("Could not sync login cookies into the embed: %s", exc)
