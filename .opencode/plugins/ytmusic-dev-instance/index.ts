import { Plugin } from "@opencode/plugin"
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

// Registers the git worktree strategy with one addition: after a worktree is
// created, install its dependencies and start its own app instance. Worktrees
// are created from the canonical checkout, so this is where the tooling lives.
//
// It replaces the bundled git strategy, so it must keep working when the app
// cannot start. Only the git step is fatal; provisioning and starting the app
// are best effort.

const ID = "ytmusic.dev-instance"

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
function provision(python: string, directory: string): string | undefined {
  const tool = path.join(directory, "tools", "dev.py")
  if (!existsSync(tool)) {
    log(`no tools/dev.py in ${directory}; skipping setup`)
    return undefined
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
  return tool
}

function start(python: string, tool: string, directory: string): void {
  const child = spawn(python, [tool, "up"], { cwd: directory, detached: true, stdio: "ignore" })
  child.unref()
  log(`starting this worktree's app: ${directory}`)
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
      log(`no venv in ${input.sourceDirectory}; worktree created without an app`)
      return { directory: input.directory }
    }
    const tool = provision(python, input.directory)
    if (tool) start(python, tool, input.directory)
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
    if (!ctx.worktree?.transform) {
      log("this opencode build has no worktree.transform; plugin inactive")
      return
    }
    await ctx.worktree.transform((editor) => {
      editor.add(gitWorktrees)
    })
    log("worktree strategy registered")
  },
})
