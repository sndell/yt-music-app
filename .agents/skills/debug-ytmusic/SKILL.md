---
name: debug-ytmusic
description: Debug and verify changes in the YTMusic desktop app (Python pywebview + Vite/React UI). Use when a change must be proven in the live window, when the UI or the Python API misbehaves, when `window.pywebview.api` is involved, when you need renderer logs or a screenshot, or when you must reproduce a playlist/sidebar/renderer bug without touching the user's real YouTube account.
---

# Debug YTMusic

Drive and verify the running app from the command line, prove a change, and repeat it.

## When to use this

- A change needs to be seen and proven in the running app, not reasoned about.
- The UI is blank, wedged, or out of order.
- A `window.pywebview.api` call fails, is rejected, or is missing.
- You need the renderer console, a screenshot, or a diff.
- You are about to touch playlists, likes, or the queue and must not mutate the real account.

## Surfaces

| Surface | Has `window.pywebview.api` | Use when |
| --- | --- | --- |
| opencode browser tab on `http://localhost:5173` | No | Fast layout/DOM/console checks. Bridge calls fail here. |
| Real window over CDP (`9222` + slot, `DEVTOOLS=1`) | Yes | Authoritative proof: `dev.py browse` clicks, screenshots, and runs verify scripts against it. |

A browser tab on the Vite port is not the app. If a bridge call fails there, it is the surface, not the code.

Ports: probe `127.0.0.1:8765` (IPv4), Vite `http://localhost:5173` (IPv6 `::1`). Add `--slot N` in a worktree.

## The loop

detect → settle → capture → assert → verdict.

```powershell
# Is the app up, and on which ports?
.\app\.venv\Scripts\python.exe tools\dev.py doctor

# What is the window showing?
.\app\.venv\Scripts\python.exe tools\dev.py state

# What has Python and the renderer logged?
.\app\.venv\Scripts\python.exe tools\dev.py logs --level error --limit 50

# See it. Optionally diff against the last good baseline.
.\app\.venv\Scripts\python.exe tools\dev.py screenshot --diff

# Drive it. Prefer a file: PowerShell eats `|`, `||`, `>` and nested quotes.
.\app\.venv\Scripts\python.exe tools\dev.py eval --file check.js
.\app\.venv\Scripts\python.exe tools\dev.py eval "document.body.innerText"
.\app\.venv\Scripts\python.exe tools\dev.py call get_playlists

# Drive the real window over CDP (needs DEVTOOLS=1). Reliable clicks, screenshots, verify scripts.
.\app\.venv\Scripts\python.exe tools\dev.py browse targets
.\app\.venv\Scripts\python.exe tools\dev.py browse shot --out app/dev/.dev-artifacts/browser.png

# Read-only journeys (tools/verify/*.mjs): sidebar invariants, the route walk, and opening a playlist.
.\app\.venv\Scripts\python.exe tools\dev.py browse run tools/verify/sidebar.mjs
.\app\.venv\Scripts\python.exe tools\dev.py browse run tools/verify/navigation.mjs
.\app\.venv\Scripts\python.exe tools\dev.py browse run tools/verify/playlist-open.mjs

# Prove it end to end. Prints PASS / FAIL <what> / UNKNOWN <infra>, exits 0/1/2.
.\app\.venv\Scripts\python.exe tools\dev.py watch --check "document.querySelectorAll('[data-playlist-id]').length > 0"

# Start the servers in the background.
.\app\.venv\Scripts\python.exe tools\dev.py up --devtools
```

Global flags: `--slot N`, `--json`. `call` runs public Python methods only; names starting with `_` are rejected. `eval` runs in the desktop window and awaits a returned promise. `screenshot` writes `app/dev/.dev-artifacts/current.png`, with `baseline.png` and `diff.png` beside it.

`eval` and `call` run in the same window the CDP driver sees, through the real `window.pywebview.api`, so they are just as authoritative for DOM and bridge proof. The CDP driver (`browse`) and the `tools/verify/*.mjs` journeys need the window started with `DEVTOOLS=1` (`tools\dev.py up --devtools`). When CDP is off, prove things with `eval`/`call` — do not call a feature unverifiable just because the debugging port is closed.

