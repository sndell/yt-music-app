# Agent notes

The UI is Vite in `ui`. The desktop window is Python (`app/main.py`, pywebview). In dev the window loads Vite and calls Python through `window.pywebview.api`. That object exists only inside the desktop window. A browser tab on the Vite port, including the Cursor browser, does not have it.

The main checkout is slot 0: Vite `5173`, probe `8765`, remote debugging `9222`. A worktree writes `app/dev/.dev-slot`, and its ports are those numbers plus the slot. Two numbers matter. `DEV_UI_SLOT` is the checkout slot, which picks the Vite port and the URL the window loads. `DEV_SLOT` is the instance slot, which picks the probe port, the CDP port, and the WebView2 profile. They are equal for the default session.

## Apply unslop by default

Run the `unslop` skill (id `unslop`, installed in the global skills source) over all prose in this repo: chat replies, commits, PR text, UI copy, and edits to this file. It is hidden from the model's skill list, so load it yourself with `@unslop` or the skill tool before finalizing text. The existing notes in this file keep their wording; apply unslop to what you add.

## Never destroy what the user has

The signed-in YouTube Music account is the user's data. It is read-only unless this exact conversation asked for a change. Deleting is the one thing that cannot be undone, so it is a hard stop, not a judgement call:

- Never delete a playlist, a song in a playlist, a Like, a library item, an upload, or a history entry.
- Never delete anything you did not create in this same session.
- Never delete or overwrite a file in this repo that the task did not put in play. No `git clean`, no removing directories, no "tidying" files outside the change.
- Never change a playlist's title, description, visibility, or track order unless the task asked for that change.
- Never clear, empty, or reset the queue, the cache, or stored preferences to "fix" a problem.
- The probe and the tests write to the real account too. Treat `call create_playlist`, `call delete_playlist`, `call add_playlist_items`, `call remove_playlist_items`, `call edit_playlist`, `call rate_playlist` and `call rate_song` as account writes, not as experiments.
- If a task looks like it needs any of this, stop and ask the user. Do not decide for them.
- Reading is always fine: `get_playlists`, `get_playlist_items`, `state`, `logs`, `screenshot`.

## Keep these notes current

The app changes, so these notes change with it. While you work, watch for a better way to debug, inspect, track, upgrade, or implement something in this repo. When you find one, add it to this file before you finish, so the next agent starts with it instead of rediscovering it.

Write it the way the rest of this file is written: what to run or check, when it helps, and the trap that wastes time. Short and specific, from a real run, not a guess. Do not rewrite or delete notes you have not verified.

Add only what running the repo taught you. No note about your own edit, no in-joke, no "do not delete this"; the next agent cannot use it.

## Do what they meant

Treat a request as the intent behind it, not a literal script. When someone asks for X, work out what X implies and do the parts that are clearly the same change: a renamed method moves its callers, a new field reaches the type, the parser, the stored shape and the UI, a fixed bug gets the test that would have caught it. Before you call it done, search for the other places the change touches.

Stay inside that intent. Do not redesign, reformat, or refactor what nobody asked about, and do not pile on improvements. When the implied work is large, risky, or genuinely ambiguous, do the safe part, say what you skipped, and why.

## Fan the work out

Orchestration is cheap here and usually wins. Split off anything that does not depend on what you are doing: ask an explore subagent "where does this live / how does it work", give a self-contained chunk to a general subagent, and run builds, tests, installs, and long commands as background shells instead of blocking on them. Start dev servers in the background too (see Run). Fire independent calls in the same block so they overlap, and keep the main thread for the decisions and the edits that need it.

Do not parallelize steps that depend on each other, and never let two workers edit the same file: one writer per file. When the pieces come back, check they actually fit together before you trust the result. Parallelism buys time, it does not lower the bar for being right.

## Shell

