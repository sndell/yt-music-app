import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { PyBridge, type SearchResult } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";
import { useRecentSearches } from "../hooks/useRecentSearches";
import { isPlayable, searchHref, searchResultToTrack } from "../lib/searchTarget";
import { SearchRow } from "./SearchRow";

const DEBOUNCE_MS = 280;
const LIVE_LIMIT = 8;

/** The floating panel. It owns its ref so it can place itself the moment it mounts. */
const SearchFlyout = ({ anchor, children }: { anchor: DOMRect; children: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const place = () => {
      const rect = panel.getBoundingClientRect();
      let left = anchor.right + 8;
      if (left + rect.width > window.innerWidth - 8) left = Math.max(8, anchor.left - 8 - rect.width);
      let top = anchor.top;
      if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - rect.height);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [anchor]);

  return (
    <div
      ref={ref}
      data-search-flyout=""
      onMouseDown={(event) => event.preventDefault()}
      style={{ width: 384 }}
      className={cn(
        "fixed z-[55] flex max-h-[min(70vh,560px)] flex-col overflow-hidden rounded-2xl bg-black shadow-[0_14px_36px_rgb(0_0_0/0.7)]",
        "transition-[opacity,translate,scale] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "starting:-translate-x-1 starting:scale-95 starting:opacity-0",
      )}
    >
      {children}
    </div>
  );
};

/**
 * The sidebar's search field. Clicking the Search nav item swaps that section
 * for this field; a flyout opens to its right with recent terms and live
 * results. Enter opens the dedicated search page.
 */
export const SidebarSearch = ({ onClose }: { onClose: () => void }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const [, navigate] = useLocation();
  const { recent, add, remove, clear } = useRecentSearches();
  const { playTracks } = usePlayer();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => setAnchor(container.getBoundingClientRect());
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, []);

  const run = useCallback((text: string) => {
    if (!text) {
      requestIdRef.current += 1;
      setResults([]);
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    void PyBridge.search(text, "", "", LIVE_LIMIT).then((result) => {
      if (requestId !== requestIdRef.current) return;
      setResults(result.success ? result.data : []);
      setLoading(false);
    });
  }, []);

  // Live results while typing, debounced and dropped when the query changes.
  useEffect(() => {
    const timer = window.setTimeout(() => run(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, run]);

  // A click outside the field or its flyout closes search and restores the nav.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (containerRef.current?.contains(target as Node)) return;
      if (target instanceof Element && target.closest("[data-search-flyout]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      if (!text) return;
      add(text);
      navigate(`/search?q=${encodeURIComponent(text)}`);
      onClose();
    },
    [add, navigate, onClose],
  );

  const openResult = (result: SearchResult) => {
    add(query.trim());
    if (isPlayable(result)) {
      const track = searchResultToTrack(result);
      const rest = results
        .filter(isPlayable)
        .map(searchResultToTrack)
        .filter((item) => item.videoId !== track.videoId);
      playTracks([track, ...rest]);
      onClose();
      return;
    }
    const href = searchHref(result);
    if (href) {
      navigate(href);
      onClose();
    }
  };

  const text = query.trim();
  const showFlyout = Boolean(anchor) && (text.length > 0 || recent.length > 0);

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2 rounded-lg bg-primary-light px-3 py-1.5 transition-[box-shadow] focus-within:ring-2 focus-within:ring-white/15">
        <span className="icon-[solar--magnifer-linear] shrink-0 text-lg text-primary-dark" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(query);
            else if (event.key === "Escape") {
              if (query) setQuery("");
              else onClose();
            }
          }}
          placeholder="Search"
          aria-label="Search"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-primary-dark"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="shrink-0 cursor-pointer text-primary-dark transition-colors hover:text-primary"
        >
          <span className="icon-[solar--close-circle-linear] text-lg" />
        </button>
      </div>

      {showFlyout &&
        anchor &&
        createPortal(
          <SearchFlyout anchor={anchor}>
            {text ? (
              <>
                <button
                  type="button"
                  onClick={() => submit(text)}
                  className="flex shrink-0 items-center gap-2.5 border-b border-white/5 px-3.5 py-2.5 text-left text-sm text-primary transition-colors hover:bg-white/10"
                >
                  <span className="icon-[solar--magnifer-linear] shrink-0 text-lg text-primary-dark" />
                  <span className="min-w-0 truncate">
                    Search for <span className="font-medium">“{text}”</span>
                  </span>
                </button>
                <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1">
                  {loading && results.length === 0 ? (
                    <div className="grid place-items-center py-6" role="status">
                      <span className="icon-[solar--loader-linear] animate-spin text-xl text-primary-dark" />
                    </div>
                  ) : results.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-primary-dark">No results</p>
                  ) : (
                    results.map((result, index) => (
                      <SearchRow
                        key={`${result.kind}-${result.videoId ?? result.browseId ?? index}`}
                        result={result}
                        dense
                        onSelect={() => openResult(result)}
                      />
                    ))
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/5 px-3.5 pt-2.5 pb-1.5">
                  <span className="text-xs font-medium tracking-wide text-primary-dark uppercase">Recent searches</span>
                  <button
                    type="button"
                    onClick={clear}
                    className="cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium text-primary-dark transition-colors hover:bg-white/10 hover:text-primary"
                  >
                    Clear
                  </button>
                </div>
                <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1">
                  {recent.map((term) => (
                    <div key={term} className="group flex items-center gap-1 rounded-lg pr-1 hover:bg-white/10">
                      <button
                        type="button"
                        onClick={() => submit(term)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-2.5 py-2 text-left text-sm text-primary"
                      >
                        <span className="icon-[solar--history-linear] shrink-0 text-lg text-primary-dark" />
                        <span className="min-w-0 truncate">{term}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(term)}
                        aria-label={`Remove ${term}`}
                        className="shrink-0 cursor-pointer rounded-full p-1 text-primary-dark opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary"
                      >
                        <span className="icon-[solar--close-circle-linear] text-lg" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </SearchFlyout>,
          document.body,
        )}
    </div>
  );
};
