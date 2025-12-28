/**
 * PyWebView Global Type Declarations
 */

import type { ApiMethodName, ApiParams, ApiResponse } from "../lib/api/types";

/**
 * Type-safe PyWebView API interface
 * Maps Python methods to their TypeScript signatures
 */
type PyWebViewApi = {
  [M in ApiMethodName]: (...args: ApiParams<M>) => Promise<ApiResponse<M>>;
};

declare global {
  interface Window {
    pywebview?: {
      api: PyWebViewApi;
    };
  }

  interface WindowEventMap {
    pywebviewready: CustomEvent;
  }
}

export {};
