
// ============================================================
// Internal helpers
// ============================================================

const isPyWebView = (): boolean => {
  return typeof window !== "undefined" && window.pywebview !== undefined;
};

async function callPy<T>(method: string, fallback: T): Promise<T> {
  if (isPyWebView()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = window.pywebview!.api as any;
    const fn = api[method];
    if (typeof fn === "function") {
      return fn.call(api);
    }
    return fn;
  }

  console.warn(`[PyBridge] No pywebview, using mock for: ${method}`);
  return fallback;
}

// ============================================================
// Exported API functions
// ============================================================

/**
 * Fetch all playlists from the backend
 */
export async function getPlaylists(): Promise<GetPlaylistsResponse> {
  return callPy("get_playlists", [
    "Mock Playlist 1",
    "Mock Playlist 2", 
    "Mock Playlist 3",
  ]);
}