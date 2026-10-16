# Agent notes

YTMusic is a Windows desktop client for YouTube Music. The UI is Vite in `ui`, the desktop window is Python (`app/main.py`, pywebview), and the two talk over `window.pywebview.api`. That object exists only inside the desktop window. A browser tab on the Vite port does not have it.

These notes are good defaults, not hard rules. The developer's request wins over anything here. When a rule fights the task in front of you, say so instead of breaking it quietly.

## Glossary

- **window** is the pywebview process running `app/main.py`.
- **UI** is the React app in `ui`, loaded from Vite in dev and from `ui/dist` in a frozen build.
- **bridge** is `ui/src/lib/api/bridge.ts`. It calls Python through `window.pywebview.api` and wraps the result in `{ success, data }`.
- **API method** is a public Python method on `MusicApi` or `Api`. The UI reaches it only when it is also in the contract and in the bridge.
- **contract** is `ui/src/lib/api/types.ts`, the one place method params and responses are typed.
- **event** is a Python-to-UI push through `WebViewController.dispatch_event`, which calls `window.pythonEvent`.
- **data_dir()** is where state lives: `app/` in dev, `%LOCALAPPDATA%\YTMusic` in a frozen build.
- **frozen build** is the PyInstaller exe. It serves the packaged UI and starts no dev server.
- **library** is the signed-in user's collection read back from YouTube Music.

## Never destroy what the user has

The signed-in YouTube Music account is the user's data. It is read-only unless this exact conversation asked for a change. Deleting is the one thing that cannot be undone, so it is a hard stop, not a judgement call:

- Never delete a playlist, a song in a playlist, a Like, a library item, an upload, or a history entry.
- Never delete anything you did not create in this same session.
- Never delete or overwrite a file in this repo that the task did not put in play. No `git clean`, no removing directories, no "tidying" files outside the change.
- Never change a playlist's title, description, visibility, or track order unless the task asked for that change.
- Never clear, empty, or reset the queue, the cache, or stored preferences to "fix" a problem.
- Any API method that writes to the account is a write, not an experiment: `create_playlist`, `delete_playlist`, `add_playlist_items`, `remove_playlist_items`, `edit_playlist`, `rate_playlist`, and `rate_song`.
- If a task looks like it needs any of this, stop and ask the user. Do not decide for them.
- Reading is always fine: `get_playlists`, `get_playlist_items`.

## The ways to hurt yourself here

1. **Killing by pattern.** Another window may be running on this machine, and both have this repo's path in their command line. Never `Get-Process` or `taskkill` a PID you found by matching a name or path. Kill only the Vite process the window spawned, by the PID `app/dev/vite.py` already holds.
2. **Fighting over the WebView2 profile.** The profile folder is `app/webview-data`, one per checkout. WebView2 refuses two processes on one folder, so a second window in the same checkout has to point somewhere else. `start.ps1` refuses to start a second one and `cli.py stop` ends the first.
3. **Writing to the account.** See **Never destroy what the user has**.

## Hit every surface

The most common defect here is a change that works on the one path you tried and is missing everywhere else. Before you call a change done, walk this list and name what applied:

- **A new API method.** It needs the Python method, an entry in `ApiMethods` in `ui/src/lib/api/types.ts`, and a wrapper in `PyBridge` in `ui/src/lib/api/bridge.ts`. Miss the contract and `tsc -b` fails; miss the bridge and the UI cannot call it.
- **A Python to UI event.** It needs `WebViewController.dispatch_event` on the Python side and a `window.pythonEvent` handler on the UI side. Only the player listens today.
- **Cached data.** Python caches payloads in `diskcache`. Change a payload's shape and raise the cache key version (`playlist:v4:` today), or the old shape is served from the cache.
- **The frozen build.** The packaged page runs without Vite and without `import.meta.env.DEV`. A change that only works under Vite is not finished.
- **Reverse states.** Every way in needs a way out and a way to see it. Like needs unlike, add needs remove, open needs close.
- **The account.** A read that is fine in dev is still a read of the user's real library. A write needs the conversation to have asked for it.

