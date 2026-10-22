import { useEffect, useState } from "react";
import { PyBridge } from "@/lib/api";
import type { UpdateStatus } from "@/lib/api/types";

/**
 * The update check, read once per session and shared, so the Sidebar badge and
 * the Settings section show the same answer without each asking Python. Python
 * owns the check itself (warmed at startup, cached in memory for hours); this
 * only mirrors its status().
 */
interface UpdateState {
  status: UpdateStatus | null;
  error: string | null;
}

const listeners = new Set<(state: UpdateState) => void>();
let cached: UpdateState = { status: null, error: null };
let loading: Promise<void> | null = null;

const publish = (state: UpdateState) => {
  cached = state;
  for (const listener of listeners) listener(state);
};

// One read per session: a failed check publishes its error and stops polling,
// because Python already retries on its own TTL.
const load = () => {
  loading ??= PyBridge.getUpdateStatus().then((result) => {
    loading = null;
    if (result.success) publish({ status: result.data, error: null });
    else publish({ status: null, error: result.error.message });
  });
  return loading;
};

export const useUpdateStatus = () => {
  const [state, setState] = useState(cached);
  useEffect(() => {
    listeners.add(setState);
    if (cached.status == null && cached.error == null) void load();
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
};
