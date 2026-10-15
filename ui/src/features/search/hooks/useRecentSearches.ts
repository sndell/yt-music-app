import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "ytmusic.recent-searches";
const MAX_RECENT = 8;

const read = (): string[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
};

/** Recent search terms, persisted to local storage and capped at `MAX_RECENT`. */
export const useRecentSearches = () => {
  const [recent, setRecent] = useState<string[]>(read);

  useEffect(() => {
    const onStorage = () => setRecent(read());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const persist = useCallback((next: string[]) => {
    setRecent(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage can be unavailable; keep the in-memory list.
    }
  }, []);

  const add = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      const next = [trimmed, ...read().filter((value) => value.toLowerCase() !== trimmed.toLowerCase())].slice(
        0,
        MAX_RECENT,
      );
      persist(next);
    },
    [persist],
  );

  const remove = useCallback((query: string) => persist(read().filter((value) => value !== query)), [persist]);

  const clear = useCallback(() => persist([]), [persist]);

  return { recent, add, remove, clear };
};
