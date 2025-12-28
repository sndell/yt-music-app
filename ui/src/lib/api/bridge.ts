
// ============================================================
// Internal helpers
// ============================================================


function waitForPyWebView(): Promise<void> {
  return new Promise((resolve) => {
    if (isPyWebView()) {
      resolve();
      return;
    }

    const handler = () => {
      window.removeEventListener("pywebviewready", handler);
      resolve();
    };

    window.addEventListener("pywebviewready", handler);
  });
}

const isPyWebView = (): boolean => {
  return typeof window !== "undefined" && window.pywebview !== undefined;
};

async function callPy<T>(method: string, fallback: T, ...args: unknown[]): Promise<T> {
  await waitForPyWebView();
  
  if (isPyWebView()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = window.pywebview!.api as any;
    const fn = api[method];

    if (typeof fn === "function") {
      return fn.call(api, ...args);
    }

    if (fn === undefined) {
      console.error(`[PyBridge] Method "${method}" not found on Python API`);
      return fallback;
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
  return callPy("get_playlists", []);
}

/**
 * Fetch all items from a playlist
 */
export async function getPlaylistItems(playlist_id: string): Promise<GetPlaylistItemsResponse> {
  return callPy("get_playlist_items", {} as GetPlaylistItemsResponse, playlist_id);
}

/**
 * Generate auth header
 */
export async function generateAuthHeader(headers: string): Promise<void> {
  return callPy("generate_auth_header", undefined, headers);
}