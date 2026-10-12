"""Windows media keys for the desktop window.

Hardware play, pause, next, and previous keys are delivered to the app that owns
System Media Transport Controls, including when the window is unfocused. pywinrt
has no installable wheel for this interpreter, so this module calls the Windows
Runtime COM interfaces directly.
"""

from __future__ import annotations

import base64
import ctypes
import io
import logging
import os
import sys
import threading
import time
from ctypes import (
    HRESULT,
    POINTER,
    byref,
    c_byte,
    c_int,
    c_int64,
    c_ubyte,
    c_uint32,
    c_ulong,
    c_ulonglong,
    c_void_p,
    c_wchar_p,
)
from dataclasses import dataclass
from urllib.request import Request, urlopen

from util.webview_controller import WebViewController

logger = logging.getLogger(__name__)

_E_NOINTERFACE = 0x80004002
_CLOSED = 0
_PLAYING = 3
_PAUSED = 4
_MUSIC = 1

_COMMANDS = {0: "play", 1: "pause", 6: "next", 7: "previous"}


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]


def _guid(value: str) -> GUID:
    parts = value.split("-")
    tail = bytes.fromhex(parts[3] + parts[4])
    return GUID(int(parts[0], 16), int(parts[1], 16), int(parts[2], 16), (ctypes.c_ubyte * 8)(*tail))


def _same_guid(left: GUID, right: GUID) -> bool:
    return bytes(left) == bytes(right)


_IID_IUNKNOWN = _guid("00000000-0000-0000-C000-000000000046")
_IID_AGILE = _guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")
_IID_ASYNC_INFO = _guid("00000036-0000-0000-C000-000000000046")
_IID_INTEROP = _guid("DDB0472D-C911-4A1F-86D9-DC3D71A95F5A")
_IID_SMTC = _guid("99FA3FF4-1742-42A6-902E-087D41F965EC")
_IID_UPDATER = _guid("8ABBC53E-FA55-4ECF-AD8E-C984E5DD1550")
_IID_MUSIC = _guid("6BBF0C59-D0A0-4D26-92A0-F978E1D18E7B")
_IID_HANDLER = _guid("0557E996-7B23-5BAE-AA81-EA0D671143A4")
_IID_DATA_WRITER_FACTORY = _guid("338C67C2-8B84-4C2B-9C50-7B8767847A1F")
_IID_STREAM_REFERENCE_STATICS = _guid("857309DC-3FBF-4E7D-986F-EF3B1A07A964")

_ASYNC_COMPLETED = 1
_ASYNC_CANCELED = 2
_ASYNC_ERROR = 3
_MAX_COVER_BYTES = 2_000_000


def _check(hr: int, action: str) -> None:
    if hr < 0:
        raise OSError(f"{action} failed: 0x{hr & 0xFFFFFFFF:08X}")


def _method(interface: c_void_p, index: int, restype, *argtypes):
    table = ctypes.cast(interface, POINTER(c_void_p))[0]
    address = ctypes.cast(table, POINTER(c_void_p))[index]
    prototype = ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)
    return prototype(address)


def _release(interface: c_void_p | None) -> None:
    if interface:
        _method(interface, 2, c_ulong)(interface)


_combase = ctypes.windll.combase
_combase.WindowsCreateString.argtypes = [c_wchar_p, ctypes.c_uint32, POINTER(c_void_p)]
_combase.WindowsCreateString.restype = HRESULT
_combase.WindowsDeleteString.argtypes = [c_void_p]
_combase.WindowsDeleteString.restype = HRESULT
_combase.RoGetActivationFactory.argtypes = [c_void_p, POINTER(GUID), POINTER(c_void_p)]
_combase.RoGetActivationFactory.restype = HRESULT
_combase.RoActivateInstance.argtypes = [c_void_p, POINTER(c_void_p)]
_combase.RoActivateInstance.restype = HRESULT


def _hstring(text: str) -> c_void_p:
    handle = c_void_p()
    hr = _combase.WindowsCreateString(text, len(text), byref(handle))
    _check(hr, "WindowsCreateString")
    return handle


def _free_hstring(handle: c_void_p) -> None:
    if handle:
        _combase.WindowsDeleteString(handle)