The repo is Windows-only (pywebview + WebView2, PowerShell build script). Run commands as PowerShell. Use `curl.exe`, not `curl` (an alias for `Invoke-WebRequest` in Windows PowerShell). For JSON POSTs to the probe, use the venv Python one-liners below so quoting survives.

## Run

One Python window per checkout. A second `app\dev\watch.py` or debugger session on the same slot fights for that probe port.

`tools\dev.py up` starts Vite and the watcher with `CREATE_NO_WINDOW`, and the watcher gives the app that flag too when the watcher's own output is on a log file. So a worktree started that way shows only the pywebview window, with no console window. `tools\dev.py up --attach` runs Vite and the watcher in the calling shell instead, so the `[dev]` lines land there and the task stays visibly running; run that one as a background task. Start `app\dev\watch.py` in a terminal when you want the app's tracebacks in that terminal; then the app inherits it and no extra window appears.

`pnpm dev` never exits. `app\dev\watch.py` runs until the window it started is closed (see below). Start each as a background task, not a foreground command. Ask `tools\dev.py doctor` whether this checkout is up; do not probe a fixed port. On the main checkout `8765` is right, but in a worktree `8765` is the main checkout's window, so a response there says nothing about yours.

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

Closing the window ends the session. The app stops the Vite server it was loading from, found through the checkout's UI port, so it works for `tools\dev.py up`, a raw `pnpm dev`, or the `Python: YTMusic` launch config. The watcher prints `[dev] exited code=0 ...` then `[dev] session ended`, and exits, releasing the checkout slot. A crash is different. The watcher prints `[dev] exited code=N generation=4 files=app/features/music_api.py`, stays up, and the next Python save starts the app again. Both events go to `app/dev/.dev-restarts.jsonl`.

Vite listens on `localhost`, which is the IPv6 loopback `[::1]` on this machine, so `netstat -ano -p tcp` shows no listener for its port. Look it up with `netstat -ano`, or `Get-NetTCPConnection -LocalPort 5173`. The stop code is `app/dev/vite_server.py`; `app/tests/test_vite_server.py` covers it.

A watcher that dies is quiet. It prints `[dev] started slot=... generation=1 pid=...` and then stops, while the app process it already spawned keeps working, so `state` and `/health` look healthy and every save silently does nothing. Read the tail of `app/dev/.dev-artifacts/app.log` or the `start`/`restart` records in `.dev-restarts.jsonl` before blaming the app. Nothing in `tools/test.ps1` imported `app/dev/watch.py`, so a `NameError` in it went unnoticed until a live run; `app/tests/test_watch.py` covers it now.

`subprocess.Popen().pid` is not always the real process pid here; a shim process sits in between. The watcher's `[dev] restarted ... pid=` can differ from `/health`'s `pid` for the same window. Use `/health` for the app's pid and `netstat -ano` for whoever holds a port.

Vite edits refresh inside the open window. Python edits close and reopen it. Wait for `[dev] restarted` and `/health` again before the next probe call.

`__pycache__`, `.cache`, and `.venv` do not trigger a restart.

## Parallel worktrees and slots

Every checkout starts its own instance. `tools\dev.py up --attach` from a checkout runs Vite and the watcher in the calling shell, so run it as a background task. The `[dev]` lines stream there and the session stays visible. `tools\dev.py up` without `--attach` detaches and logs to `app/dev/.dev-artifacts/`. Both ensure a slot, claim it, provision the worktree, and wait for `/health`. `pnpm dev` plus `app\dev\watch.py` still work once `app/dev/.dev-slot` exists. When a session already runs for this checkout, `up` prints its ports and exits instead of starting a second one.

Starting Vite is not starting an instance. `pnpm dev`, with or without a hand-set `DEV_UI_SLOT`, serves the page for a headless screenshot and opens no window. When a task needs the app, run `tools\dev.py up --attach` in the worktree first; it allocates the slot, starts Vite, and opens this checkout's window. A worktree created before this tooling landed has no `--attach`, so recreate it from current `main`.

