export {};

declare global {
  interface Window {
    pywebview?: {
      api: Record<string, unknown>;
    };
  }
}
