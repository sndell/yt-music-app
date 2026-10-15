# Parallel worktrees implementation contract

Frozen interfaces for the work in `docs/parallel-worktrees-plan.md`. Every worker builds to this file. If something here is wrong or missing, stop and report it rather than invent a different interface.

## Environment

- `DEV_SLOT` is the instance slot. It drives the probe port, the CDP port, and the WebView2 profile.
- `DEV_UI_SLOT` is the checkout slot. It drives the Vite port and the URL the window loads.
- Both are optional. `DEV_UI_SLOT` falls back to `app/dev/.dev-slot` then 0. `DEV_SLOT` falls back to the checkout slot.
- Python is `app\.venv\Scripts\python.exe`. Shell is PowerShell. Node is on PATH.

## `app/dev/identity.py`

Keep the module docstring and the existing constants `PROBE_BASE`, `UI_BASE`, `DEBUG_BASE`.

- `_read_slot_file()` stays as it is.
- `ui_slot() -> int`. `DEV_UI_SLOT`, else `_read_slot_file()`, else 0. Negative clamps to 0. Memoize in a module global.
- `dev_slot() -> int`. `is_frozen()` returns 0. Else `DEV_SLOT`, else `ui_slot()`. Negative clamps to 0. Memoize.
- `probe_port(slot=None)` and `debug_port(slot=None)` use `dev_slot()` when slot is None.
- `ui_port(slot=None)` and `ui_origin(slot=None)` use `ui_slot()` when slot is None.
- `checkout() -> str`. `REPO_DIR.as_posix()`.
- `health_payload()` gains `"checkout": checkout()`.
- `webview_data_dir(slot=None) -> Path`. Import `data_dir` from `util.app_paths`. When slot is None use `dev_slot()`. Return `data_dir() / "webview-data"` when `slot == ui_slot()`, otherwise `data_dir() / f"webview-data-{slot}"`.

## `app/dev/slots.py` (new)

Imports `dev.identity` for ports and paths. One test file, `app/tests/test_slots.py`, no network and no real ports.

- `is_linked_worktree() -> bool`. True when `identity.REPO_DIR / ".git"` is a file.
- `registry_dir() -> Path`. Run `git -C <REPO_DIR> rev-parse --path-format=absolute --git-common-dir`. Join `ytmusic-dev`. Fall back to `identity.APP_DIR / "dev" / ".dev-registry"` when git fails. Create it if missing. Memoize.
- `ports_for(slot) -> tuple[int, int, int]`. `(8765+slot, 5173+slot, 9222+slot)`.
- `port_in_use(port) -> bool`. Try `socket.create_connection` to `127.0.0.1:port` and to `::1:port` with a short timeout. Connection refused means free. A timeout means in use.
- `slot_free(slot) -> bool`. No live claim for the slot and none of its three ports is in use.
- `live_claims() -> dict[int, dict]`. Read `slots/<n>.json`. A claim is live while any recorded pid is alive. Delete stale files best effort.
- `preferred_slots() -> dict[int, str]`. From `git worktree list --porcelain`, read each other worktree's `app/dev/.dev-slot`, and map slot to path. Skip this checkout.
- `claim_slot(slot, role, extra=None) -> dict`. Inside the lock. Write `slots/<slot>.json` with `slot`, `checkout`, `pid`, `role`, `started`, plus extra. Replace a stale file.
- `release_slot(slot) -> None`. Delete `slots/<slot>.json`.
- `ensure_checkout_slot() -> int`. Apply the stability rules from the plan. Write `app/dev/.dev-slot` only when the slot must move. Claim the chosen slot with role `checkout`. When a live claim already names this checkout, return that slot without a second claim.
- `allocate_instance_slot() -> int`. First free slot from 1 up with no live claim and free ports. Claim it with role `instance`.
- `list_claims() -> list[dict]`.
- CLI. `python -m dev.slots ensure` prints the checkout slot. `python -m dev.slots release --slot N`. `python -m dev.slots list` prints the live claims as JSON.
- Lock. One file `lock` under `registry_dir()`, created with `O_CREAT|O_EXCL`. Retry for about five seconds. Treat a lock older than ten seconds as stale and remove it.
- Pid liveness. On Windows use `ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)`. On other platforms use `os.kill(pid, 0)`.