## Where code lives

| Path | What it is |
| --- | --- |
| `app/main.py` | Startup, the window, and `Api` (media controls, Discord, volume) on top of `MusicApi` |
| `app/features/music_api.py` | The YouTube Music surface the UI calls |
| `app/util/` | Window helpers: paths, audio, media keys, Discord, preferences, the packaged UI server, the event dispatcher |
| `app/dev/` | Dev-only tooling: `vite.py` starts the dev server, `control.py` serves the dev HTTP surface, `logs.py` captures logs, `cli.py` talks to a running instance |
| `ui/src/features/<name>/` | One folder per feature: album, artist, library, player, playlist, search, settings |
| `ui/src/components/ui/` | Shared UI pieces (menus, dialogs, rows, scroll) |
| `ui/src/pages/` | Home and Library |
| `ui/src/lib/api/` | The contract (`types.ts`) and the bridge (`bridge.ts`) |
| `ui/src/lib/orderMap.ts` | Client-side ordering helpers |
| `build/` | `build.ps1` and the PyInstaller spec |
| `start.ps1` | Starts the window for development |

## How it works

The window loads the UI, which calls Python methods through the bridge. Each method returns a plain object, and the bridge turns it into `{ success, data }`. Python owns the network, the cache, and every write to YouTube Music; the UI renders what it gets. Python pushes facts back the other way with `dispatch_event`, which the UI reads through `window.pythonEvent`.

## Run

From the repo root, `.\start.ps1` runs `app/main.py` with `ENV=dev`. The Python process picks a free port, starts Vite on it in its own console window, and stops Vite when the window closes. There is no separate `pnpm dev` to run and no server left behind. Vite opens in a console of its own, so the webview and the Vite log are both visible.

`start.ps1` starts one instance of this checkout. Many can run at once, in one checkout or across worktrees: `-Instance <id>` names one, `-Label <text>` tags it for the window title and listings, and `-Restart` stops only that id. Leave `-Instance` off and a linked worktree is named after its own directory, so an agent in its own checkout runs the script bare and the main checkout stays `default`. A second start with the same id refuses with its pid and ports instead of fighting it for the WebView2 profile. Never hunt for a running instance or probe a port. See **Many agents at once**.

The port is dynamic, so several checkouts can run at once without colliding. The Python terminal logs it (`Starting Vite on port ...`) and the window loads `http://localhost:<port>`. A frozen build serves the packaged `ui/dist` and starts no server.

`start.ps1` uses this checkout's `app\.venv`, and falls back to the main checkout's venv when the checkout has none, so it runs from a worktree. When the process gets no `app\.venv` at all, it uses `python` on PATH, which usually lacks the app packages. A worktree has no `ui\node_modules` either, so `start.ps1` runs `pnpm install --prefer-offline` in `ui` when it is missing; without pnpm on PATH it fails instead of opening a window on a dead port.

Set `AUTO_VITE=0` to start the window against a Vite you run yourself. The window then loads `VITE_PORT`, or 5173.