A worktree never resolves to slot 0 and never reads another checkout's probe. `tools/dev.py` allocates a slot when `app/dev/.dev-slot` is missing, and every probe command checks that `/health` reports this checkout, so a stranger's port fails loudly instead of answering with the wrong window. Start your own instance when a task begins; do not attach to a window another worktree owns.

A slot is stable. A checkout keeps its number in `app/dev/.dev-slot`, rewrites only its own file when another checkout took that number, and frees the slot when the session ends so the next start reuses it. The allocator is `app/dev/slots.py`. The live registry is shared by every worktree at `<git-common-dir>/ytmusic-dev/<slot>.json`, found with `git rev-parse --path-format=absolute --git-common-dir`, so the per-checkout files never coordinate. The ports are the hard truth: a slot is busy while a live claim names it or one of its three ports is bound. `port_in_use` binds, it does not connect, because a connect to an unbound loopback port here times out and would call every free port busy.

An extra app process for a test or a second agent is `tools\dev.py instance up`, which takes a free slot and prints its probe and CDP ports. Use `instance list` and `instance down --slot N` to manage them. Each instance needs its own WebView2 profile, because WebView2 refuses two processes on one folder, so a non-default slot uses `app/webview-data-<slot>/` while the default keeps `app/webview-data/`.

The window title names the checkout, so parallel windows are easy to tell apart. The main checkout stays `YTMusic`, a worktree shows its branch as `YTMusic - <branch>`, and a non-default instance appends `(slot N)`. `screenshot` still matches on the owning pid, and it accepts any title that starts with `YTMusic`.

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

A success body is JSON. A failure is HTTP 500 with the error text. The body is the method's raw Python return value, so `get_playlists` comes back as a JSON list, not an object. The `{success, data}` envelope the UI code reads is added by `ui/src/lib/api/bridge.ts`, not the probe. The Python terminal also logs the call and any traceback from the API method. Names starting with `_` are rejected.

`/call` can run before the page has finished loading. `/eval` waits until the webview is ready.

For UI changes, run `pnpm exec tsc --noEmit` from `ui` for types.

## Debug and verify

`tools\dev.py` is the fast way to see the running window: `doctor`, `state`, `logs --level error`, `screenshot --diff`, `eval`, `call`, and `watch` (a live loop that prints PASS/FAIL after each edit). Prefer it over hand-rolled PowerShell and DOM scripts.

The full workflow — which surface can see `window.pywebview.api`, how to read a verdict, and the safety rules for anything that writes to the account — is in `.agents/skills/debug-ytmusic/`. Read it before a change you cannot prove from the terminal. Written artifacts land in `app/dev/.dev-artifacts/`.

A presentational component can be rendered on its own, without the window or any account data. Vite serves any extra `.html` file at the `ui` root, so a throwaway entry that mounts that component with literal props gets the real styles. Start Vite with `$env:DEV_UI_SLOT="1"` to take port 5174 without writing `app/dev/.dev-slot`, then shoot it with `msedge --headless=new --screenshot=out.png --window-size=480,620 http://localhost:5174/<entry>.html`. Add `--force-device-scale-factor=2` when the detail is a few pixels wide, such as a focus ring. Add `--user-data-dir=<temp dir> --virtual-time-budget=6000` too; without them the run can start Edge and exit without writing the file. The opencode browser tab is a worse fit here because `browser.screenshot` fails with "Screenshot needs a visible tab" whenever the desktop window is not in front, while `browser.evaluate` keeps working. The preview entry can only import an exported component. A private one, such as `PlaylistTracksLoading` in `ui/src/features/playlist/pages/Playlist.tsx`, needs a temporary `export` that you revert before you finish.

What that catches: a scroll container clips its children at its padding box, so a focus ring drawn outside a full-width child gets sliced off at the left and right edges. `overflow-y-auto` does this even when the content does not overflow, because the other axis then computes to `auto` too. `EditPlaylistDialog` gives the scrolling form `-m-1 p-1`, and the negative margin cancels the padding so the resting layout does not move.

