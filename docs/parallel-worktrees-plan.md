# Parallel worktrees and spawnable instances plan

Goal. Several features in flight at once, each one standalone. Every worktree has its own checkout, its own Vite server, its own Python window, its own probe, its own CDP port, and its own WebView2 profile. Agents can spawn, restart, and kill app processes without touching another session.

Status. Implemented in the working tree and verified. The allocator with the stability rules, the client-agnostic checkout slot, the per-instance WebView2 profile, the window-by-PID screenshot, and the instance commands are all in place. The frozen interfaces are in `docs/parallel-worktrees-implementation.md`. The plan below is the design those follow.

## What already exists

A slot system is already in place and most layers read it. A slot is one number. Ports are a base plus that number.

| Piece | File | What it does |
| --- | --- | --- |
| Slot value | `app/dev/.dev-slot` | Missing in the main checkout, which means slot 0. A worktree writes its number. The older `dev/.dev-slot` and `app/.dev-slot` are still read. |
| Ports | `app/dev/identity.py` | probe `8765+slot`, Vite `5173+slot`, CDP `9222+slot` |
| Vite | `ui/vite.config.ts` | `port: 5173 + devSlot()`, `strictPort: true` |
| Window | `app/main.py` | dev loads `ui_origin()`; probe and CDP use this slot |
| Watcher | `app/dev/watch.py` | runs `main.py` in this checkout with `DEV_SLOT`, `DEV_GENERATION`, `DEV_RESTART_FILES` |
| Agent CLI | `tools/dev.py` | reads this checkout's slot, `--slot` overrides, `up` starts the servers |
| CDP driver | `ui/dev/browser.mjs` | `9222 + devSlot()`, `DEV_SLOT` env wins |
| Slot writer | `.cursor/setup-worktree-windows.ps1` | picks a free slot, writes `app/dev/.dev-slot` and `app/dev/.dev-python` |

Isolation already holds in dev. `data_dir()` in `app/util/app_paths.py` returns the checkout's own `app/`, so each worktree gets its own `webview-data/`, `browser.json`, `preferences.json`, `discord.json`, `.cache/`, `.dev-artifacts/`, and `.dev-restarts.jsonl`, plus its own `ui/node_modules` from `pnpm install`.

Vite binds IPv6 `::1`, so its URL is `http://localhost:5173`. The probe is IPv4, so it is `127.0.0.1:8765`. Mixing the two wastes time.

## Gaps that break parallel use

| # | Gap | What goes wrong |
| --- | --- | --- |
| 1 | Only the Cursor setup script writes `.dev-slot`. A worktree made another way, such as the opencode `worktree_create` tool or a manual `git worktree add`, has no slot file and falls back to 0. | Vite on `5173` hits `strictPort` and fails, or the window loads the main checkout's Vite and shows main's UI while you edit the worktree. |
| 2 | One number does four jobs: Vite, probe, CDP, and data dir. Two app processes in one checkout cannot have distinct probe and CDP ports or profiles. | Spawning a second process is not possible today. |
| 3 | WebView2 forbids two processes sharing one user-data folder, from MicrosoftEdge/WebView2Feedback issue 4751. `main.py` hardcodes `data_dir()/webview-data`. | Two processes on one profile wedge, drop messages, or fail to start. |
| 4 | `ui_origin()` follows `DEV_SLOT`, the same value used for the probe. | An instance with a non-default slot would load the wrong Vite port. |
| 5 | `screenshot.find_window` calls `FindWindowW(None, "YTMusic")`, which returns the first window with that title. | `/screenshot` and `dev.py screenshot` can capture another checkout's window. |
| 6 | Slot allocation reads then writes, with no lock, and cannot tell a live session from a closed one. | Two worktrees created at once can pick the same slot, and a freed slot never comes back on its own. |

Discord rich presence and Windows media keys stay loud in every instance, by your decision. They are machine-wide singletons and will fight over the Now Playing card and the media-key target. This plan does not gate them.

## Design

### Checkout slot and instance slot

Two numbers, not one.

| Number | Owns | Where it comes from |
| --- | --- | --- |
| Checkout slot | the source, the Vite port, the default data dir | `DEV_UI_SLOT`, then `app/dev/.dev-slot`, then 0 |
| Instance slot | the probe port, the CDP port, the WebView2 profile, the restart identity | `DEV_SLOT`, then the checkout slot |

An instance is one `main.py` process. A checkout can run several. All of them load the same Vite server, because they serve the same source. Each one gets its own probe, CDP, and profile.