def _activate(class_name: str) -> c_void_p:
    name = _hstring(class_name)
    instance = c_void_p()
    try:
        hr = _combase.RoActivateInstance(name, byref(instance))
        _check(hr, class_name)
        return instance
    finally:
        _free_hstring(name)


def _factory(class_name: str, iid: GUID) -> c_void_p:
    name = _hstring(class_name)
    factory = c_void_p()
    try:
        hr = _combase.RoGetActivationFactory(name, byref(iid), byref(factory))
        _check(hr, class_name)
        return factory
    finally:
        _free_hstring(name)


def _await_bytes(operation: c_void_p) -> None:
    """Wait until a WinRT async operation has finished and collect its result."""
    info = c_void_p()
    hr = _method(operation, 0, HRESULT, POINTER(GUID), POINTER(c_void_p))(
        operation, byref(_IID_ASYNC_INFO), byref(info)
    )
    _check(hr, "QueryInterface IAsyncInfo")
    try:
        deadline = time.monotonic() + 5
        while True:
            status = c_int()
            hr = _method(info, 7, HRESULT, POINTER(c_int))(info, byref(status))
            _check(hr, "get_Status")
            if status.value == _ASYNC_COMPLETED:
                break
            if status.value == _ASYNC_CANCELED:
                raise OSError("cover write canceled")
            if status.value == _ASYNC_ERROR:
                code = c_int()
                hr = _method(info, 8, HRESULT, POINTER(c_int))(info, byref(code))
                _check(hr, "get_ErrorCode")
                raise OSError(f"cover write failed: 0x{code.value & 0xFFFFFFFF:08X}")
            if time.monotonic() >= deadline:
                raise TimeoutError("cover write timed out")
            time.sleep(0.01)
    finally:
        _release(info)
    written = c_uint32()
    hr = _method(operation, 8, HRESULT, POINTER(c_uint32))(operation, byref(written))
    _check(hr, "GetResults")