`app/browser.json` holds the sign-in and is not committed, so a checkout that never signed in starts signed out. A worktree has its own `app\` and no `browser.json`.

Vite listens on `localhost`, which is the IPv6 loopback `[::1]` on this machine, so `netstat -ano -p tcp` shows no listener for its port. Look it up with `netstat -ano`, or `Get-NetTCPConnection -LocalPort <port>` using the port from the log.

## Many agents at once

An **instance** is one window plus its Vite plus its control server, with a private data dir. The instance is the unit of isolation, not the checkout, so several agents work at once without sharing a WebView2 profile, a sign-in file, or a discovery file.

```powershell
.\start.ps1 -Instance like-toggle -Label "fix the like toggle"
.\start.ps1                                    # the `default` instance
```

- `YTM_INSTANCE` names the instance; `app/dev/instance.py` derives the rest. Unset, a linked worktree takes its own directory name (`t3-b5d79117`) and labels itself with its branch, so `-Instance` and `-Label` are only needed for a second window in one checkout. Only the checkout that owns `.git` is `default`, which keeps the old layout (`app/` for data, `app/dev/.dev.json` for discovery), so a bare `start.ps1` in the main checkout changes nothing. Keep `start.ps1`'s `Get-DerivedInstanceId` in step with the Python, or the guard watches a name main.py never writes.
- A named instance gets `app/.instances/<id>/` for its profile, sign-in copy, preferences and stats, and `app/dev/.instances/<id>.json` for discovery. It never writes another instance's file.
- The checkout's `app/browser.json` is copied in at start when that copy is missing or older, so a named instance is signed in straight away. The checkout's file is never modified and a token refresh lands in the instance copy. `-Reseed` forces the copy.
- The diskcache stays shared per checkout (`app/.cache`), so instances read the same warm data instead of each re-fetching the library. `-IsolatedCache` gives one instance its own.
- Media keys and Discord rich presence are OS-wide, so only one window can hold them. A named instance leaves both off; `YTM_MEDIA_KEYS=1` and `YTM_DISCORD=1` opt back in.
- Startup stops when another live instance already owns this instance's data dir, because WebView2 will not open two processes on one profile. That check is per data dir, not per checkout, so two named instances coexist.

## Dev control surface

The dev window also serves a small HTTP surface on a free loopback port, so an agent can drive the app without seeing the screen. The app writes one discovery file per instance at `app/dev/.instances/<id>.json` (gitignored) carrying the pid, ports, instance id, label, branch and data dir; `app/dev/.dev.json` is still written for the `default` instance. `app/dev/cli.py` reads those and uses only the standard library, so any `python` runs it, not just the venv. Name the target with `-i <id>`.

```powershell
python app\dev\cli.py list
python app\dev\cli.py list --worktrees
python app\dev\cli.py -i like-toggle health
python app\dev\cli.py -i like-toggle wait
python app\dev\cli.py -i like-toggle call get_playlists
python app\dev\cli.py -i like-toggle call search "daft punk"
python app\dev\cli.py eval "document.querySelectorAll('*').length"
python app\dev\cli.py -i like-toggle logs --level warning --limit 50
python app\dev\cli.py -i like-toggle screenshot
python app\dev\cli.py -i like-toggle stop
```

- `health` reports the pid, instance, label, branch, ports, and whether the page has loaded. `wait` blocks until it has, and keeps retrying while the instance is still starting, so it is safe to run the moment `start.ps1` returns.
- Without `-i`, the client uses `YTM_INSTANCE`, else the only live instance. With several live it refuses and lists them rather than picking one, because a command must never drive the wrong window. `list` shows them; `list --worktrees` shows every checkout `git worktree list` reports. `list --prune` drops discovery files whose process is gone.
- Reaching another checkout needs `-c <path> -i <id>`; the client fails loudly rather than driving a window that is not this checkout's.
- `stop` closes the window, which stops Vite and removes that instance's discovery file. Use it (or `.\start.ps1 -Instance <id> -Restart`) rather than killing a process.
- `call` runs any public API method. A read is safe; a write changes the signed-in account, so treat it like the app's own buttons. Pass plain string arguments, or `--json` or `--json-file` for a typed list.
- To drive a write path without touching the account, stub the method in the page first: `eval "window.pywebview.api.remove_playlist_items = async () => ({ status: 'SUCCEEDED' })"`. The stub lets the UI code run its real path and shows the state it produces, while the account sees nothing. A reload drops it, so re-install after every reload, and stub every write the flow can reach rather than only the one under test: an unstubbed call is a real edit, and there is no undo for a removal you did not mean.
- A toast action's label is uppercased by CSS, so `innerText` reads `UNDO`, not `Undo`. Match case-insensitively when clicking one, and click it inside the action toast's 5.6s life. Chain the clicks in one `eval` with `setTimeout` when the steps are close together, because each `eval` call costs about a second of round trip.
- `eval` runs JavaScript in the page. Use single quotes inside the expression, because PowerShell strips double quotes on the way to a native command. JS that needs a double-quoted string cannot be passed at all, so write such a selector unquoted (`input[aria-label=Search]`).
- `eval` does not wait on an async expression. Return a promise and the call gives `{}` while its body keeps running in the page, so run a sequence as separate calls with `Start-Sleep` between them.
- `logs` merges three streams: `python`, `renderer` (console output and uncaught errors forwarded from the page), and `vite` (the Vite console, tee'd to that instance's `app/dev/.instances/<id>/artifacts/vite.log` while its own console stays visible).
- `screenshot` writes the window to a PNG and returns its path, which renders in the review pane. With no path it lands in that instance's artifacts dir, so two instances never overwrite one another.

A hard kill leaves a discovery file behind. The port then refuses the connection and the recorded pid no longer answers `/health`, so the client fails loudly instead of reaching a stale instance, and `list --prune` clears the litter.

## Build

From the repo root:

```powershell
.\build\build.ps1
```

That script typechecks the UI, runs `vite build --base ./`, then PyInstaller with `build/YTMusic.spec`. The packaged page needs that base path, so build with `build/build.ps1` rather than `pnpm build` alone. The result is a windowed onefile exe at `build\dist\<yyyy-MM-dd_HHmm>\YTMusic.exe`. Older builds stay in their folders.

The exe has no console. Python logs go to `%LOCALAPPDATA%\YTMusic\ytmusic.log`. The WebView2 profile, auth file, and cache live in that folder, not under `app\`.

The window serves `ui/dist` at `http://localhost:<port>/index.html`. It does not load the Vite dev server.

