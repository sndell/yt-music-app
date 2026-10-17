import { useCallback, useEffect, useRef, useState } from "react";
import { PyBridge, showCachedThenRefresh } from "@/lib/api";
import type { Charts } from "@/lib/api/types";

export type ChartsData = {
  /** Null until the first answer lands, so a loader can show; an empty payload is a page. */
  charts: Charts | null;
  error: string | null;
  load: (forceRefresh?: boolean) => void;
};

/**
 * One country's charts, keyed by the country code the route carries. Python
 * caches each country for a day, so a second open paints from disk and
 * refreshes behind it.
 */
export const useCharts = (country: string): ChartsData => {
  const [charts, setCharts] = useState<Charts | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A country switch replaces the one on screen, so an answer for the country
  // that just left is dropped instead of painted over the new one. The counter
  // is read at resolve time; a boolean flag cannot guard this, because the
  // cleanup that cleared it ran before the new country's effect set it back,
  // and both happen in the commit the old request is still in flight across.
  const requestIdRef = useRef(0);

  // A new country starts empty, and bumping here retires an in-flight read for
  // the country that just left even when the new one triggers no read.
  useEffect(() => {
    requestIdRef.current += 1;
    setCharts(null);
    setError(null);
  }, [country]);

  const load = useCallback(
    (forceRefresh = false) => {
      if (!country) return;
      const requestId = ++requestIdRef.current;
      // A retry has to be able to take the error down again, or the error card
      // outlives the charts the retry fetched and hides them.
      setError(null);
      if (forceRefresh) {
        void PyBridge.getCharts(country, true).then((result) => {
          if (requestId !== requestIdRef.current) return;
          if (result.success) setCharts(result.data);
          else setError(result.error.message);
        });
        return;
      }
      void showCachedThenRefresh(
        (refresh) => PyBridge.getCharts(country, refresh),
        (data) => {
          if (requestId === requestIdRef.current) setCharts(data);
        },
        () => requestId === requestIdRef.current,
      ).then((result) => {
        if (result && !result.success && requestId === requestIdRef.current) setError(result.error.message);
      });
    },
    [country],
  );

  useEffect(() => {
    load();
  }, [load]);

  return { charts, error, load };
};
