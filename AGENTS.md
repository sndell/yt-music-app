# Agent notes

The UI is Vite in `ui`. The desktop window is Python (`app/main.py`, pywebview). In dev the window loads `http://localhost:5173` and calls Python through `window.pywebview.api`. That object exists only inside the desktop window. A browser tab on port 5173, including the Cursor browser, does not have it.

## Run

One Python window only. A second `dev.py` or debugger session fights for port 8765.

UI, from `ui`:

```powershell
pnpm dev
```

Python, from `app`:

```powershell
.\.venv\Scripts\python.exe dev.py
```

`dev.py` runs `main.py` with unbuffered logs and `ENV=dev`. Saving a `.py` file under `app` closes that window and starts it again. Wait for this line before judging the change:

```text
[dev] restarted app/features/music_api.py pid=1234
```

The path is the file that changed. Then read that same terminal for tracebacks and `logger` lines. `GET http://127.0.0.1:8765/health` returns `{"ok": true}` once the new process is listening.

If the window is closed or the process crashes, the watcher stays up and prints `[dev] exited code=N`. The next Python save starts it again.

Vite edits refresh inside the open window. Python edits close and reopen it. Wait for `[dev] restarted` and `/health` again before the next probe call.

`__pycache__`, `.cache`, and `.venv` do not trigger a restart.

## Check a change

The probe listens on `http://127.0.0.1:8765` only while the dev window is running. It uses the same API object the window exposes. Run the commands below from `app`.

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

## Breakpoints

Use the `Python: YTMusic` launch config. It starts `app/main.py` with the venv, `cwd` `app`, and `ENV=dev`. The probe still listens on port 8765. Do not run `dev.py` at the same time: a save would kill the debug session, and the port is already taken. Stop the debugger and return to `python dev.py` when finished.