`ui/vite.config.js` is a committed compiled copy of `ui/vite.config.ts`, and Vite prefers `.js`, so it wins and edits to the `.ts` do nothing. `app/dev/vite.py` therefore launches Vite with `--config vite.config.ts`, which is the only reason the per-instance `cacheDir` takes effect in the app. A manual `pnpm dev` still loads the `.js`; add `--config vite.config.ts` there too if a config change matters to you.

## Verify

Verification is manual. There is no automated suite, so the proof is the diff, the typecheck, the running window, and the dev control surface.

- Reason about the diff first. It is the cheapest check.
- Types, from `ui`: `pnpm exec tsc -b`. `tsconfig.json` there is a solution file with `files: []`, so `tsc --noEmit` compiles nothing and exits 0. `tsc -b` builds the referenced projects, the same check `build/build.ps1` runs first.
- Python: `python -m py_compile app\main.py`, or import the module.
- Then run `.\start.ps1` and drive the app through `app\dev\cli.py` (see **Dev control surface**): `wait`, then `call`, `eval`, `logs`, and `screenshot`. This replaces guessing from the screen. Vite edits refresh in place; a Python edit needs the window restarted. A method the live process predates is not on `window.pywebview.api`, so the call waits out the 30s bridge timeout and the renderer log shows `[PyBridge] Method "<name>" not found on Python API (timeout)`. A new feature that "does not work" against a window older than the Python change is usually just that; `.\start.ps1 -Restart` fixes it.
- The dev window comes up blank while `/health` says loaded and the API methods run: the body is empty and the renderer log shows a `SidebarList` hook-order error with wouter's `useLocation` reading undefined. The cause is Vite's pre-bundled deps. A named instance points `cacheDir` at its own directory, so `cacheDir/deps` sits outside `node_modules` and `@rolldown/plugin-babel`'s default `exclude` does not cover it. Babel then runs the React Compiler over Vite's own dependency chunks, and React's hook order desyncs on the first re-render. A fresh `start.ps1` reproduces it, and a reload on the same server can render, so a reload is not a retest. Both UI configs exclude `cacheDir/deps` from that plugin, so keep that exclusion when the compiler is rewired. Only the dev window sees this: a manual `pnpm dev` and `vite build` leave the dep cache under `node_modules`, which the default exclude already covers.
- Do not launch a browser or drive the screen unless the user asked for it.
- Stop as soon as the evidence covers the change, and never re-run a check you already ran.

