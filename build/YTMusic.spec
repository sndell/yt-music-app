# -*- mode: python ; coding: utf-8 -*-
"""Onefile windowed build. Run from the repo root via build/build.ps1."""

from pathlib import Path

from PyInstaller.utils.hooks import collect_all

root = Path(SPECPATH).parent
ui_dist = root / "ui" / "dist"
if not (ui_dist / "index.html").is_file():
    raise SystemExit(f"Missing {ui_dist / 'index.html'}. Run the UI build first.")

datas = [(str(ui_dist), "ui")]
binaries = []
hiddenimports = []

for package in ("webview", "pythonnet", "clr_loader", "ytmusicapi"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

a = Analysis(
    [str(root / "app" / "main.py")],
    pathex=[str(root / "app"), str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="YTMusic",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
)
