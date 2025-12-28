/**
 * PyWebView Bridge - Type-safe communication with Python backend
 */

import type { ApiMethodName, ApiParams, ApiResponse, Result } from "./types";

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

async function callPython<M extends ApiMethodName>(
  method: M,
  ...args: ApiParams<M>
): Promise<Result<ApiResponse<M>>> {
  try {
    const ready = await waitForMethod(method);

    if (!ready) {
      log("error", `Method "${method}" not found on Python API (timeout)`);
      return { success: false, error: { code: "METHOD_NOT_FOUND", message: `Method "${method}" not found` } };
    }

    const fn = window.pywebview!.api[method];
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

/** Type-safe access to all Python API methods */
export const PyBridge = {
  getPlaylists: () => callPython("get_playlists"),
  getPlaylistItems: (playlistId: string, forceRefresh = false) =>
    callPython("get_playlist_items", playlistId, forceRefresh),
  generateAuthHeader: (headers: string) => callPython("generate_auth_header", headers),
  invalidatePlaylistCache: (playlistIds: string[]) => callPython("invalidate_playlist_cache", playlistIds),
  clearAllCache: () => callPython("clear_all_cache"),
} as const;
