import { useCallback, useEffect, useRef, useState } from "react";
import { PyBridge, showCachedThenRefresh } from "@/lib/api";
import type { ExploreSection } from "@/lib/api/types";

export type ExploreData = {
  /** Null until the first answer lands, so a loader can show; [] is an empty feed. */
  sections: ExploreSection[] | null;
  error: string | null;
  /** Fetch again, from the network rather than the disk cache. */
  reload: () => void;
};

/**
 * The Explore feed. Python caches the whole feed for a week and marks a cached
 * one `fromCache`, so the page paints from disk first and swaps in a fresh read
 * behind it.
 *
 * An answer is dropped when a newer read has started: the id is captured before
 * the call and compared at resolve time, because a boolean flag cleared by an
 * effect can be re-armed before the pending answer lands.
 */
export const useExplore = (): ExploreData => {
  const [sections, setSections] = useState<ExploreSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const requestIdRef = useRef(0);
  // A retry asked for by the error card is a real fetch; the first mount reads
  // the disk cache and lets its age decide.
  const forceNextRef = useRef(false);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const force = forceNextRef.current;
    forceNextRef.current = false;
    // A retry has to be able to take the error down again, or the error card
    // outlives the sections the retry fetched and hides them.
    setError(null);
    void showCachedThenRefresh(
      (forceRefresh) => PyBridge.getExplore(forceRefresh),
      (data) => setSections(data.sections),
      () => requestId === requestIdRef.current,
      { force },
    ).then((result) => {
      if (result && !result.success && requestId === requestIdRef.current) setError(result.error.message);
    });
    return () => {
      requestIdRef.current += 1;
    };
  }, [revision]);

  const reload = useCallback(() => {
    forceNextRef.current = true;
    setRevision((value) => value + 1);
  }, []);

  return { sections, error, reload };
};