Run the checks with `.\tools\test.ps1` (tsc + vitest + pytest); add `-Lint` for eslint.

Check the cheapest way first and escalate only when it is not enough; speed is the point.

1. Reason about the diff.
2. Look: `state`, `screenshot`, or the thing in the window. HMR or the restart already applied the change.
3. `logs --level error` for whatever the eye misses.
4. The one test file for what you touched: `pnpm exec vitest run <file>`, `pytest app/tests/test_x.py`.
5. `pnpm exec tsc --noEmit` when types changed.
6. `.\tools\test.ps1` for changes that cross modules, touch shared behaviour, or are headed into a PR.
7. `dev.py browse run tools/verify/<journey>.mjs` (needs `DEVTOOLS=1`), then the packaged exe.

Stop as soon as the evidence covers the change, and never re-run something you already ran. Keep output small: `state` instead of a raw payload, because a playlist dump is thousands of tokens of base64 thumbnails. `dev.py watch` runs the suites only with `--tests`.

Writing JS or JSON on the command line is the biggest time sink here: PowerShell eats `|`, `||`, `>` and nested quotes. Put anything beyond a trivial expression in a file and use `tools\dev.py eval --file <path>`, and use `tools\dev.py call` instead of hand-writing a `python -c` one-liner.

Where the data lives: opened playlists are cached on disk by Python (`diskcache` under `app/.cache`), keyed `playlist:v2:<playlistId>` with a 7 day expiry. The payload's `id` field is `None` — the id is only in the key. `app/dev/` also keeps the probe, the screenshot capture, and `app/dev/.dev-artifacts/`.

The UI accent lives in `ui/src/styles/globals.css` as three literals: `--color-accent`, `--text-color-accent`, and `--background-color-accent`. Change all three together. It colors the playing ring, the player progress and volume bars, and the search library toggle. A separate `--color-success` group (also `--text-color-success` and `--background-color-success`) greens the added-to-playlist checkmarks and the toast success icon and action label. Red stays for errors, destructive actions, and the duplicate badge.

`StickyCollectionBar` (Playlist, Album, Artist) is z-30, above the track rows' z-10 wrappers. The collection pages clear the scroll container's edge-fade mask (`useEdgeFade`) at the very bottom, which drops the container's stacking context, so a z-10 bar ties with the rows and loses to DOM order and the songs paint over it. Only scrolling fully to the bottom shows this.

Draggable rows keep the normal pointer cursor. Songs, sidebar playlists, queue entries, and the `SnapRow` card strips all reorder by drag, but hover shows `cursor-pointer`, not `cursor-grab`. `ui/src/components/ui/reorder.tsx` is the shared wrapper, so a `cursor-grab` added there comes back on every list at once. `SnapRow` still sets `grabbing` while a pointer drag is live, which is the only place that is wanted.

Add-to-playlist writes: the picker sends every add and remove through one queue in `usePlaylist` (`enqueue`, a promise chain), so several quick picks finish one at a time instead of racing the session. YouTube rejects an add whose songs are already in the playlist, because `add_playlist_items` sends no dedupe option. Python returns that as `duplicate: true`, and the toast offers "Add anyway" to send the same edit again with `duplicates=True`. Clicking an added row calls `remove_playlist_videos`, which removes one row per song, using the `setVideoId`s it was given or looking them up in the playlist.

## Whose error

Before you edit, read `/health` and remember `generation` and `restarted_files`.

After a Python save, wait until `generation` increases and `/health` returns `"ok": true`.

The failure is yours only when every path in `restarted_files` is a file you wrote, and the traceback names one of those files.

If the list contains any other file, stop. That save owns the failure. The sequence is in `app/dev/.dev-restarts.jsonl` and in the watcher line. Do not edit that file to make your check pass.

A restart whose file list mixes your file with another save is not yours alone. Wait until a later generation lists only your files, then test again.

## Another feature

