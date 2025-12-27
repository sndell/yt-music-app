
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

async function callPy<T>(method: string, fallback: T): Promise<T> {
  await waitForPyWebView();
  
  if (isPyWebView()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = window.pywebview!.api as any;
    const fn = api[method];

    if (typeof fn === "function") {
      return fn.call(api);
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