```
checkout "feature-a"  slot 3   -> Vite 5176   shared by its instances
  instance 3 default           -> probe 8768, CDP 9225, profile webview-data/
  instance 7 ephemeral         -> probe 8772, CDP 9229, profile webview-data-7/
checkout "main"       slot 0   -> Vite 5173
  instance 0 default           -> probe 8765, CDP 9222, profile webview-data/
```

The default instance slot equals the checkout slot, so `tools/dev.py` with no arguments still reaches the interactive window.

### Slot stability

The rules that keep slots from moving on their own.

1. A checkout's slot is a stored preference, not a live claim. The stored value is `app/dev/.dev-slot`.
2. Starting a checkout keeps its preferred slot whenever that slot is free. The file is not rewritten.
3. A slot is busy while a live claim exists for it, or while any of its three ports is bound. Closing the session removes the claim and frees the ports, so the slot becomes available again.
4. A checkout only ever changes its own `.dev-slot`, and only when its preferred slot is busy with another checkout. It never renumbers another checkout, open or closed.
5. On reopen the checkout tries its preferred slot first. If that slot is now busy with another checkout, it takes a free slot and writes the new number to its own file.
6. A checkout that already has a running session is never given a new slot. Starting up again attaches to the session already running, or stops with an error. It does not rewrite `.dev-slot`.

Two rules decide the ambiguous cases.

If the preferred slot's ports are bound but no live claim names this checkout, the launcher asks the probe on that slot who it is. `/health` reports the checkout path, so the launcher can tell its own leftover window from a stranger. If the answer is this checkout, it attaches. If the answer is another checkout, it reallocates. If nothing answers, Vite is up without an app, and the launcher stops with a message rather than move the number under a running Vite.

A slot frees when its session ends. Nothing renumbers. A reopened checkout reuses its old number when it can.

### Who reads the slot, and when

Every process reads the number once at startup, from `DEV_SLOT` or from `app/dev/.dev-slot`. No reader caches it across runs, and nothing stores it anywhere else. `.dev-restarts.jsonl` records it per restart, but no code parses that file.

So a slot change is safe for the next start. Vite, `watch.py`, the app, `tools/dev.py`, and `ui/dev/browser.mjs` all re-read the file. The one care is that a running process keeps the number it started with, so a slot change means restarting Vite and `watch.py`, not just the window. A `dev.py watch` loop also pins the number for its whole run.

The WebView2 profile is keyed to the checkout, not the slot. A slot change does not cost the login.

### How slots are tracked

Three layers, and only one of them is shared.

The ports are the hard truth. A slot is in use while any of its three ports is bound. The OS owns the ports, not a file, so every worktree gets the same answer from a bind attempt. This layer needs no coordination.

The preference is local. Each checkout keeps its own favourite number in `app/dev/.dev-slot`. A checkout writes only its own copy, and the value means nothing to anyone else. This is why the plan never writes into a sibling worktree's file.

The live registry is shared and singular. It lives in the git common directory, from `git rev-parse --path-format=absolute --git-common-dir`. From the main checkout that prints `<repo>/.git`. From a linked worktree it prints the same main checkout's `.git`, which I verified on this machine with git 2.56. So all worktrees of one repository read and write a single directory. A worktree's own git dir, at `.git/worktrees/<name>`, is private and would be invisible to its siblings, so the registry must not go there.

Registry layout under `<git-common-dir>/ytmusic-dev/`.

- `slots/<n>.json` is a live claim. It holds `slot`, `checkout`, `pid`, `role`, and `started`.
- `lock` is one file used only to serialise the read-then-claim step, so two checkouts starting at once cannot both take the last free slot.

### Claim ownership

One claim per slot in use, and the owner is the process that starts the session.

- The checkout slot is claimed by the session supervisor. That is `tools/dev.py up` when the launcher runs, or `watch.py` when it is started raw. The claim records the supervisor pid and, when known, the Vite pid. It is released by `dev.py down`, or treated as stale when the recorded pids are all dead.
- An ephemeral instance claims its own slot from the app process, `main.py`, on start, and releases it on exit from `atexit` and a `finally` around `webview.start`.

The default instance does not claim on its own, because the checkout claim already covers its slot. Vite does not claim at all. Its port binding is what the port check sees, and that is enough to stop a second Vite from taking the slot.

The claim is written inside the lock at allocation time, so two checkouts that start together cannot both take the same number. This is the step the earlier draft got wrong by claiming later, in the app, after the slot was already written.

