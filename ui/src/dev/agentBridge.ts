/**
 * Dev-only bridge: forward renderer console output and uncaught errors to the
 * Python probe so an agent can read them with `tools/dev.py logs` instead of
 * guessing. Loaded only when `import.meta.env.DEV`, and it waits for pywebview
 * to be ready before it sends anything.
 */

type Level = "info" | "warning" | "error" | "unhandled";
type Kind = "console" | "error" | "rejection" | "react" | "boot";

export type RendererEntry = {
  ts: number;
  level: Level;
  kind: Kind;
  message: string;
  stack?: string;
  url?: string;
};

const MAX_BUFFER = 200;
const MAX_TEXT = 2000;

const buffer: RendererEntry[] = [];
let flushing = false;
let installed = false;

const safeStringify = (value: unknown): string => {
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const clip = (value: unknown): string => {
  const text = typeof value === "string" ? value : safeStringify(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text;
};

const bridgeApi = (): Record<string, unknown> | undefined =>
  (window as unknown as { pywebview?: { api?: Record<string, unknown> } }).pywebview?.api;

/** The PyBridge info lines carry whole payloads; dropping them keeps the ring readable. */
const isNoise = (level: Level, message: string) => level === "info" && message.startsWith("[PyBridge]");

const flush = () => {
  if (flushing) return;
  const api = bridgeApi();
  if (!api || typeof api.dev_report !== "function" || buffer.length === 0) return;
  flushing = true;
  const entries = buffer.splice(0, buffer.length);
  Promise.resolve(api.dev_report({ entries }))
    .catch(() => undefined)
    .finally(() => {
      flushing = false;
    });
};

export const reportRendererEntry = (entry: Omit<RendererEntry, "ts"> & { ts?: number }) => {
  if (isNoise(entry.level, entry.message)) return;
  buffer.push({ ts: entry.ts ?? Date.now() / 1000, ...entry });
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  flush();
};

/** Patch the console and error hooks once. Safe to call more than once. */
export const installAgentBridge = () => {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const levels: Array<[keyof Console, Level]> = [
    ["error", "error"],
    ["warn", "warning"],
    ["info", "info"],
  ];
  for (const [method, level] of levels) {
    const target = console as unknown as Record<string, (...args: unknown[]) => void>;
    const original = (target[method] || (() => undefined)).bind(console);
    target[method] = (...args: unknown[]) => {
      reportRendererEntry({ level, kind: "console", message: args.map(clip).join(" ") });
      original(...args);
    };
  }

  window.addEventListener("error", (event) => {
    reportRendererEntry({
      level: "error",
      kind: "error",
      message: clip(event.message || "window error"),
      stack: event.error instanceof Error ? event.error.stack : undefined,
      url: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    reportRendererEntry({
      level: "unhandled",
      kind: "rejection",
      message: clip(reason instanceof Error ? reason.message : reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  // pywebview injects its API after load; flush once it says so and on a timer
  // so entries queued before the bridge existed still land.
  window.addEventListener("pywebviewready", flush);
  window.setInterval(flush, 500);
  // Marks this page load, so the probe can ignore errors a reload already
  // cleared instead of reporting them as the window's current problem.
  reportRendererEntry({ level: "info", kind: "boot", message: "renderer boot" });
  flush();
};
