/**
 * PyWebView transport: calling Python and wrapping the answer.
 *
 * The method list is not here; `generated/bridge.ts` derives it from the
 * declarations in `app/features/music_api.py` and `app/main.py`.
 */

import type { ApiMethodName, ApiParams, ApiResponse } from "./generated/methods";
import type { Result } from "./types";

/** The shape the transport calls through; internal methods never go through it. */
type ShippedApi = {
  [M in ApiMethodName]: (...args: ApiParams<M>) => Promise<ApiResponse<M>>;
};

const BRIDGE_TIMEOUT_MS = 30_000;
const DEBUG = import.meta.env.DEV;

function log(level: "info" | "warn" | "error", message: string, ...args: unknown[]) {
  if (!DEBUG && level === "info") return;
  console[level](`[PyBridge] ${message}`, ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMethod(method: string, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (window.pywebview?.api && typeof window.pywebview.api[method as ApiMethodName] === "function") {
      return true;
    }
    await sleep(50);
  }

  return false;
}

export async function callPython<M extends ApiMethodName>(
  method: M,
  ...args: ApiParams<M>
): Promise<Result<ApiResponse<M>>> {
  try {
    const ready = await waitForMethod(method);

    if (!ready) {
      log("error", `Method "${method}" not found on Python API (timeout)`);
      return { success: false, error: { code: "METHOD_NOT_FOUND", message: `Method "${method}" not found` } };
    }

    const fn = (window.pywebview!.api as ShippedApi)[method];
    log("info", `Calling ${method}`, args);
    const result = await fn(...args);
    log("info", `${method} returned`, result);

    return { success: true, data: result as ApiResponse<M> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", `${method} failed:`, message);
    return { success: false, error: { code: "CALL_FAILED", message } };
  }
}

/**
 * Paint a cached payload, then replace it when a background fetch finishes.
 *
 * Python marks a cached payload `stale` when it is older than the family's
 * refresh window, so a route change that lands inside that window paints from
 * disk and stops: no second call, no re-render of a feed that has not moved.
 * `force` reads the cache first for something to paint, then fetches anyway.
 */
export async function showCachedThenRefresh<T extends { fromCache?: boolean; stale?: boolean }>(
  load: (forceRefresh: boolean) => Promise<Result<T>>,
  apply: (data: T) => void,
  isCurrent: () => boolean,
  options?: { force?: boolean },
): Promise<Result<T> | null> {
  const first = await load(false);
  if (!isCurrent()) return null;
  if (!first.success) return first;
  apply(first.data);
  if (!first.data.fromCache) return first;
  if (!options?.force && !first.data.stale) return first;

  const fresh = await load(true);
  if (!isCurrent() || !fresh.success) return first;
  apply(fresh.data);
  return fresh;
}
