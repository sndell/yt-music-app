# Agent debugging plan

Goal: change → see → prove → repeat. Reliability first; speed is a byproduct. An agent should land a change, see the app, prove it works, and get the same answer twice without hand-written plumbing.

## Status

- **Done.** The CLI (`tools/dev.py`), the observability endpoints (`/state`, `/logs`, `/screenshot`, `/reload`) with renderer error capture, the `watch` live loop (it now runs the matching unit suite — pytest or vitest — and folds the result into the verdict), the CDP driver (`tools/dev.py browse`, code at `ui/dev/browser.mjs`), the unit tests (pytest + vitest), `/tools/test.ps1`, three read-only CDP journeys (`tools/verify/sidebar.mjs`, `navigation.mjs`, `playlist-open.mjs`), and the skill.
- **Not built, by decision.** The fake backend was dropped: the account is protected by the hard rule in `AGENTS.md` (**Never destroy what the user has**) rather than by a simulated backend.
- **Dev-only deps.** `playwright-core`, `vitest`, `jsdom`, `@testing-library/react|dom|jest-dom` in `ui/`; `pytest` in `app/requirements-dev.txt`.

## Current state

| Piece | Where | What it does today |
| --- | --- | --- |
| Dev probe | `app/dev/probe.py` | `GET /health`, `GET /state`, `GET /logs`, `POST /call`, `POST /eval`, `POST /screenshot`, `POST /reload`. Responses carry `X-Dev-Generation`, `X-Dev-Restart-Files`, `X-Dev-Pid`. |
| Restart watcher | `app/dev/watch.py` | Restarts the window on a `.py` save under `app/`. Prints `[dev] restarted <files> generation=N pid=...`. `/health` returns `ok`, `pid`, `slot`, `generation`, `restarted_files`. Appends `app/dev/.dev-restarts.jsonl`. |
| Identity | `app/dev/identity.py` | Slot 0 keeps the base ports. A worktree's slot adds to each base. |
| Bridge | `window.pywebview.api` | UI ↔ Python calls. Exists only inside the desktop window. |
| CDP | `DEVTOOLS=1` | Opens DevTools and enables remote debugging on `9222` + slot. Off in a normal dev window. |
| Packaged exe | `build/dist/<yyyy-MM-dd_HHmm>/YTMusic.exe` | No probe. Logs to `%LOCALAPPDATA%\YTMusic\ytmusic.log`. |

Ports: probe `8765`, Vite `5173`, CDP `9222`. Add the slot from `app/dev/.dev-slot` in a worktree. Vite binds IPv6 `::1`, so use `http://localhost:5173`; the probe is IPv4, so use `127.0.0.1:8765`. Mixing the two wastes time.

## Gaps observed

| Gap | Symptom | Why it costs time |
| --- | --- | --- |
| PowerShell quoting | `curl.exe` strips quotes from a JSON POST body on Windows PowerShell | Every probe call becomes a venv Python one-liner. |
| IPv6 vs IPv4 | A `127.0.0.1:5173` fetch fails even when Vite is up | Looks like Vite is down. |
| Hand-written DOM driving | A script right-clicks a track row and nothing happens | Unavailable rows render at `opacity-25` and their `onContextMenu` guard returns early when `!track.isAvailable` (`PlaylistTrackList.tsx`). A blind click is silently a no-op. |
| Real-account mutations | `create_playlist`, `delete_playlist`, `add_playlist_items`, `rate_song` write to the signed-in account | A test can leave junk in the user's YouTube Music library. |
| No renderer visibility | A React error leaves a blank or wedged UI and the Python terminal is silent | Nothing captures console/error output or route/state. |
| No screenshots | Wrong order, overlap, or spacing is invisible to a DOM assertion | Visual bugs pass a `querySelector` check. |
| No unit tests for logic | Parsing, ordering, cache, and status handling are only exercised by hand | Regressions ship. |

## The loop

detect → settle → capture → assert → verdict.

- **Detect** — a signal says something changed.
- **Settle** — wait for the app to quiesce (no spinner, no pending HMR update, generation stable).
- **Capture** — read `state`, `logs`, a `screenshot`, and the artifact files.
- **Assert** — run the matching `tools/verify/*.mjs` journey.
- **Verdict** — one line: `PASS` / `FAIL <what>` / `UNKNOWN <infra>`, exit `0` / `1` / `2`.

Three change signals feed detect:

| Signal | Source | Fires on |
| --- | --- | --- |
| Vite HMR | Vite dev server | a UI edit (`ui/`) |
| Python restart generation | `app/dev/watch.py` via `/health` `generation` | a `.py` edit under `app/` |
| Test watchers | pytest / vitest watch mode | a unit test run |

## Two surfaces

| Surface | What it is | Bridge (`window.pywebview.api`) | Use when |
| --- | --- | --- | --- |
| opencode browser tab on the Vite URL | A plain browser on `http://localhost:5173` | Absent | Fast layout/DOM/console checks. No Python calls. |
| Real window over CDP | The WebView2 window, driven through `9222` + slot with `DEVTOOLS=1` | Present | Anything authoritative: bridge calls, real clicks, final proof. |