def _jpeg_from_artwork(artwork: str) -> bytes | None:
    if artwork.startswith("data:"):
        header, _, payload = artwork.partition(",")
        if ";base64" not in header or not payload:
            return None
        raw = base64.b64decode(payload, validate=False)
    elif artwork.startswith(("http://", "https://")):
        request = Request(artwork, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(request, timeout=10) as response:
            raw = response.read(_MAX_COVER_BYTES + 1)
        if len(raw) > _MAX_COVER_BYTES:
            return None
    else:
        return None

    if not raw:
        return None
    if raw.startswith(b"\xff\xd8\xff") and len(raw) <= 512 * 1024:
        return raw

    from PIL import Image

    image = Image.open(io.BytesIO(raw))
    image = image.convert("RGB")
    image.thumbnail((512, 512))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue()


def _reference_from_jpeg(jpeg: bytes) -> tuple[c_void_p, c_void_p]:
    """Copy JPEG bytes into a stream Windows can show as the media thumbnail.

    The stream and the reference that points at it both have to stay alive.
    The flyout reads them when the display properties are published.
    """
    stream = _activate("Windows.Storage.Streams.InMemoryRandomAccessStream")
    try:
        output = c_void_p()
        hr = _method(stream, 9, HRESULT, c_ulonglong, POINTER(c_void_p))(stream, 0, byref(output))
        _check(hr, "GetOutputStreamAt")
        try:
            _write_all(output, jpeg)
        finally:
            _release(output)
        hr = _method(stream, 11, HRESULT, c_ulonglong)(stream, 0)
        _check(hr, "Seek")
        size = c_ulonglong()
        hr = _method(stream, 6, HRESULT, POINTER(c_ulonglong))(stream, byref(size))
        _check(hr, "get_Size")
        if size.value != len(jpeg):
            raise OSError(f"cover stream size {size.value} != {len(jpeg)}")
        reference = _create_from_stream(stream)
        return stream, reference
    except Exception:
        _release(stream)
        raise


def _write_all(output: c_void_p, jpeg: bytes) -> None:
    factory = _factory("Windows.Storage.Streams.DataWriter", _IID_DATA_WRITER_FACTORY)
    try:
        writer = c_void_p()
        hr = _method(factory, 6, HRESULT, c_void_p, POINTER(c_void_p))(factory, output, byref(writer))
        _check(hr, "CreateDataWriter")
        try:
            buffer = (c_ubyte * len(jpeg)).from_buffer_copy(jpeg)
            hr = _method(writer, 12, HRESULT, c_uint32, POINTER(c_ubyte))(writer, len(jpeg), buffer)
            _check(hr, "WriteBytes")
            operation = c_void_p()
            hr = _method(writer, 29, HRESULT, POINTER(c_void_p))(writer, byref(operation))
            _check(hr, "StoreAsync")
            try:
                _await_bytes(operation)
            finally:
                _release(operation)
            detached = c_void_p()
            hr = _method(writer, 32, HRESULT, POINTER(c_void_p))(writer, byref(detached))
            _check(hr, "DetachStream")
            _release(detached)
        finally:
            _release(writer)
    finally:
        _release(factory)


def _create_from_stream(stream: c_void_p) -> c_void_p:
    factory = _factory("Windows.Storage.Streams.RandomAccessStreamReference", _IID_STREAM_REFERENCE_STATICS)
    try:
        reference = c_void_p()
        hr = _method(factory, 8, HRESULT, c_void_p, POINTER(c_void_p))(factory, stream, byref(reference))
        _check(hr, "CreateFromStream")
        return reference
    finally:
        _release(factory)


@dataclass
class _CoverUpdate:
    key: str
    stream: c_void_p | None = None
    reference: c_void_p | None = None


_UNCHANGED = object()


class _Vtbl(ctypes.Structure):
    pass


_QueryInterface = ctypes.WINFUNCTYPE(HRESULT, c_void_p, POINTER(GUID), POINTER(c_void_p))
_AddRef = ctypes.WINFUNCTYPE(c_ulong, c_void_p)
_Release = ctypes.WINFUNCTYPE(c_ulong, c_void_p)
_Invoke = ctypes.WINFUNCTYPE(HRESULT, c_void_p, c_void_p, c_void_p)

_Vtbl._fields_ = [
    ("QueryInterface", _QueryInterface),
    ("AddRef", _AddRef),
    ("Release", _Release),
    ("Invoke", _Invoke),
]


class _HandlerObject(ctypes.Structure):
    _fields_ = [("lpVtbl", POINTER(_Vtbl))]


class MediaControls:
    def __init__(self) -> None:
        self._form = None
        self._smtc: c_void_p | None = None
        self._handler: _HandlerObject | None = None
        self._callbacks: tuple | None = None
        self._pending: tuple[str, str, bool, bool, _CoverUpdate | object] | None = None
        self._cover_key = ""
        self._cover_stream: c_void_p | None = None
        self._cover_ref: c_void_p | None = None
        self._refs = 1
        self._lock = threading.Lock()

    def attach(self, window) -> None:
        if sys.platform != "win32":
            return
        form = window.native
        hwnd = int(form.Handle.ToInt64())
        self._form = form
        self._smtc = self._open_controls(hwnd)
        self._subscribe()
        logger.info("Media controls attached")
        pending = self._pending
        self._pending = None
        if pending is not None:
            self._apply(*pending)

    def update(self, title: str, artist: str, playing: bool, has_next: bool, artwork: str = "") -> None:
        if sys.platform != "win32":
            return
        cover = self._prepare_cover(artwork)
        state = (title, artist, bool(playing), bool(has_next), cover)
        form = self._form
        if form is None or self._smtc is None:
            previous = self._pending
            self._pending = state
            if previous is not None:
                self._discard_cover(previous[4])
            return

        def apply() -> None:
            try:
                self._apply(*state)
            except Exception:
                logger.exception("Failed to update media controls")
                self._discard_cover(cover)

        try:
            if form.InvokeRequired:
                from System import Action

                form.BeginInvoke(Action(apply))
            else:
                apply()
        except Exception:
            logger.exception("Failed to dispatch media control update")
            self._discard_cover(cover)

    def _open_controls(self, hwnd: int) -> c_void_p:
        class_name = _hstring("Windows.Media.SystemMediaTransportControls")
        factory = c_void_p()
        try:
            hr = _combase.RoGetActivationFactory(class_name, byref(_IID_INTEROP), byref(factory))
            _check(hr, "RoGetActivationFactory")
            controls = c_void_p()
            hr = _method(factory, 6, HRESULT, c_void_p, POINTER(GUID), POINTER(c_void_p))(
                factory, c_void_p(hwnd), byref(_IID_SMTC), byref(controls)
            )
            _check(hr, "GetForWindow")
            return controls
        finally:
            _free_hstring(class_name)
            _release(factory)

    def _subscribe(self) -> None:
        def query_interface(this, riid, ppv):
            try:
                iid = riid.contents
                if _same_guid(iid, _IID_IUNKNOWN) or _same_guid(iid, _IID_HANDLER) or _same_guid(iid, _IID_AGILE):
                    self._add_ref(this)
                    ppv[0] = this
                    return 0
                ppv[0] = None
                return _E_NOINTERFACE
            except Exception:
                logger.exception("Media control QueryInterface failed")
                return _E_NOINTERFACE

        def add_ref(_this):
            with self._lock:
                self._refs += 1
                return self._refs

        def release(_this):
            with self._lock:
                self._refs = max(1, self._refs - 1)
                return self._refs

        def invoke(_this, _sender, args):
            try:
                button = c_int()
                hr = _method(args, 6, HRESULT, POINTER(c_int))(args, byref(button))
                if hr < 0:
                    logger.warning("Media control button read failed: 0x%08X", hr & 0xFFFFFFFF)
                    return 0
                command = _COMMANDS.get(button.value)
                if command:
                    threading.Thread(
                        target=WebViewController.dispatch_event,
                        args=(command,),
                        daemon=True,
                    ).start()
            except Exception:
                logger.exception("Media control button failed")
            return 0

        self._add_ref = add_ref
        callbacks = (
            _QueryInterface(query_interface),
            _AddRef(add_ref),
            _Release(release),
            _Invoke(invoke),
        )
        self._callbacks = callbacks
        table = _Vtbl(*callbacks)
        self._table = table
        handler = _HandlerObject(ctypes.pointer(table))
        self._handler = handler
        token = c_int64()
        handler_ptr = ctypes.cast(ctypes.pointer(handler), c_void_p)
        self._handler_ptr = handler_ptr
        hr = _method(self._smtc, 32, HRESULT, c_void_p, POINTER(c_int64))(
            self._smtc, handler_ptr, byref(token)
        )
        _check(hr, "add_ButtonPressed")

    def _apply(
        self, title: str, artist: str, playing: bool, has_next: bool, cover: _CoverUpdate | object = _UNCHANGED
    ) -> None:
        controls = self._smtc
        if controls is None:
            previous = self._pending
            self._pending = (title, artist, playing, has_next, cover)
            if previous is not None:
                self._discard_cover(previous[4])
            return
        if not title:
            self._put_bool(controls, 11, False)
            self._put_int(controls, 7, _CLOSED)
            self._discard_cover(cover)
            self._replace_cover(None, None)
            with self._lock:
                self._cover_key = ""
            return

        self._put_bool(controls, 11, True)
        self._put_bool(controls, 13, True)
        self._put_bool(controls, 17, True)
        self._put_bool(controls, 25, True)
        self._put_bool(controls, 27, has_next)

        updater = c_void_p()
        hr = _method(controls, 8, HRESULT, POINTER(c_void_p))(controls, byref(updater))
        _check(hr, "get_DisplayUpdater")
        try:
            self._put_int(updater, 7, _MUSIC)
            music = c_void_p()
            hr = _method(updater, 12, HRESULT, POINTER(c_void_p))(updater, byref(music))
            _check(hr, "get_MusicProperties")
            try:
                self._put_string(music, 7, title)
                self._put_string(music, 11, artist)
            finally:
                _release(music)
            self._publish_cover(updater, cover)
            hr = _method(updater, 17, HRESULT)(updater)
            _check(hr, "DisplayUpdater.Update")
            if isinstance(cover, _CoverUpdate):
                with self._lock:
                    self._cover_key = cover.key
                if cover.reference is not None:
                    logger.info("Media cover published")
        finally:
            _release(updater)

        self._put_int(controls, 7, _PLAYING if playing else _PAUSED)

    def _prepare_cover(self, artwork: str) -> _CoverUpdate | object:
        artwork = artwork or ""
        with self._lock:
            if artwork == self._cover_key:
                return _UNCHANGED
        if not artwork:
            return _CoverUpdate("")
        try:
            jpeg = _jpeg_from_artwork(artwork)
            if not jpeg:
                logger.warning("Media cover unavailable")
                return _CoverUpdate(artwork)
            stream, reference = _reference_from_jpeg(jpeg)
            logger.info("Media cover ready (%d bytes)", len(jpeg))
            return _CoverUpdate(artwork, stream, reference)
        except Exception:
            logger.exception("Failed to prepare media cover")
            return _CoverUpdate(artwork)

    def _publish_cover(self, updater: c_void_p, cover: _CoverUpdate | object) -> None:
        if cover is _UNCHANGED:
            self._rewind_cover()
            return
        if not isinstance(cover, _CoverUpdate):
            return
        # DisplayUpdater.put_Thumbnail is vtable slot 11.
        hr = _method(updater, 11, HRESULT, c_void_p)(updater, cover.reference)
        _check(hr, "put_Thumbnail")
        if cover.reference is not None:
            current = c_void_p()
            hr = _method(updater, 10, HRESULT, POINTER(c_void_p))(updater, byref(current))
            _check(hr, "get_Thumbnail")
            if not current.value:
                logger.warning("Media cover was not retained")
            _release(current)
        self._replace_cover(cover.stream, cover.reference)
        self._rewind_cover()

    def _rewind_cover(self) -> None:
        stream = self._cover_stream
        if not stream:
            return
        hr = _method(stream, 11, HRESULT, c_ulonglong)(stream, 0)
        _check(hr, "Seek")

    def _replace_cover(self, stream: c_void_p | None, reference: c_void_p | None) -> None:
        old_stream, old_ref = self._cover_stream, self._cover_ref
        self._cover_stream = stream
        self._cover_ref = reference
        if old_ref is not None and (reference is None or old_ref.value != reference.value):
            _release(old_ref)
        if old_stream is not None and (stream is None or old_stream.value != stream.value):
            _release(old_stream)

    def _discard_cover(self, cover: _CoverUpdate | object) -> None:
        if not isinstance(cover, _CoverUpdate):
            return
        if self._cover_ref is not None and cover.reference is not None and self._cover_ref.value == cover.reference.value:
            return
        _release(cover.reference)
        _release(cover.stream)

    def _put_bool(self, interface: c_void_p, index: int, value: bool) -> None:
        hr = _method(interface, index, HRESULT, c_byte)(interface, 1 if value else 0)
        _check(hr, "put boolean")

    def _put_int(self, interface: c_void_p, index: int, value: int) -> None:
        hr = _method(interface, index, HRESULT, c_int)(interface, value)
        _check(hr, "put int")

    def _put_string(self, interface: c_void_p, index: int, value: str) -> None:
        handle = _hstring(value)
        try:
            hr = _method(interface, index, HRESULT, c_void_p)(interface, handle)
            _check(hr, "put string")
        finally:
            _free_hstring(handle)


media_controls = MediaControls()


def _with_disabled_features(args: str, features: tuple[str, ...]) -> str:
    missing = [feature for feature in features if feature not in args]
    if not missing:
        return args
    addition = ",".join(missing)
    if "--disable-features=" in args:
        return args.replace("--disable-features=", f"--disable-features={addition},", 1)
    return f"{args} --disable-features={addition}".strip()


def prepare_webview() -> None:
    """Keep hardware media keys for the app instead of the page audio element."""
    if sys.platform != "win32":
        return

    extra = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
    extra = _with_disabled_features(extra, ("HardwareMediaKeyHandling",))
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = extra

    import webview.platforms.edgechromium as edge

    original = edge.EdgeChrome.__init__

    def init(self, form, window, cache_dir):
        original(self, form, window, cache_dir)
        props = self.webview.CreationProperties
        args = _with_disabled_features(props.AdditionalBrowserArguments or "", ("HardwareMediaKeyHandling",))
        props.AdditionalBrowserArguments = args
        logger.info("WebView2 browser arguments: %s", props.AdditionalBrowserArguments)

    edge.EdgeChrome.__init__ = init