## Inspect the packaged window

To open DevTools on the real WebView2, run the exe in the dated folder you want:

```powershell
$env:DEVTOOLS = "1"
.\build\dist\<yyyy-MM-dd_HHmm>\YTMusic.exe
```

The same variable works for the Vite window. Set it in the shell before `app\main.py`. `DEVTOOLS=1` turns WebView2 debug on, opens the DevTools window, and serves the packaged page from that exe. Debug mode is still on in a plain dev window, so the page menu can open DevTools there.

## App notes

Where the data lives: opened playlists are cached on disk by Python (`diskcache` under `app/.cache`), keyed `playlist:v4:<playlistId>` with a 7 day expiry. The payload's `id` field is `None` for a playlist the user does not own, such as `LM`; the id is only in the key. Each track carries `addedAt`, the Unix second it was added, from `playlistItemData.voteSortValue` in the browse response `get_playlist_items` already fetches. ytmusicapi drops it, so `_PlaylistDateCapture` records it during that call and `_apply_added_dates` joins it by `setVideoId`, or by `videoId` order for a playlist owned by someone else. Albums have no add time.

Release dates: YouTube Music publishes a year for a song and never a day, and no list payload carries it. The year is the last run of the song's byline in the playlist panel ("artist • album • year"), which comes back with the `next` request `get_song_info` already sends when a song starts, so the player bar's year costs no extra call. Music videos, uploads and mixes put views or likes in that run instead, so they have none. The one exact date available is `get_song`'s microformat `uploadDate`, and that is when the video was uploaded to YouTube rather than the album's release (Numb uploads 2007, album 2003).

A freshly created playlist cannot be read back at once. YouTube serves a stub browse page with no header section while it prepares the playlist, so `get_playlist` raises `KeyError: contents`, `get_playlist_items` returns `{}`, and the playlist view sits on its loader. Two playlists created on 2026-10-16 read back 15 seconds and 3.5 minutes after creation. `create_playlist` caches the header it already knows (title, privacy, empty track list) when no songs were requested, so the view renders straight away. A create that includes songs cannot describe the track list and is left to the fetch.

Albums are rated through `rate_playlist` with the album's `audioPlaylistId`. ytmusicapi has no `rate_album`. Read the saved state from `get_library_albums` and match on `browseId` or `playlistId`. `get_album`'s `likeStatus` is always `INDIFFERENT`, even for a saved album, because ytmusicapi reads the header toggle's `defaultServiceEndpoint` and never looks at `isToggled`. The album heart is in `ui/src/features/album`, backed by `useAlbumLibrary`.

The saved library lists (`get_library_songs`, `get_library_albums`, `get_library_artists`) are cached whole on disk and return `{songs|albums|artists, fromCache}` so the Library page paints from the cache and refreshes behind it. YouTube Music has no offset for them, only a limit, and paging re-fetches from the top, so the page fetches one large page per category and virtualizes the songs. A library artist row carries that artist's library song count under ytmusicapi's `subscribers` key ("25 songs" → "25"), not the channel's subscriber total, which only `get_artist` reports; `get_library_artists` normalizes it to `songCount`.

