import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { PyBridge, type SearchResult } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";
import { useEdgeFade } from "@/components/ui/useEdgeFade";
import { useRecentSearches } from "../hooks/useRecentSearches";
import { isPlayable, searchHref, searchResultToTrack } from "../lib/searchTarget";
import { SearchRow } from "./SearchRow";

const DEBOUNCE_MS = 280;
const LIVE_LIMIT = 8;
// YouTube completes most two-letter prefixes usefully; below that the panel is
// recent searches and live results only.
const SUGGESTION_MIN_CHARS = 2;
// How long the exit transition runs before the sidebar unmounts the panel.
const CLOSE_ANIMATION_MS = 140;

/**
 * Search opens as one floating black panel at a fixed position in both nav
 * modes: to the right of the sidebar, with gaps at the left, the top and the
 * bottom, so it never reads as a plain black section. The input is its top
 * edge; suggestions and live results scroll below, recent searches show while
 * the box is empty. Enter opens the dedicated search page and closes the
 * panel. Escape or a click outside collapses it back to the icon.
 */
export const SidebarSearch = ({ query, onQueryChange, onClose }: { query: string; onQueryChange: (value: string) => void; onClose: () => void }) => {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const suggestionRequestIdRef = useRef(0);
  const [, navigate] = useLocation();
  const { recent, add, remove, clear } = useRecentSearches();
  const { playTracks } = usePlayer();

  const place = useCallback(() => {
    const panel = containerRef.current;
    if (!panel) return;
    const GAP = 8;
    // The sidebar box carries its own padding, which visually widens the left
    // gap beyond the 8px offset. Read it and give the top and the bottom the
    // same total, so all three gaps match.
    const sidebar = document.querySelector("[data-sidebar]") as HTMLElement | null;
    const sidebarPadding = sidebar ? parseFloat(getComputedStyle(sidebar).paddingRight) || 0 : 0;
    const edgeGap = GAP + sidebarPadding;
    const sidebarRect = sidebar?.getBoundingClientRect();
    const bar = document.querySelector("[data-player-bar]");
    // With a song playing the panel stops above the player bar; idle, the bar
    // is not in the tree and the panel runs to the window's bottom edge.
    const bottomLimit = bar ? bar.getBoundingClientRect().top : window.innerHeight;
    panel.style.top = `${edgeGap}px`;
    panel.style.height = `${Math.max(240, bottomLimit - edgeGap * 2)}px`;
    panel.style.left = `${sidebarRect ? sidebarRect.right + GAP : GAP}px`;
  }, []);

  useLayoutEffect(() => {
    const panel = containerRef.current;
    if (!panel) return;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  // The scroll area runs to the player bar, so its clipped edges fade instead
  // of cutting a row off mid-pixels.
  useEdgeFade(scrollRef, { top: true, bottom: true }, [query, suggestions.length, results.length, recent.length, loading]);

  // The panel animates out instead of vanishing: the first close request
  // starts the exit transition, and the sidebar's unmount follows it.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeWithAnimation = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(() => onClose(), CLOSE_ANIMATION_MS);
  }, [onClose]);

  // A click outside the panel collapses it back to the Search icon.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (containerRef.current?.contains(target as Node)) return;
      if (target instanceof Element && target.closest("[data-search-flyout]")) return;
      closeWithAnimation();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closeWithAnimation]);

  useEffect(() => {
    inputRef.current?.focus();
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

  // YouTube's own completions, read alongside the live results and kept apart
  // from them: a slow or failing suggestion call must not blank the results it
  // already has, and a suggestion that lands after the query moved on is
  // dropped by its request id. Typing is never awaited — the field renders the
  // parent's query either way.
  useEffect(() => {
    const text = query.trim();
    if (text.length < SUGGESTION_MIN_CHARS) {
      suggestionRequestIdRef.current += 1;
      setSuggestions([]);
      return;
    }
    const requestId = ++suggestionRequestIdRef.current;
    const timer = window.setTimeout(() => {
      void PyBridge.getSearchSuggestions(text).then((result) => {
        if (requestId !== suggestionRequestIdRef.current) return;
        setSuggestions(result.success ? result.data : []);
      });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      if (!text) return;
      add(text);
      navigate(`/search?q=${encodeURIComponent(text)}`);
      closeWithAnimation();
    },
    [add, navigate, closeWithAnimation],
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
      return;
    }
    const href = searchHref(result);
    if (href) navigate(href);
  };

  const text = query.trim();

  return createPortal(
    <div
      ref={containerRef}
      data-search-flyout=""
      style={{ width: 520 }}
      className={cn(
        "fixed z-[55] flex flex-col overflow-hidden rounded-2xl bg-black shadow-[0_10px_28px_rgb(0_0_0/0.65)]",
        "transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
        closing ? "scale-95 opacity-0" : "starting:scale-95 starting:opacity-0",
      )}
    >
      <div className="p-1.5">
        <div className="flex items-center gap-2 rounded-lg bg-primary-light px-3 py-1.5 transition-[box-shadow] focus-within:ring-2 focus-within:ring-white/15">
          <span className="icon-[solar--magnifer-linear] shrink-0 text-lg text-primary-dark" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(query);
              else if (event.key === "Escape") {
                if (query) onQueryChange("");
                else closeWithAnimation();
              }
            }}
            placeholder="Search"
            aria-label="Search"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-primary-dark"
          />
          {/* With a term in the box the X clears it, the same as Escape; with an
              empty box it closes search, so both ways out stay reachable. */}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => (query ? onQueryChange("") : closeWithAnimation())}
            aria-label={query ? "Clear search" : "Close search"}
            className="shrink-0 cursor-pointer text-primary-dark transition-colors hover:text-primary"
          >
            <span className="icon-[solar--close-linear] text-lg" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="scrollbar-thin min-h-0 flex-1 flex-col overflow-y-auto border-t border-white/5"
      >
        {text ? (
          <>
            {suggestions.length > 0 && (
              <div className="mb-1 border-b border-white/5 pb-1">
                <p className="px-2.5 pt-1.5 pb-1 text-xs font-medium tracking-wide text-primary-dark uppercase">
                  Suggestions
                </p>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => submit(suggestion)}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-primary transition-colors hover:bg-white/10"
                  >
                    <span className="icon-[solar--magnifer-linear] shrink-0 text-lg text-primary-dark" />
                    <span className="min-w-0 truncate">{suggestion}</span>
                  </button>
                ))}
              </div>
            )}
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
          </>
        ) : recent.length > 0 ? (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 pt-2.5 pb-1.5">
              <span className="text-xs font-medium tracking-wide text-primary-dark uppercase">Recent searches</span>
              <button
                type="button"
                onClick={clear}
                className="cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium text-primary-dark transition-colors hover:bg-white/10 hover:text-primary"
              >
                Clear
              </button>
            </div>
            <div>
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
                    <span className="icon-[solar--close-linear] text-lg" />
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="px-3 py-6 text-center text-sm text-primary-dark">Type to search</p>
        )}
      </div>
    </div>,
    document.body,
  );
};
