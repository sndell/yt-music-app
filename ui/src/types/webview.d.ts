import type { ApiMethodName, ApiParams, ApiResponse } from "../lib/api/types";

type PyWebViewApi = {
  [M in ApiMethodName]: (...args: ApiParams<M>) => Promise<ApiResponse<M>>;
};

declare global {
  interface Window {
    pywebview?: { api: PyWebViewApi };
    pythonEvent?: (action: string, payload?: unknown) => void;
  }
  interface WindowEventMap {
    pywebviewready: CustomEvent;
  }
}

export {};
