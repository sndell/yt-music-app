import { useCallback, useEffect, useRef, useState } from "react";
import { PyBridge, showCachedThenRefresh } from "@/lib/api";
import type { MoodSection } from "@/lib/api/types";

export type MoodCategoriesData = {
  /** Null until the first answer lands, so a loader can show; [] is an empty page. */
  sections: MoodSection[] | null;
  error: string | null;
  /** Fetch again, from the network rather than the disk cache. */
  reload: () => void;
};

/**
 * The Moods & genres sections.
 *
 * Python caches the payload for a week and marks a cached one `fromCache`, so
 * the page paints from disk first and swaps in a fresh read behind it.
 */
export const useMoodCategories = (): MoodCategoriesData => {
  const [sections, setSections] = useState<MoodSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const liveRef = useRef(true);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setError(null);
    void showCachedThenRefresh(
      (forceRefresh) => PyBridge.getMoodCategories(forceRefresh),
      (data) => setSections(data.sections),
      () => liveRef.current,
    ).then((result) => {
      if (result && !result.success) setError(result.error.message);
    });
  }, [revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  return { sections, error, reload };
};
