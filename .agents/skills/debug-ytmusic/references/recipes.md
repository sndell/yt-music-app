# Recipes

Each recipe: symptom → reproduce → instrument → what a fix looks like.

Run the CLI from the repo root with `.\app\.venv\Scripts\python.exe tools\dev.py <command>`. Add `--slot N` in a worktree.

Anything past a trivial expression belongs in a file: PowerShell eats `|`, `||`, `>`, and nested quotes, so `dev.py eval "…"` fails on real scripts. Write the JS to a file and use `dev.py eval --file <path>`. Likewise use `dev.py call` rather than a hand-written `python -c` one-liner.

`state`'s `lastError` only counts errors since the page last loaded, and prints how long ago it happened. `logs --since <epoch>` scopes to a change.

## Renderer / React error

**Symptom.** The UI is blank or wedged. The Python terminal is silent. A click does nothing.

**Reproduce.**

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py reload
.\app\.venv\Scripts\python.exe tools\dev.py eval "document.body.innerText.length"
```

A `0` or a body that stops mid-render points at a render crash.

**Instrument.**

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py state
.\app\.venv\Scripts\python.exe tools\dev.py logs --level error --limit 100
.\app\.venv\Scripts\python.exe tools\dev.py screenshot --out app\dev\.dev-artifacts\blank.png
```

`state` reports `last error` and any spinner/loading indicator. `logs` includes renderer console and error entries in the Python ring buffer output. The screenshot shows whether the frame is blank, half-painted, or covered.

**Fix.** Tie the error to a component and a render pass. A correct fix removes the error from `state`, clears the spinner, and leaves the page fully painted in the screenshot. Add the vitest that renders the component with the same props.

## HMR reload error that is not real

**Symptom.** You add a new module and import it into an already-hot component, and the page reports a context error such as `useX must be used within a XProvider`, plus `[vite] Failed to reload …`. The build is fine; a reload fixes it.

**Reproduce.** It appears on the HMR update itself, not on a fresh load.

**Instrument.** Reload and look again. If the error survives a reload it is real; if it disappears, it was the hot update.

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py reload
Start-Sleep -Seconds 3
.\app\.venv\Scripts\python.exe tools\dev.py state
```

**Fix.** Nothing in the code — reload, then re-check. Do not "fix" a provider boundary that was never broken. When you report a renderer error from `watch`, say whether it survived a reload.

## IPC / bridge failure

**Symptom.** `window.pywebview.api` is `undefined`, or a call returns `METHOD_NOT_FOUND` or `CALL_FAILED`.

**Reproduce.**

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py eval "typeof window.pywebview?.api"
```

`"undefined"` in a browser tab is expected — that surface has no bridge. Confirm you are on the real window (CDP) before concluding anything. Then:

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py call get_playlists
```

A method rejected with `method not allowed: _foo` is the probe guarding private names; call the public name instead.

**Instrument.**

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py logs --level warning
```

`CALL_FAILED` carries the Python exception message. `METHOD_NOT_FOUND` is a name mismatch between `ui/src/lib/api/bridge.ts` and the Python method; the bridge waits up to 30s for the method to appear.

**Fix.** The method exists on `Api` in `app/main.py`, the name matches the bridge entry exactly, and the call succeeds on the real window with a real return value. A fix for a private-name rejection is a public method, not an underscore one.

## Eventual consistency / lag

**Symptom.** A just-added item is missing from a live fetch, then appears a moment later.

**Reproduce (read-only).** Do not create anything to reproduce this — the account is read-only. Ask the user to make the change in the UI while you watch.

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py logs --level info --limit 60
```

**Instrument.** The two fetches and their order are in `logs`. `state` shows the sidebar ids at the moment you look.

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py state
.\app\.venv\Scripts\python.exe tools\dev.py eval "window.pywebview.api.get_playlists().then(list => list.map(p => p.playlistId))"
```

**Fix.** Either the write is not awaited before the read, or the endpoint lags and a stale list overwrites the optimistic row. A correct fix awaits the write, invalidates the right cache key, or keeps the optimistic row until the server list carries it. Prove it the same way you reproduced it: the user makes one change, and the row appears at once and stays.

## Visual / layout bug

**Symptom.** Wrong order, wrong place, or ugly spacing.

**Reproduce.** Navigate to the state that shows it, then capture.

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py state
.\app\.venv\Scripts\python.exe tools\dev.py screenshot --diff
```

**Instrument.** DOM order is not visual order. `eval` reads order and classes; the screenshot shows what the eye sees.

```powershell
.\app\.venv\Scripts\python.exe tools\dev.py eval "Array.from(document.querySelectorAll('[data-playlist-id]')).map(el => el.getAttribute('data-playlist-id'))"
```

`--diff` compares against the last good baseline and writes `app/dev/.dev-artifacts/diff.png`.

**Fix.** The screenshot matches the intended layout, and the DOM order agrees with it. A green DOM assertion over a wrong screenshot is a `FAIL`, not a `PASS`. For real hover, drag, or right-click geometry, drive the window with `tools/browser.mjs` over CDP — a synthetic `eval` event does not reproduce pointer geometry.

## Packaged-exe-only bug

**Symptom.** Works in dev, breaks in the built exe.

**Reproduce.** Stop `app\dev\watch.py` first — it and the exe share this checkout's probe port.

```powershell
$env:DEVTOOLS = "1"
.\build\dist\<yyyy-MM-dd_HHmm>\YTMusic.exe
```

The frozen exe keeps port `8765`. With `DEVTOOLS=1` it also opens DevTools, listens for CDP on `9222`, and starts the probe, so `state`, `logs`, `screenshot`, `call`, and `eval` work against it.

**Instrument.** With the probe up, use the CLI as usual. Without it, read the log:

```powershell
Get-Content "$env:LOCALAPPDATA\YTMusic\ytmusic.log" -Tail 200
```

**Fix.** The packaged path serves `ui/dist` at `--base ./`; a path or resource that only works from the Vite server is the usual cause. Build with `.\build\build.ps1`, never `pnpm build` alone. The log line that named the missing resource is gone, and the feature works in the exe.
