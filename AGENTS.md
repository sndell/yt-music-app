# Agent notes

The UI is Vite in `ui`. The desktop window is Python (`app/main.py`, pywebview). In dev the window loads Vite and calls Python through `window.pywebview.api`. That object exists only inside the desktop window. A browser tab on the Vite port, including the Cursor browser, does not have it.

The main checkout is slot 0: Vite `5173`, probe `8765`, remote debugging `9222`. A worktree writes `app/dev/.dev-slot`, and its ports are those numbers plus the slot.

## Run

One Python window per checkout. A second `app\dev\watch.py` or debugger session on the same slot fights for that probe port.

UI, from `ui`:

```powershell
pnpm dev
```

Python, from the repo root:

```powershell
.\app\.venv\Scripts\python.exe app\dev\watch.py
```

`app\dev\watch.py` runs `main.py` with unbuffered logs and `ENV=dev`. Saving a `.py` file under `app` closes that window and starts it again. Wait for this line before judging the change:

```text
[dev] restarted app/features/music_api.py generation=4 pid=1234
```

The path is the file that changed. `generation` increases on every restart. Then read that same terminal for tracebacks and `logger` lines. `GET http://127.0.0.1:<probe>/health` returns `"ok": true` plus `pid`, `slot`, `generation`, and `restarted_files` once the new process is listening. On the main checkout the probe port is 8765. Elsewhere it is `8765` plus the slot from the `[dev] started` line.

If the window is closed or the process crashes, the watcher stays up and prints `[dev] exited code=N generation=4 files=app/features/music_api.py`. The same facts are appended to `app/dev/.dev-restarts.jsonl`. The next Python save starts it again.

Vite edits refresh inside the open window. Python edits close and reopen it. Wait for `[dev] restarted` and `/health` again before the next probe call.

`__pycache__`, `.cache`, and `.venv` do not trigger a restart.

## Check a change

The probe listens on `http://127.0.0.1:<probe>` while the dev window is running, and while a packaged exe was started with `DEVTOOLS=1` (that exe stays on port 8765). It uses the same API object the window exposes. Run the commands below from `app`. The samples use the main checkout's port. Add the slot when `app/dev/.dev-slot` is present.

`/call` and `/eval` responses include `X-Dev-Generation`, `X-Dev-Restart-Files`, and `X-Dev-Pid`. Match those to the generation you are testing.

Health:

```powershell
curl.exe -s http://127.0.0.1:8765/health
```

Call a public Python method (`POST /call`). This does not go through JavaScript. Send the JSON with the venv Python so PowerShell does not strip the quotes:

```powershell
.\.venv\Scripts\python.exe -c "import json,urllib.request; body=json.dumps({'method':'get_playlists','args':[]}).encode(); req=urllib.request.Request('http://127.0.0.1:8765/call', data=body, headers={'Content-Type':'application/json'}); print(urllib.request.urlopen(req, timeout=30).read().decode())"
```

Call through the real bridge, or read and click the live page (`POST /eval`). The expression runs in the desktop window. A returned promise, including `window.pywebview.api.*`, is waited on for up to 30 seconds. Change the `expression` string:

```powershell
.\.venv\Scripts\python.exe -c "import json,urllib.request; body=json.dumps({'expression':'window.pywebview.api.get_playlists()'}).encode(); req=urllib.request.Request('http://127.0.0.1:8765/eval', data=body, headers={'Content-Type':'application/json'}); print(urllib.request.urlopen(req, timeout=30).read().decode())"
```

```powershell
.\.venv\Scripts\python.exe -c "import json,urllib.request; body=json.dumps({'expression':'document.body.innerText'}).encode(); req=urllib.request.Request('http://127.0.0.1:8765/eval', data=body, headers={'Content-Type':'application/json'}); print(urllib.request.urlopen(req, timeout=30).read().decode())"
```

```powershell
.\.venv\Scripts\python.exe -c "import json,urllib.request; body=json.dumps({'expression':'document.querySelector(\'a\').click()'}).encode(); req=urllib.request.Request('http://127.0.0.1:8765/eval', data=body, headers={'Content-Type':'application/json'}); print(urllib.request.urlopen(req, timeout=30).read().decode())"
```