`tools/verify/*.mjs` are CDP journeys (`run({ page, check })`). A plain `tools/verify/*.js` is a probe `/eval` driver for the same window. Both are fine; say which kind a script is so the next agent can run it.

Opened playlists are cached on disk (`diskcache` under `app/.cache`), keyed `playlist:v2:<playlistId>` with a 7 day expiry; the payload's `id` is `None`, so read the id from the key. Only cached playlists exist there, which is why cache-backed features see just what has been opened.

Exit codes: `0` pass, `1` fail, `2` infra/unknown. A `2` means the harness could not judge — fix the infra, do not "fix" the code.

## Understand the verdict

`watch` polls `ui/src` and `app` for edits. A `.py` edit waits for the restart generation to advance and health to be `ok`; a UI edit waits for Vite HMR to settle. It then captures state and a screenshot and judges:

- `PASS` — nothing broke.
- `FAIL renderer error` — the page logged an error (or threw); the line shows it.
- `FAIL check` — the `--check` expression was falsy.
- `FAIL tests` — only with `--tests`; the changed side's unit suite failed and its tail prints above the verdict.
- `UNKNOWN <infra>` — the probe is unreachable, or a suite could not start. Not a code failure.

`watch` exits `1` on the first FAIL so a background run notifies you. Use `--keep-going` to keep watching, `--once` for a single change.

It does **not** run the test suites unless you pass `--tests`, which prints `tests skipped` otherwise. Most edits do not need one; add it when the change is behavioural or cross-module. A cosmetic or one-line edit is proven by the capture alone.

## Whose error

Before you edit, read `health` and remember `generation` and `restarted_files`.

After a Python save, wait until `generation` increases and health is `ok`.

A failure is yours only when every path in `restarted_files` is a file you wrote and the traceback names one of those files. If the list contains any other file, another save owns it — stop, wait for a generation that lists only your files, and test again. A mixed list is not yours alone. Do not edit `app/dev/.dev-restarts.jsonl` to make a check pass.

## Safety

The signed-in account is the user's data. Treat it as read-only.

- Never delete a playlist, a song in a playlist, a Like, a library item, or a queued song. Deleting cannot be undone.
- Never delete anything you did not create in this same session.
- Never change a playlist's title, description, visibility, or track order unless the task asked for exactly that.
- `call create_playlist`, `call delete_playlist`, `call add_playlist_items`, `call remove_playlist_items`, `call edit_playlist`, `call rate_playlist`, and `call rate_song` all write to the real account. Do not run them to explore or to "check something".
- Reads are safe and are what verification should lean on: `state`, `logs`, `screenshot`, `call get_playlists`, `call get_playlist_items`.
- If a task appears to need a destructive change, stop and ask the user.
- Never read, print, or commit `app/browser.json`; it holds the signed-in session.

## More

- `references/recipes.md` — symptom → reproduce → instrument → fix.
- `references/feature-map.md` — how to reach, drive, and prove each feature.

## Run the checks

Check the cheapest way first and escalate only when that is not enough. Speed matters more than completeness here.

| # | Cost | Do |
| --- | --- | --- |
| 1 | free | reason about the diff |
| 2 | one call | look: `state`, `screenshot`, or the thing in the window |
| 3 | one call | `logs --level error` for what the eye misses |
| 4 | seconds | the one test file: `pnpm exec vitest run <file>`, `pytest app/tests/test_x.py` |
| 5 | slow | `pnpm exec tsc --noEmit` when types changed |
| 6 | slow | `.\tools\test.ps1` for cross-module, shared, or PR-bound changes |
| 7 | last | `browse run tools/verify/<journey>.mjs` (needs `DEVTOOLS=1`), then the packaged exe |

Stop as soon as the evidence covers the change, and never re-run something you already ran.

Keep output small — `state` instead of a raw payload. A raw `get_playlists` or `get_playlist_items` dump is thousands of tokens of base64 thumbnails; `state` and `logs --limit` give the same answer for a fraction of the cost.