A claim whose recorded pids are all dead is stale. `slot_free` treats a slot as free only when the claim is stale or absent and all three ports are bindable.

### Allocation

Add `app/dev/slots.py`.

- `checkout_slot()` returns `DEV_UI_SLOT`, then `app/dev/.dev-slot` and its older paths, then 0.
- `registry_dir()` runs `git rev-parse --path-format=absolute --git-common-dir`, appends `ytmusic-dev`, and falls back to `data_dir()` when git is missing, which covers the frozen exe.
- `is_linked_worktree()` is true when `.git` is a file rather than a directory.
- `slot_free(slot)` is true when all three ports are bindable and no live claim exists.
- `ensure_checkout_slot()` resolves the preferred slot, applies the stability rules, writes `.dev-slot` only when it must move, and returns the slot.
- `claim_slot(slot, role)` creates `slots/<n>.json` with `O_CREAT|O_EXCL`, inside the lock.
- `release_slot(slot)` deletes the claim on clean exit.

Search order when a checkout starts.

1. The checkout's preferred slot, if it is free.
2. A free slot that no other checkout prefers. This keeps a closed checkout's slot reserved so it does not get stolen and the reopened checkout does not shift.
3. Any free slot.

Slot 0 belongs to the main checkout. Every other checkout searches from 1 upward. If nothing is free in 1 through 50, the launcher stops with an error rather than share a port.

The registry sits outside every working tree, so nothing in the repo needs to ignore it. A claim from a deleted worktree is reclaimed by pid liveness the next time any checkout scans.

### Client-agnostic allocation

Two call sites allocate, and they share the one implementation.

1. `tools/dev.py up` calls `ensure_checkout_slot()` before it starts Vite and `watch.py`, so both read one value.
2. `watch.py` calls it when the slot file is missing, so a raw `watch.py` start in a fresh worktree heals itself.

Vite only reads. When the file is missing in a linked worktree, `vite.config.ts` stops with a message to run `dev.py up` once, instead of silently binding slot 0 and colliding with main. The Cursor setup script keeps writing the slot at creation time through the same module.

### Launcher

`tools/dev.py up` is the launcher, extended rather than replaced.

1. Ensure the checkout slot.
2. Run `pnpm install` when `ui/node_modules` is missing.
3. Start Vite in the background.
4. Start `watch.py` in the background.
5. Wait for `/health`.
6. Print the URLs.

If a session for this checkout is already running, it prints the ports and exits instead of starting a second copy. `dev.py down` stops the session. The raw `pnpm dev` plus `watch.py` flow still works once a slot file exists.

`tools/dev-up.ps1` is an optional one-line wrapper for people who prefer PowerShell.

### Ephemeral instances

`tools/dev.py instance up` allocates a free instance slot in the same registry with role `instance`, starts one `main.py` with `DEV_SLOT` set to that slot and `DEV_UI_SLOT` set to the checkout slot, and prints the probe and CDP ports. `dev.py instance down` stops one, and `dev.py instance list` shows the live ones. The instance uses profile `webview-data-<slot>/`, so it never shares a profile with the default or with another instance.

### Required code changes

| Area | Change |
| --- | --- |
| `app/dev/slots.py` | New. The allocator, the registry, claims, and `ensure_checkout_slot()`. |
| `app/dev/identity.py` | Add `ui_slot()` for the checkout. Keep `dev_slot()` as the instance slot. `ui_port()` and `ui_origin()` use `ui_slot()`. `probe_port()` and `debug_port()` use `dev_slot()`. Add `checkout` to `health_payload()`. |
| `app/dev/watch.py` | Set `DEV_SLOT` and `DEV_UI_SLOT` on the child. Claim the checkout slot when it is the session supervisor, and call `ensure_checkout_slot()` when the slot file is missing. |
| `app/main.py` | Claim an ephemeral instance slot on start and release it on exit. Use `webview-data/` when the instance slot equals the checkout slot, otherwise `webview-data-<slot>/`. |
| `app/dev/screenshot.py` | Replace `FindWindowW` with `EnumWindows` and `GetWindowThreadProcessId`, and keep only the `YTMusic` window owned by `os.getpid()`. |
| `tools/dev.py` | Extend `up` to ensure and claim the slot for the session, attach when a session is already running, and add `instance up`, `instance down`, `instance list`. Read the ui port from the checkout slot and the probe and CDP ports from the instance slot. |
| `ui/vite.config.ts` | Stop with a clear message when the slot file is missing in a linked worktree. Do not let `DEV_SLOT` move the Vite port. |
| `.cursor/setup-worktree-windows.ps1` | Call `app/dev/slots.py` for the slot instead of its own scan. |
| `AGENTS.md` | Add the two-number rule, the slot stability rules, the profile rule, and `dev.py up`. |

