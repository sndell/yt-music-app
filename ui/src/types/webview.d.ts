import type { ApiMethodName, ApiParams, ApiResponse, InternalMethods } from "../lib/api/generated/methods";

type ShippedApi = {
  [M in ApiMethodName]: (...args: ApiParams<M>) => Promise<ApiResponse<M>>;
};

/** Dev-only methods, reachable from the page and outside the UI contract. */
type InternalApi = {
  [M in keyof InternalMethods]: (...args: InternalMethods[M]["params"]) => Promise<InternalMethods[M]["response"]>;
};

declare global {
  interface Window {
    pywebview?: { api: ShippedApi & InternalApi };
    pythonEvent?: (action: string, payload?: unknown) => void;
  }
  interface WindowEventMap {
    pywebviewready: CustomEvent;
  }
}

export {};