A browser tab on the Vite port is not the app. Bridge calls fail there. For final proof, drive the real window.

## Deliverables

**A. CLI.** `tools/dev.py`, stdlib-only, runs on any Python 3.10+ (e.g. `.\app\.venv\Scripts\python.exe tools\dev.py ...`).

| Command | Does |
| --- | --- |
| `health` | GET `/health`; prints ok/pid/slot/generation/restarted_files. |
| `doctor` | Checks the dev window is up; sums up slot, ports, CDP availability, artifacts dir. |
| `call <method> [json-args]` | POST `/call`. Public Python methods only; names starting with `_` are rejected. |
| `eval <js>` / `eval --file <path>` | POST `/eval`. Runs in the desktop window; returned promises are awaited. |
| `state` | GET `/state`: route, page title, ordered playlist ids, spinner count, last renderer error. |
| `logs [--since N] [--level error\|warning\|info] [--limit N]` | GET `/logs`: Python log ring buffer plus renderer console/error entries. |
| `screenshot [--out <path>] [--diff]` | POST `/screenshot`: writes `app/dev/.dev-artifacts/screenshot.png`, optionally a diff against the last good baseline. |
| `reload` | POST `/reload`: reloads the webview. |
| `browse` | Forwards to the CDP driver `ui/dev/browser.mjs`: `targets`, `shot`, `text`, `click`, `click-text`, `wait`, `console`, `run <script>`. |
| `watch [--verify <script>] [--no-tests] [--once] [--timeout S]` | The live loop: watches Vite HMR and the Python restart generation, settles, captures state + screenshot, runs the matching pytest/vitest suite and the matching `tools/verify/*.mjs`, prints a one-line verdict, exits 0/1/2. |
| `up [--devtools]` | Starts the dev servers in the background. |

Global flags: `--slot N`, `--json`. Exit codes: `0` pass, `1` fail, `2` infra/unknown.

**B. Observability.** Add `/state`, `/logs`, renderer capture, and `/screenshot` to the probe. `/state` and `/logs` return JSON. Renderer console and error entries land in `console.log`. Screenshots write into `app/dev/.dev-artifacts/` (gitignored): `state.json`, `console.log`, `screenshot.png`, `diff.png`, `verdict.txt`.

**C. `tools/browser.mjs`.** Playwright over CDP for the work the probe cannot do: real pointer moves, right-clicks, drags, and element screenshots inside the authoritative window.

**D. pytest + vitest.** Unit tests for `app/` logic and UI logic, so behaviour is pinned without a window. (A fake `MusicApi` backend was considered and dropped: the account is protected by a hard rule instead, see `AGENTS.md`.) Each test target: under 1s.

**E. Skill and journeys.** `.agents/skills/debug-ytmusic/` and `tools/verify/*.mjs` — one journey per feature, the same steps the skill tells an agent to run.

## Phases

| Phase | Deliverable | Checkpoint | Effort |
| --- | --- | --- | --- |
| 1 | CLI skeleton: `health`, `doctor`, `call`, `eval`, artifacts dir | `doctor` prints slot, ports, CDP, artifacts; `call get_playlists` returns JSON | S |
| 2 | Observability: `/state`, `/logs`, renderer capture, `/screenshot` | `state`, `logs`, `screenshot` return data; artifacts written | M |
| 3 | `tools/browser.mjs` over CDP | A real right-click opens a track context menu | M |
| 4 | pytest + vitest | Unit tests pass in under 1s each; no account writes | L |
| 5 | Skill + `tools/verify/*` + `watch` | A UI edit gets a one-line verdict from `watch` | M |

## Latency budget

| Change | Budget |
| --- | --- |
| Vite edit → verdict | ≤ ~3s |
| Python edit → verdict | ≤ ~5s |
| Unit test | < 1s each |

## Non-goals

- Replacing the probe with a general automation framework.
- Driving the user's real YouTube Music account.
- CI, release, or packaging automation.
- A full Playwright test suite for every page.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| CDP port closed (no `DEVTOOLS=1`) | `doctor` reports CDP availability; `up --devtools` starts with it on. |
| A restart's `restarted_files` mixes another save with yours | Apply the "whose error" rule; wait for a generation that lists only your files. |
| Artifacts committed or bloating | `app/dev/.dev-artifacts/` is gitignored. |
| Screenshot flakiness (animations, lazy images) | Settle before capture; diff against a labelled baseline; report `UNKNOWN` rather than a false `PASS`. |
| Journeys go stale as the UI changes | Keep them small and read-only; assert observable state, not implementation details. |
| Two watchers on one slot | One `app/dev/watch.py` per checkout; `doctor` reads `/health` first. |

## How we'll know it worked

- A change gets a one-line verdict without hand-written curl.
- The same repro gives the same verdict twice.
- No test leaves anything in the real account.
- A renderer-only failure is visible in `state`, `logs`, or `screenshot`, not a blank window.