The UI accent lives in `ui/src/styles/globals.css` as three literals: `--color-accent`, `--text-color-accent`, and `--background-color-accent`. Change all three together. It colors the playing ring, the player progress and volume bars, and the search library toggle. A separate `--color-success` group (also `--text-color-success` and `--background-color-success`) greens the added-to-playlist checkmarks and the toast success icon and action label. Red stays for errors, destructive actions, and the duplicate badge.

Icons are Iconify classes on spans (`icon-[solar--play-bold]`, `icon-[lucide--dices]`) sized by font-size, not width or height. `@iconify/tailwind4` renders them as 1em inline-blocks and sets no vertical-align, so an icon inside an inline wrapper rides the text baseline and sits about 2px above the label beside it. A base rule in `globals.css` sets `vertical-align: -0.125em` to line them up. Icons that are direct flex or grid children ignore vertical-align and centre through `items-center` and `place-items-center`.

`StickyCollectionBar` (Playlist, Album, Artist) is z-30, above the track rows' z-10 wrappers. The collection pages clear the scroll container's edge-fade mask (`useEdgeFade`) at the very bottom, which drops the container's stacking context, so a z-10 bar ties with the rows and loses to DOM order and the songs paint over it. Only scrolling fully to the bottom shows this.

Draggable rows keep the normal pointer cursor. Songs, sidebar playlists, queue entries, and the `SnapRow` card strips all reorder by drag, but hover shows `cursor-pointer`, not `cursor-grab`. `ui/src/components/ui/reorder.tsx` is the shared wrapper, so a `cursor-grab` added there comes back on every list at once. `SnapRow` still sets `grabbing` while a pointer drag is live, which is the only place that is wanted.

Add-to-playlist writes: the picker sends every add and remove through one queue in `usePlaylist` (`enqueue`, a promise chain), so several quick picks finish one at a time instead of racing the session. YouTube rejects an add whose songs are already in the playlist, because `add_playlist_items` sends no dedupe option. Python returns that as `duplicate: true`, and the toast offers "Add anyway" to send the same edit again with `duplicates=True`. Clicking an added row calls `remove_playlist_videos`, which removes one row per song, using the `setVideoId`s it was given or looking them up in the playlist.

A track row's context menu has no visible button; it opens on `contextmenu`. Dispatch `new MouseEvent("contextmenu", { bubbles: true, clientX, clientY })` on the button's parent to open it. The menu's `Add to playlist` item opens the picker whose rows are easy to compare side by side.

The app uses wouter's hash router, so setting `window.location.hash = "#/album/<browseId>"` moves the window to a route. Pushing a pathname does not, and a reload then drops back to Home.

A `useCallback` that reads `ref.current` fails `react-hooks/preserve-manual-memoization` when the ref is a derived value such as `propRef ?? localRef`, because the compiler infers `ref.current` as a dependency. Move that function into the effect that uses it. A ref received as a prop does not trip it, which is why `useEdgeFade` passes lint.

A music video's thumbnail is drawn in a 16:9 frame only on Home, for the shelf cards and the quick picks rows, so the video shelves read as video. Every other list keeps square art in one column. `isVideoMedia` in `ui/src/components/ui/mediaFrame.ts` decides it and Home is its only caller.

Home shows every shelf `get_home` returns, in feed order. Quick picks is the one vertical list and every other shelf is a row. The shelf set is not stable: the same account returned "Shows for you", then "Live performances", then "IVAN VALEEV" within minutes, so the app cannot decide what to show from a shelf title. A shelf is dropped when none of its items map to a song, album, artist or playlist. Podcast shows are the case that matters, since `get_playlist` raises `KeyError: contents` on a show id (`MPSPPL…`) and the playlist route cannot open one. The payload is cached under `home:shelves:v4`.

