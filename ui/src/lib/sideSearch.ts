import { useEffect, useState } from "react";

/**
 * Sidebar search state, held in a module store. Search opens as one floating
 * panel at a fixed position: beside the sidebar, with gaps all around, in both
 * nav modes. The query outlives the field, so closing search and reopening it
 * shows the last term.
 */
export type SideSearchState = { open: boolean; query: string };

const listeners = new Set<(value: SideSearchState) => void>();
let state: SideSearchState = { open: false, query: "" };

const publish = () => {
  for (const listener of listeners) listener(state);
};

export const openSideSearch = () => {
  state = { ...state, open: true };
  publish();
};

export const closeSideSearch = () => {
  state = { ...state, open: false };
  publish();
};

export const setSideSearchQuery = (query: string) => {
  if (state.query === query) return;
  state = { ...state, query };
  publish();
};

export const useSideSearch = () => {
  const [value, setValue] = useState(state);
  useEffect(() => {
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
};
