import { Plugin } from "@opencode/plugin"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// Registers the git worktree strategy with two additions:
//
//   1. After a worktree is created, install its dependencies and assign its
//      slot, so the agent does not provision anything by hand.
//   2. On the first prompt in a session whose directory is a linked worktree,
//      nudge the session to start that worktree's app as a background shell.
//
// The plugin API cannot create a shell task, so the agent runs the command and
// the task shows in its session. A detached start here would also make the
// agent's own `up --attach` exit with "already running".

const ID = "ytmusic.dev-instance"
const NUDGE_MARK = "ytmusic-dev-instance:nudge"

const nudged = new Set<string>()

function log(message: string): void {
  console.error(`[${ID}] ${message}`)
}

function mainPython(sourceDirectory: string): string | undefined {
  const candidates = [
    path.join(sourceDirectory, "app", ".venv", "Scripts", "python.exe"),
    path.join(sourceDirectory, "app", ".venv", "bin", "python"),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim()
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}): ${detail}`)
  }
  return result.stdout ?? ""
}

// Install UI dependencies, assign a slot, and copy app/browser.json. Slow on
// the first run, so give it room; a failure is logged, not thrown.
function provision(python: string, directory: string): void {
  const tool = path.join(directory, "tools", "dev.py")
  if (!existsSync(tool)) {
    log(`no tools/dev.py in ${directory}; skipping setup`)
    return
  }
  const result = spawnSync(python, [tool, "setup"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  })
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim()
    log(`setup failed in ${directory}: ${detail || `exit ${result.status}`}`)
  }
}

function isLinkedWorktree(directory: string): boolean {
  try {
    return statSync(path.join(directory, ".git")).isFile()
  } catch {
    return false
  }
}

// The interpreter tools/dev.py recorded for the worktree, a local venv, or the
// canonical checkout's venv. An unprovisioned worktree still works, because
// `up --attach` runs the setup itself.
function worktreePython(directory: string, canonical: string | undefined): string | undefined {
  try {
    const recorded = readFileSync(path.join(directory, "app", "dev", ".dev-python"), "utf8").trim()
    if (recorded) return recorded
  } catch {
    // not provisioned; fall through
  }
  return mainPython(directory) ?? (canonical ? mainPython(canonical) : undefined)
}

function nudgeText(directory: string, python: string): string {
  const tool = path.join(directory, "tools", "dev.py")
  return [
    `${NUDGE_MARK}`,
    `This worktree's app is not running. Start it as a background shell so the task stays visible, from ${directory}:`,
    "",
    `    "${python}" "${tool}" up --attach`,
    "",
    `Wait for the "[dev] started slot=..." line, then drive it with tools/dev.py state, logs, and screenshot.`,
  ].join("\n")
}

async function nudge(ctx: any, sessionID: string | undefined): Promise<void> {
  if (!sessionID || nudged.has(sessionID)) return
  nudged.add(sessionID)
  try {
    const session = await ctx.session.get({ sessionID })
    const directory: string | undefined =
      session?.location?.directory ?? session?.location?.canonical
    if (!directory || !isLinkedWorktree(directory)) return
    const python = worktreePython(directory, ctx?.location?.directory)
    if (!python) {
      log(`no interpreter for ${directory}; not nudging`)
      return
    }
    await ctx.session.synthetic({ sessionID, text: nudgeText(directory, python) })
    log(`nudged ${sessionID} in ${directory}`)
  } catch (error) {
    log(`nudge failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const gitWorktrees = {
  id: ID,
  async create(input: { sourceDirectory: string; directory: string; branch?: string }) {
    const args = ["-C", input.sourceDirectory, "worktree", "add"]
    if (input.branch) args.push("-b", input.branch)
    args.push(input.directory)
    run("git", args, input.sourceDirectory)

    const python = mainPython(input.sourceDirectory)
    if (!python) {
      log(`no venv in ${input.sourceDirectory}; worktree created without setup`)
      return { directory: input.directory }
    }
    provision(python, input.directory)
    return { directory: input.directory }
  },
  async remove(input: { directory: string; force: boolean }) {
    const args = ["-C", input.directory, "worktree", "remove"]
    if (input.force) args.push("--force")
    args.push(input.directory)
    run("git", args, input.directory)
  },
  async list(sourceDirectory: string) {
    const output = run("git", ["-C", sourceDirectory, "worktree", "list", "--porcelain"], sourceDirectory)
    const entries: { directory: string; type: "root" | "worktree" }[] = []
    for (const line of output.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue
      const directory = line.slice("worktree ".length).trim()
      if (!directory) continue
      entries.push({ directory, type: entries.length === 0 ? "root" : "worktree" })
    }
    return entries
  },
}

export default Plugin.define({
  id: ID,
  async setup(ctx) {
    if (ctx.worktree?.transform) {
      await ctx.worktree.transform((editor) => {
        editor.add(gitWorktrees)
      })
      log("worktree strategy registered")
    }

    if (ctx.session?.hook) {
      await ctx.session.hook("prompt", (event: any) => {
        void nudge(ctx, event?.sessionID)
      })
    }
  },
})