A success body is JSON. A failure is HTTP 500 with the error text. The Python terminal also logs the call and any traceback from the API method. Names starting with `_` are rejected.

`/call` can run before the page has finished loading. `/eval` waits until the webview is ready.

## Whose error

Before you edit, read `/health` and remember `generation` and `restarted_files`.

After a Python save, wait until `generation` increases and `/health` returns `"ok": true`.

The failure is yours only when every path in `restarted_files` is a file you wrote, and the traceback names one of those files.

If the list contains any other file, stop. That save owns the failure. The sequence is in `app/dev/.dev-restarts.jsonl` and in the watcher line. Do not edit that file to make your check pass.

A restart whose file list mixes your file with another save is not yours alone. Wait until a later generation lists only your files, then test again.

## Another feature

Cursor creates the worktree. This repo does not. A chat that is already open on this folder stays here.

In the Agents Window, set Cursor Settings → Agents → Conversation → Default Environment to New Worktree (Cursor 3.11.6 or later). New Agent and the "+" on this repo then start in a fresh checkout. The editor chat does not use that setting. Start an editor request with `/worktree`. `/apply-worktree` brings the result back. `/delete-worktree` removes the checkout.

Setup installs the UI dependencies, copies `app/browser.json` when the new checkout has none, and writes `app/dev/.dev-python` and `app/dev/.dev-slot`. Run `pnpm dev` from that worktree's `ui`. Run `app\dev\watch.py` with the interpreter path stored in `app/dev/.dev-python` (the main checkout's venv). The window and the probe use that slot's ports.

One `app\dev\watch.py` per worktree. Two agents in the same folder still share one app. The restart log names the files behind the current process.

## Breakpoints

Use the `Python: YTMusic` launch config. It starts `app/main.py` with the venv, `cwd` `app`, and `ENV=dev`. The probe listens on this checkout's slot port (8765 on the main checkout). Do not run `app\dev\watch.py` at the same time: a save would kill the debug session, and the port is already taken. Stop the debugger and return to `.\app\.venv\Scripts\python.exe app\dev\watch.py` from the repo root when finished.

## Build

From the repo root:

```powershell
.\build\build.ps1
```

That script typechecks the UI, runs `vite build --base ./`, then PyInstaller with `build/YTMusic.spec`. The packaged page needs that base path, so build with `build/build.ps1` rather than `pnpm build` alone. The result is a windowed onefile exe at `build\dist\<yyyy-MM-dd_HHmm>\YTMusic.exe`. Older builds stay in their folders.

The exe has no console. Python logs go to `%LOCALAPPDATA%\YTMusic\ytmusic.log`. The WebView2 profile, auth file, and cache live in that folder, not under `app\`.

The window serves `ui/dist` at `http://localhost:<port>/index.html`. It does not load the Vite dev server, and the probe on port 8765 stays off.

## Inspect

For ordinary Python and UI changes, use the dev window and this checkout's probe (`http://127.0.0.1:8765` on the main checkout). A browser tab on the Vite port, including the Cursor browser, is not the app.

To inspect the packaged window, or to open DevTools on the real WebView2, stop `app\dev\watch.py` first. Both would bind this checkout's probe port. Then, from the repo root, run the exe in the dated folder you want:

```powershell
$env:DEVTOOLS = "1"
.\build\dist\<yyyy-MM-dd_HHmm>\YTMusic.exe
```

The same variable works for the Vite window. Set it in the shell before `app\dev\watch.py`. `app\dev\watch.py` copies the parent environment into the app process.

`DEVTOOLS=1` turns WebView2 debug on, including for the frozen exe, and still serves the packaged page from that exe. It opens the DevTools window, and it listens for remote debugging on port 9222 plus the slot. The main checkout and the frozen exe use `http://127.0.0.1:9222/json/list`. It also starts the probe, so `/health`, `/call`, and `/eval` work against that window.

A normal `app\dev\watch.py` session and the `Python: YTMusic` launch config leave the DevTools window closed and do not open that port. Debug mode is still on there, so the page menu can open DevTools.
