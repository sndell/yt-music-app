/**
 * PyWebView Bridge
 * Type-safe communication layer between React frontend and Python backend
 */

import type {
  ApiMethodName,
  ApiParams,
  ApiResponse,
  ApiError,
  Result,
} from "./types";

// ============================================================
// Configuration
// ============================================================

const BRIDGE_TIMEOUT_MS = 30_000;
const DEBUG = import.meta.env.DEV;

// ============================================================
// Internal Helpers
// ============================================================

function log(level: "info" | "warn" | "error", message: string, ...args: unknown[]) {
  if (!DEBUG && level === "info") return;
  console[level](`[PyBridge] ${message}`, ...args);
}

function isPyWebViewReady(): boolean {
  return typeof window !== "undefined" && window.pywebview !== undefined;
}

function waitForPyWebView(timeoutMs: number = BRIDGE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isPyWebViewReady()) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      window.removeEventListener("pywebviewready", handler);
      reject(new Error("PyWebView initialization timed out"));
    }, timeoutMs);

    const handler = () => {
      clearTimeout(timeout);
      window.removeEventListener("pywebviewready", handler);
      resolve();
    };

    window.addEventListener("pywebviewready", handler);
  });
}

/**
 * Core bridge function - calls a Python method with full type safety
 */
async function callPython<M extends ApiMethodName>(
  method: M,
  ...args: ApiParams<M>
): Promise<Result<ApiResponse<M>>> {
  try {
    await waitForPyWebView();

    if (!isPyWebViewReady()) {
      return {
        success: false,
        error: { code: "NO_PYWEBVIEW", message: "PyWebView is not available" },
      };
    }

    const api = window.pywebview!.api;
    const fn = api[method];

    if (typeof fn !== "function") {
      log("error", `Method "${method}" not found on Python API`);
      return {
        success: false,
        error: { code: "METHOD_NOT_FOUND", message: `Method "${method}" not found` },
      };
    }

    log("info", `Calling ${method}`, args);
    const result = await fn(...args);
    log("info", `${method} returned`, result);

    return { success: true, data: result as ApiResponse<M> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", `${method} failed:`, message);
    return {
      success: false,
      error: { code: "CALL_FAILED", message },
    };
  }
}

// ============================================================
// Exported API Functions
// ============================================================

/**
 * The PyBridge object provides type-safe access to all Python API methods.
 * Each method returns a Result<T> for explicit error handling.
 */
export const PyBridge = {
  /**
   * Fetch all playlists from the user's YouTube Music library
   */
  getPlaylists: () => callPython("get_playlists"),

  /**
   * Fetch details and tracks for a specific playlist
   * @param playlistId - The YouTube Music playlist ID
   * @param forceRefresh - If true, bypass cache and fetch fresh data
   */
  getPlaylistItems: (playlistId: string, forceRefresh?: boolean) =>
    callPython("get_playlist_items", playlistId, forceRefresh ?? false),

  /**
   * Generate authentication header from raw headers
   */
  generateAuthHeader: (headers: string) => callPython("generate_auth_header", headers),

  /**
   * Invalidate cache for specific playlist IDs
   * @param playlistIds - Array of playlist IDs to remove from cache
   */
  invalidatePlaylistCache: (playlistIds: string[]) =>
    callPython("invalidate_playlist_cache", playlistIds),

  /**
   * Clear all cached data
   */
  clearAllCache: () => callPython("clear_all_cache"),
} as const;

// ============================================================
// Utility Helpers
// ============================================================

/**
 * Unwrap a Result, throwing on error. Use when you want exceptions.
 */
export function unwrap<T>(result: Result<T>): T {
  if (result.success) {
    return result.data;
  }
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

/**
 * Unwrap a Result with a default fallback on error.
 */
export function unwrapOr<T>(result: Result<T>, fallback: T): T {
  return result.success ? result.data : fallback;
}

/**
 * Check if we're running inside PyWebView
 */
export function isInPyWebView(): boolean {
  return isPyWebViewReady();
}

// ============================================================
// Re-export types for convenience
// ============================================================

export type { ApiError, Result } from "./types";
