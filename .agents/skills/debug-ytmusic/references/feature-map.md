# Feature map

One entry per user-facing feature: how a user reaches it, how an agent drives it, what proves it works, and what failure looks like. Copy the template, fill it from a real run.

Every entry here is **read-only**. The signed-in account must not be changed; see `AGENTS.md`, "Never destroy what the user has".

## Template

### <feature name>

- **Reaches it.** The exact route/click a user takes.
- **Agent drives it.** The exact CLI/browser steps. Read-only.
- **Proves it works.** The observable state that must hold.
- **Failure looks like.** The specific symptom of a break.

---

## Playlist list in the left sidebar

- **Reaches it.** The sidebar shows the user's playlists on every page. Liked Music is pinned to the top (id `LM`).

- **Agent drives it.** Read the current shape. Do not create, edit, or delete anything.

  ```powershell
  .\app\.venv\Scripts\python.exe tools\dev.py state
  .\app\.venv\Scripts\python.exe tools\dev.py browse run tools/verify/sidebar.mjs
  ```

- **Proves it works.** `state` reports `dom.playlistCount > 0`, `dom.playlistIds[0] === "LM"`, and `dom.spinners === 0`. `tools/verify/sidebar.mjs` asserts the same against the real window.

- **Failure looks like.** No rows at all, `LM` not first, or a spinner over a populated list. A row that is present but in the wrong place is a layout failure; confirm with `screenshot --diff`, not DOM order alone.

- **Creating a playlist** is a change to the user's account. To watch it work, ask the user to do it while you read `logs` and `state`. Never create or delete one yourself.

---

## Route walk (Home, Library, Search, Settings)

- **Reaches it.** The sidebar navigation, or the hash directly: `#/`, `#/library`, `#/search`, `#/settings`.

- **Agent drives it.**

  ```powershell
  .\app\.venv\Scripts\python.exe tools\dev.py browse run tools/verify/navigation.mjs
  ```

- **Proves it works.** Every route paints its own content, the sidebar keeps at least one row with `LM` first, and no loader sits over the sidebar (`navigation.mjs` checks all four).

- **Failure looks like.** A blank frame, a heading left behind by the previous route, or a sidebar loader that never clears.