Playlists load a page at a time and cache as they go. `get_playlist(playlistId, limit=0)` returns the header plus the first page, about 99 tracks, and `get_playlist_items` returns that page with a `nextToken`. ytmusicapi drops the continuation token, so `_PlaylistDateCapture` reads it from the same browse response with `get_continuation_token`. `get_playlist_page` replays it as a `{"continuation": token}` browse request, takes the next token from `onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems`, and appends the rows to the cached playlist. The view drives the rest itself: a cold open streams pages into the list as they arrive, and a warm open paints the whole cached list then swaps in a fresh read when it finishes, so the painted list never shrinks mid-refresh.

ytmusicapi's `limit` counts continuation items only and pages run about 96 to 99, so `limit=100` returns around 294 tracks. The header's `trackCount` is YouTube's own count and runs ahead of the rows that parse, because `parse_playlist_items` drops deleted entries (a 1747-song playlist parsed 1731). A generated mix that reports no track count is left at one page and no token. `RDAMPL…` and `RDAMVM…` ids never reach that point: `get_playlist` raises `KeyError` while it parses the header, at any limit, so the playlist route cannot open one. `RDCLAK5uy_…` mixes do parse and report a count, so they read whole like a sized list. That report can disagree with the library list: every owned playlist in one 25-playlist library matched its `get_playlists` count exactly, while a non-owned `RDCLAK5uy_…` mix read 111 there and 105 in its header. Only an owned playlist can be edited, so a count taken from one endpoint is safe to show for the other.

`get_playlist_all_tracks` reads every page, for the callers that cannot work from one: `queuePlaylist` and `trueShufflePlaylist` in the player, the duplicate check in `add_playlist_items`, and the row lookup in `remove_playlist_videos`.

ytmusicapi's `get_lyrics` reads from an `MPLYt…` browse id, which only a `get_watch_playlist` response carries; a queue track has none. `MusicApi.get_lyrics` therefore takes the playing song's video id, resolves the browse id through the watch playlist, and caches the result per video id, including a song that has no lyrics. The queue panel's Lyrics tab reads it for the current song and refetches when the song changes, and the tab only appears when the song has lyrics.

Timed lyrics come from YouTube's own mobile client, and that client refuses a request carrying both the web `cookie` and its `SAPISIDHASH` — HTTP 400 "invalid argument", whatever the client version, key, user agent or context fields. The same request unsigned returns `timedLyricsModel` with per-line millisecond cue ranges, so `_timed_lyrics` sends it from a second client that never signs in (`_signed_out_client`, held by `_lyrics_lock`). That also keeps `as_mobile()`'s in-place client swap off the client every other call shares, which otherwise 400s a concurrent request. Not every song has timings; then the panel shows the plain text with no highlight, and `lines` is what drives the highlight when they are there.

True random on a playlist starts before the list is read. `trueShufflePlaylist` reads the first page, plays a random song from it, reads the rest behind the queue, then swaps in the shuffled order with a spinner on the Queue tab. That first read comes from the cache, which still carries a `nextToken` until every page has streamed, so a partly loaded playlist falls back to the full read.

## Music video overlay

The player bar's video button toggles a video overlay when the playing song has a music video. `currentVideoId` in `PlayerContext` decides this with `musicVideoId`: the row's own id when its `videoType` is `MUSIC_VIDEO_TYPE_OMV`, or the watch playlist's `counterpart` id when the counterpart is an OMV. Library songs are all `MUSIC_VIDEO_TYPE_ATV`, so the counterpart is the usual path.

`VideoOverlay` draws over the sidebar and the routed content on black. `main.tsx` wraps the sidebar and the content pane in a `relative` box and puts the overlay in it, so the black cover reaches the left bar while the queue and the player bar stay put. The overlay is inset and rounded like the other panels. It uses the YouTube IFrame Player API (`lib/youtube.ts` loads `iframe_api` once). The embed is muted and clickable, so the YouTube title and link work, but its control bar is off (`controls=0`), which drops volume, progress, and settings together. YouTube's `controls` is all or nothing, so the subtitle and fullscreen buttons go with the bar; there is no partial bar. Control still moves both ways: capture-phase `play`, `pause`, and `seeked` on the app's `<audio>` move the embed, and the embed's `onStateChange` pauses or plays the audio. The one-second poll keeps the picture on the audio only while both play (`getPlayerState()` is 1), so a pause is left alone instead of being forced back. Playback drift stays around 0.3s. The player bar's video button uses the `dense` icon scale, because the film-frame glyph fills its box and looks larger than the shuffle and repeat icons at the same scale.

