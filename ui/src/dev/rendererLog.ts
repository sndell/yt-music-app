/**
 * Forward renderer console output and errors to the Python process.
 *
 * In dev the page talks to Python through `window.pywebview.api`. Sending what
 * the console prints means an agent can read page errors through the dev
 * control server instead of watching the window. Never throws and never awaits,
 * so a failed report cannot break the app.
 */

type Level = "log" | "warn" | "error";

type Entry = {
  level: Level;
  message: string;
  source?: string;
  line?: number;
};

type DevApi = { dev_log?: (entry: Entry) => Promise<void> };

const MAX_TEXT = 2000;
const MAX_PENDING = 500;
let installed = false;
const pending: Entry[] = [];
let flushTimer: number | undefined;

function api(): DevApi | undefined {
  return (window.pywebview as { api?: DevApi } | undefined)?.api;
}

function trySend(entry: Entry): boolean {
  const target = api();
  if (!target?.dev_log) return false;
  try {
    void target.dev_log(entry);
    return true;
  } catch {
    return false;
  }
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    flush();
  }, 200);
}

function flush(): void {
  while (pending.length > 0) {
    if (!trySend(pending[0])) {
      scheduleFlush();
      return;
    }
    pending.shift();
  }
}

function send(entry: Entry): void {
  // The bridge is injected around load, so early entries wait in a queue rather
  // than disappear. Reporting must never be the reason the app fails.
  if (pending.length > 0) {
    if (pending.length < MAX_PENDING) pending.push(entry);
    return;
  }
  if (!trySend(entry)) {
    pending.push(entry);
    scheduleFlush();
  }
}

function clip(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text;
}

export function installRendererLog(): void {
  if (installed) return;
  installed = true;

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      send({ level, message: args.map(clip).join(" ") });
    };
  }

  window.addEventListener("error", (event) => {
    send({ level: "error", message: event.message, source: event.filename, line: event.lineno });
  });

  window.addEventListener("unhandledrejection", (event) => {
    send({ level: "error", message: `unhandled rejection: ${clip(event.reason)}` });
  });

  // The bridge appears around load; drain anything captured before that.
  window.addEventListener("pywebviewready", () => flush());

  send({ level: "log", message: "renderer boot" });
}
