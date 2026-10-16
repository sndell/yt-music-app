import { useCallback, useState } from "react";

const STORAGE_KEY = "ytmusic-order-map";

type OrderFile = Record<string, string[]>;

const readFile = (): OrderFile => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as OrderFile;
  } catch {
    return {};
  }
};

const writeFile = (file: OrderFile) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
};

/** Saved ids first, in that order. Items the map does not mention keep the endpoint order after them. */
export const orderItems = <T>(items: T[], idOf: (item: T) => string, saved: string[] | undefined): T[] => {
  if (!saved?.length) return items;
  const rank = new Map(saved.map((id, index) => [id, index]));
  const known: T[] = [];
  const unknown: T[] = [];
  for (const item of items) {
    const id = idOf(item);
    if (id && rank.has(id)) known.push(item);
    else unknown.push(item);
  }
  known.sort((a, b) => (rank.get(idOf(a)) ?? 0) - (rank.get(idOf(b)) ?? 0));
  return [...known, ...unknown];
};

export const applyOrder = <T>(items: T[], idOf: (item: T) => string, scope: string): T[] =>
  orderItems(items, idOf, readFile()[scope]);

/** Local order that also lives in component state, so a drag repaints without waiting for the next fetch. */
export const useOrderMap = () => {
  const [file, setFile] = useState(readFile);
  const apply = useCallback(
    <T>(items: T[], idOf: (item: T) => string, scope: string) => orderItems(items, idOf, file[scope]),
    [file]
  );
  const commit = useCallback((scope: string, ids: string[]) => {
    const next = ids.filter(Boolean);
    saveOrder(scope, next);
    setFile((current) => ({ ...current, [scope]: next }));
  }, []);
  return { apply, commit };
};

export const saveOrder = (scope: string, ids: string[]) => {
  const file = readFile();
  file[scope] = ids.filter(Boolean);
  writeFile(file);
};

export const moveItem = <T>(items: T[], from: number, to: number): T[] => {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

/** Move the pinned item to the front. Returns the same array when it is absent. */
export const pinFirst = <T>(items: T[], idOf: (item: T) => string, pinnedId: string): T[] => {
  if (!items.some((item) => idOf(item) === pinnedId)) return items;
  return [
    ...items.filter((item) => idOf(item) === pinnedId),
    ...items.filter((item) => idOf(item) !== pinnedId),
  ];
};

/**
 * Order to save for a list that gained new items: the pinned id, then the fresh
 * ones, then the ids already seen. Fresh ids keep the endpoint's order, which is
 * newest first, so a playlist created now lands at the top of the panel.
 */
export const orderFreshFirst = (ids: string[], pinnedId: string, fresh: string[]): string[] => [
  ...ids.filter((id) => id === pinnedId),
  ...ids.filter((id) => id !== pinnedId && fresh.includes(id)),
  ...ids.filter((id) => id !== pinnedId && !fresh.includes(id)),
];
