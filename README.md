# YTMusic

A Windows desktop client for [YouTube Music](https://music.youtube.com). Sign in with your account, browse home, playlists, albums, and artists, and play from a queue that stays in sync with the hardware media keys.

<p align="center">
  <img src="docs/screenshot.png" alt="YTMusic window with a playlist open, the queue on the right, and a track menu showing Start mix, Play next, and Add to queue" width="920">
</p>

## Features

- Home shelves of songs, albums, and playlists, tinted from the cover art
- Playlist, album, and artist pages, with your playlists listed in the sidebar
- Playback through the YouTube player: seek, volume, shuffle, and repeat
- A queue with what already played, what is playing, and what is next
- Track actions: start a mix, play next, or add to the queue
- Like and dislike, written back to your YouTube Music account
- Windows media keys for play, pause, next, and previous, including when the window is in the background

## Requirements

- Windows 10 or later, with the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (already present on current Windows 11)
- [Python 3.15](https://www.python.org/downloads/)
- [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/)

## Run in development

Install the UI and start Vite:

```powershell
cd ui
pnpm install
pnpm dev
```

In a second terminal, create the Python environment in `app` and start the watcher from the repo root. It loads the Vite server at `http://localhost:5173`.

```powershell
cd app
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
.\app\.venv\Scripts\python.exe dev\watch.py
```

`dev\watch.py` restarts the window when a Python file under `app` or `dev` is saved. Vite refreshes the page in place. Keep a single Python window per checkout. A second feature should be a Cursor worktree: in the Agents Window set Default Environment to New Worktree, or start an editor chat with `/worktree`. That checkout gets its own window and ports.

Sign in from **Settings**. The app opens YouTube Music, waits until you are logged in, and stores the request it needs. Auth, the WebView2 profile, and the cache stay in the `app` folder while you are developing.

## Build

From the repo root:

```powershell
.\build\build.ps1
```

That typechecks the UI, builds it with the base path the packaged page needs, and runs PyInstaller. The result is `dist\YTMusic.exe`.

The exe has no console. Logs go to `%LOCALAPPDATA%\YTMusic\ytmusic.log`. The WebView2 profile, auth file, and cache live in that same folder.

## Layout

| Path | What it is |
| --- | --- |
| `app/` | The desktop window, YouTube Music API, and Windows media keys |
| `dev/` | Restart watcher, probe, and port identity |
| `ui/` | The React interface (Vite, TypeScript, Tailwind) |
| `build/build.ps1` | UI build plus the onefile exe |
| `build/YTMusic.spec` | PyInstaller spec used by the build script |

YTMusic is an independent client. It is not affiliated with YouTube or Google.