## `app/dev/screenshot.py`

`find_window(title=WINDOW_TITLE)` keeps its name and return type. Enumerate top-level windows with `EnumWindows`, read the title with `GetWindowTextLengthW` and `GetWindowTextW`, read the pid with `GetWindowThreadProcessId`, and return the window whose title equals `title` and whose pid equals `os.getpid()`. Keep the current `FindWindowW` call as a fallback when no match is found.

## `ui/vite.config.ts` and `ui/vite.config.js`

Vite loads `vite.config.js` before the TypeScript file, so both must change together and stay identical in this logic.

- Read the port from `DEV_UI_SLOT`, then the slot file, then 0. Do not read `DEV_SLOT`.
- When the slot file is missing and `../.git` is a file, which marks a linked worktree, throw an Error telling the reader to run `tools/dev.py up` once.
- Keep `port: 5173 + slot` and `strictPort: true`.

## `app/dev/watch.py`

- Set `DEV_SLOT` and `DEV_UI_SLOT` on the child process. For the default session both equal the checkout slot.
- Call `ensure_checkout_slot()` when the slot file is missing, before starting the app.
- Claim the checkout slot with role `checkout` when it is the session supervisor, and release it on exit from `finally`.
- Keep `DEV_GENERATION` and `DEV_RESTART_FILES` as they are.

## `app/main.py`

- Use `identity.webview_data_dir()` for the WebView2 profile, so the default session keeps `webview-data/`.
- When `dev_slot() != ui_slot()`, claim the instance slot with role `instance` on start and release it on exit. Use `atexit` and a `finally` around `webview.start`.

## `tools/dev.py`

- Add `ui_slot()` reading `DEV_UI_SLOT`, then `app/dev/.dev-slot`, then 0. Keep `dev_slot()` as the instance slot.
- `ports(slot)` stays, but the Vite URL in `doctor` uses `ui_slot()`.
- `cmd_up` calls `slots.ensure_checkout_slot()` and claims before starting. It sets both env vars on Vite and the watcher. When a session already runs for this checkout, it prints the ports and exits without starting a second copy.
- New `instance` command with `up`, `down`, and `list`. `up` allocates an instance slot, runs `main.py` detached with `DEV_SLOT` and `DEV_UI_SLOT` set, and prints the probe and CDP ports. `down` stops one instance. `list` prints the live claims.
- In `main()`, set `args.slot_resolved = dev_slot(args.slot)` and `args.ui_slot = ui_slot()`.

## `.cursor/setup-worktree-windows.ps1`

Replace its port scan with a call into `app/dev/slots.py` for the slot number, using the main checkout's venv Python. Keep the rest.

## Rules for every worker
- Edit only the files you are assigned.
- Do not run anything that writes to the signed-in YouTube account.
- Match the surrounding style. No em dashes in code comments or prose. Straight quotes.
- Run the focused check for your files and report the exact command and its output, plus anything you could not verify. Never report a pass you did not observe.

## As built

Three deviations from the frozen text, all deliberate and verified.

- `port_in_use` binds on IPv4 and IPv6 loopback instead of connecting. On this machine a connect to an unbound loopback port times out, so the connect probe reported every free port as busy and no slot ever came free.
- `slots.py` also has `checkout_slot()` and `existing_session_slot()`. `ensure_checkout_slot` uses them so a session that is already running for this checkout, including one with no live claim, is recognised through its probe on `/health` and is never renumbered.
- Both Vite config files changed together, since Vite loads `vite.config.js` before `vite.config.ts`.