## Walkthrough

This traces the original intent from end to end.

Main is on slot 0. An agent creates `feature-a` with opencode `worktree_create`, which runs no setup, so the new checkout has no `.dev-slot`. The agent runs `dev.py up` in it. `ensure_checkout_slot()` sees a linked worktree with no preference, finds slot 1 free, writes `.dev-slot` of 1, claims it, and starts Vite on 5174 and `watch.py`. The window loads `http://localhost:5174`, the probe is 8766, CDP is 9223, and the profile is `webview-data/`. A screenshot from its probe finds the window owned by its own process, not main's.

A second agent creates `feature-b` the same way and lands on slot 2. Both checkouts run at once, and neither sees the other's ports, Vite, profile, cache, or artifacts.

The agent in `feature-a` wants a clean app for a test. It runs `dev.py instance up`, which takes slot 3, starts an instance on probe 8768 and CDP 9225 with profile `webview-data-3/`, and prints the ports. It runs a `verify/*.mjs` journey against CDP 9225, then `dev.py instance down`, which frees slot 3. The interactive window on slot 1 was never touched.

The agent finishes and runs `dev.py down` in `feature-a`. The app releases its claim and the ports come free, so slot 1 is available. `.dev-slot` still says 1.

While `feature-a` is closed, a third checkout `feature-c` is created. The search prefers slots no other checkout prefers, so it skips 1 and lands on 3. `feature-a` keeps its claim on 1 for later.

`feature-a` reopens with `dev.py up`. Its preferred slot 1 is free, so it reuses 1 and does not rewrite the file. If another checkout had taken 1 in the meantime, `feature-a` would take the next free slot and rewrite only its own file, and no other checkout would move.

## Phases

| Phase | Deliverable | Checkpoint | Effort |
| --- | --- | --- | --- |
| 1 | Allocation and isolation. `slots.py`, the registry, the `ui_slot` and `dev_slot` split, `ensure_checkout_slot`, the per-instance profile, the window-by-PID fix, `checkout` in `/health`, and `dev.py up` ensuring the slot. | Two worktrees created by any tool run at once with distinct slots. Closing one frees its slot, reopening reuses it. A screenshot from each probe returns its own window. | M |
| 2 | Ephemeral instances. `dev.py instance up/down/list`, the Vite missing-slot message, and the optional `dev-up.ps1`. | Spawn an instance, drive it over CDP, kill it, and leave nothing running. | M |
| 3 | Docs. The AGENTS.md workflow and the port and profile rules. | A new agent follows the notes without reading the code. | S |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A per-instance profile loses the existing login | Only non-default slots use a new directory. The checkout default keeps `webview-data/`. `browser.json` still seeds API auth. |
| A claim file is left behind after a crash | A claim with a dead pid is stale. Reclaim it when the ports are free too. |
| Two checkouts prefer the same slot | The claim resolves it. The loser moves and rewrites only its own file. |
| A closed checkout's slot gets taken before it reopens | Search prefers slots no other checkout prefers, which reserves closed checkouts. |
| A leftover Vite with no app | The port check sees it and the launcher stops with a message instead of renumbering under it. |
| The git common dir is unavailable, for example in a bare clone | Fall back to `data_dir()` for the registry and to port probing alone, which still prevents two checkouts from sharing a port. |
| Someone still uses the two raw commands | They work once a slot file exists. `watch.py` heals a missing one. Vite gives a clear message. |

## Non-goals

- Gating Discord presence or media keys. You chose to keep them loud.
- One Vite server per instance. Vite is per checkout and instances share it.
- Isolating `browser.json` writes per instance. It is read-mostly. Revisit only if it causes trouble.
- Separate clones that are not worktrees. They share no git common dir, so only port probing keeps them apart. The registry would need a user-level home to cover them.

## How we'll know it worked

- Two worktrees, two windows, two probes, two Vite servers, one command each, no shared port.
- A worktree created by any tool gets a distinct slot with no manual step.
- A screenshot from a checkout's probe always captures that checkout's window.
- Closing a checkout frees its slot, and reopening that checkout takes the same slot back when it is free.
- An agent can spawn an instance, run a journey, kill it, and leave nothing running.