## Taste

- Python is the source of truth. Keep business rules, network calls, and YouTube's messy shapes in `app`. The UI calls one method and renders the result.
- Type it once. Add a method to `ApiMethods` and infer from it; do not redeclare the shape in the UI.
- Complexity belongs at the boundary. Parsing YouTube happens in Python so the UI sees clean objects.
- Every payload crosses the bridge as JSON. Watch what you send, and keep long lists virtualized (`@tanstack/react-virtual`).
- Comments say why: a constraint, an external quirk, or an invariant the code cannot show. Do not restate the name or narrate steps.
- The user runs this all day and notices a stale label and a wrong count. Prefer the honest empty state over a spinner that lies.

## Pull requests and work artifacts

- Never open a pull request unless the developer asks.
- One request is one pull request.
- Do not commit plans, research notes, or scratch files. Keep working material outside the repo.
- A merged pull request is the record. Do not keep a second checklist in the repo.

## Shell

The repo is Windows-only (pywebview + WebView2, PowerShell build script). Run commands as PowerShell. Use `curl.exe`, not `curl` (an alias for `Invoke-WebRequest` in Windows PowerShell).

## Do what they meant

Treat a request as the intent behind it, not a literal script. When someone asks for X, work out what X implies and do the parts that are clearly the same change: a renamed method moves its callers, a new field reaches the type, the parser, the stored shape and the UI. Before you call it done, search for the other places the change touches.

Stay inside that intent. Do not redesign, reformat, or refactor what nobody asked about, and do not pile on improvements. When the implied work is large, risky, or genuinely ambiguous, do the safe part, say what you skipped, and why.

## Fan the work out

Orchestration is cheap here and usually wins. Split off anything that does not depend on what you are doing: ask an explore subagent "where does this live / how does it work", give a self-contained chunk to a general subagent, and run builds, installs, and long commands as background shells instead of blocking on them. Fire independent calls in the same block so they overlap, and keep the main thread for the decisions and the edits that need it.

Do not parallelize steps that depend on each other, and never let two workers edit the same file: one writer per file. When the pieces come back, check they actually fit together before you trust the result. Parallelism buys time, it does not lower the bar for being right.

## Keep these notes current

The app changes, so these notes change with it. While you work, watch for a better way to build, inspect, upgrade, or implement something in this repo. When you find one, add it to this file before you finish, so the next agent starts with it instead of rediscovering it.

Write it the way the rest of this file is written: what to run or check, when it helps, and the trap that wastes time. Short and specific, from a real run, not a guess. Do not rewrite or delete notes you have not verified.

Add only what running the repo taught you. No note about your own edit, no in-joke, no "do not delete this"; the next agent cannot use it.

## Apply unslop by default

Run the `unslop` skill (id `unslop`, installed in the global skills source) over all prose in this repo: chat replies, commits, PR text, UI copy, and edits to this file. It is hidden from the model's skill list, so load it yourself with `@unslop` or the skill tool before finalizing text. The existing notes in this file keep their wording; apply unslop to what you add.

## Don't

- Don't delete or alter anything in the signed-in account. See **Never destroy what the user has**.
- Don't kill a process you found by name or path. See **The ways to hurt yourself here**.
- Don't run `pnpm build` alone to produce a release. Use `.\build\build.ps1` (it sets `--base ./`).
- Don't read, print, or commit `app/browser.json`. It holds the signed-in session.