A chat that is already open on this folder stays here. Create a worktree one of two ways, depending on your client. Both put a new checkout next to this one and run `.cursor\setup-worktree-windows.ps1` in it.

Cursor, from the Agents Window: set Cursor Settings → Agents → Conversation → Default Environment to New Worktree (Cursor 3.11.6 or later). New Agent and the "+" on this repo then start in a fresh checkout. The editor chat does not use that setting. Start an editor request with `/worktree`. `/apply-worktree` brings the result back. `/delete-worktree` removes the checkout.

Any other client, from the main checkout:

```powershell
.\tools\new-worktree.ps1 <branch-name>
```

That runs `git worktree add` to `..\yt-music-app-<branch-name>` on a new branch and runs the setup script there. `.cursor\` is gitignored, so the script copies `setup-worktree-windows.ps1` into the new checkout itself. Remove a finished worktree with `git worktree remove ..\yt-music-app-<branch-name>`.

Deleting a worktree fails while a Vite for the same pnpm store is still running. `ui/node_modules/.pnpm` holds hardlinks into the store, Vite keeps the native ones mapped, and both `git worktree remove` and `rmdir` stop with `Access is denied` on the `@rolldown/binding`, `@tailwindcss/oxide`, and `lightningcss` binaries. Stop the `node.exe` that serves the repo, then delete. Deregistration and deletion are separate, so a path still on disk after `git worktree remove` means the files were locked; the opencode `worktree_remove` tool reports "Unable to remove worktree" for the same reason after it has already deregistered the entry, so check disk, not `git worktree list`.

Setup installs the UI dependencies, copies `app/browser.json` when the new checkout has none, and writes `app/dev/.dev-python` and `app/dev/.dev-slot`. The slot comes from `app/dev/slots.py`, so it matches what any other starting checkout reserves. From that worktree, `tools\dev.py up` starts Vite and the watcher together against its slot. To start them by hand, run `pnpm dev` from the worktree's `ui`, and run `app\dev\watch.py` with the interpreter path stored in `app/dev/.dev-python` (the main checkout's venv). The window and the probe use that slot's ports.

One `app\dev\watch.py` per worktree. Two agents in the same folder still share one app. The restart log names the files behind the current process.

An opencode worktree never runs the Cursor setup script, so the first `tools\dev.py` command in it provisions the checkout: allocate a slot, record the main checkout's interpreter in `app/dev/.dev-python`, copy `app/browser.json`, and run `pnpm install` when `ui/node_modules` is missing. `tools\dev.py setup` does the same and prints the ports. `tools\test.ps1` and `app\dev\watch.py` read `app/dev/.dev-python`, so they run with that interpreter; `pytest` still runs from the worktree root. Python packages come from the main checkout's venv, not a per-worktree one.

`.opencode/plugins/ytmusic-dev-instance/` does that on creation. It registers the worktree strategy, so `worktree_create` runs `git worktree add` and then `tools\dev.py setup`. The worktree arrives with its slot, dependencies, and `browser.json`. A plugin cannot create a shell task, so it does not start the app itself. Instead, on the first prompt of a session whose directory is a linked worktree, it sends a synthetic message telling the agent to start the app with `tools\dev.py up --attach` as a background shell, where the task stays visible. It delegates every operation to git, so branch and detached behavior are unchanged. `opencode plugin list` shows it; it loads on `opencode reload` or a restart. Removal still hits the locked pnpm binaries above.

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

## Don't

- Don't delete or alter anything in the signed-in account. See **Never destroy what the user has**.
- Don't run `pnpm build` alone to produce a release. Use `.\build\build.ps1` (it sets `--base ./`).
- Don't read, print, or commit `app/browser.json`. It holds the signed-in session.
- Don't edit `app/dev/.dev-restarts.jsonl`, `.dev-slot`, or `.dev-python` by hand.
- Don't read another checkout's window or probe a port you do not own. Start your own instance with `tools\dev.py up --attach`.
