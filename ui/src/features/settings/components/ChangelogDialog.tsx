import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/ui/Modal";
import { PyBridge } from "@/lib/api";
import type { UpdateRelease } from "@/lib/api/types";
import { cn } from "@/util/cn";

/** "27 Oct 2026", or nothing when GitHub sent no date. */
const releaseDate = (iso: string) => {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/**
 * Every published release, newest first: a sentence on what the release was
 * for, then each change with the notes' own explanation under it. Rows stay
 * folded so the whole history fits in one screen; the running release and the
 * newest one open on their own, because those are what a reader came for.
 *
 * The explanation is the point. "Cache-first feeds" or "True shuffle" alone
 * says nothing to someone who has not read the code.
 */
export const ChangelogDialog = ({ current, onClose }: { current: string; onClose: () => void }) => {
  const [releases, setReleases] = useState<UpdateRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setReleases(null);
    setError(null);
    void (async () => {
      const result = await PyBridge.getUpdateHistory();
      if (cancelled) return;
      if (!result.success) {
        setReleases([]);
        setError(result.error.message);
        return;
      }
      const list = result.data.releases;
      setReleases(list);
      setError(result.data.error || null);
      // The running release is the one a reader is most likely after; otherwise
      // the newest one.
      const open = list.filter((release) => release.version === current).map((release) => release.version);
      setExpanded(open.length > 0 ? open : list.slice(0, 1).map((release) => release.version));
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, current]);

  const retry = () => {
    setExpanded([]);
    setAttempt((previous) => previous + 1);
  };

  const toggle = (version: string) => {
    setExpanded((previous) =>
      previous.includes(version) ? previous.filter((item) => item !== version) : [...previous, version],
    );
  };

  return createPortal(
    <Modal
      onPointerDownOutside={onClose}
      cardClassName="flex max-h-[min(85vh,38rem)] w-full max-w-lg flex-col p-0"
    >
      <div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3">
        <div>
          <h2 className="text-lg font-bold">What&apos;s new</h2>
          <p className="mt-0.5 text-sm text-primary-dark">Every version, in plain words, newest first.</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mt-1 -mr-1 grid size-8 shrink-0 cursor-pointer place-items-center rounded-full text-primary-dark transition-colors hover:bg-white/10 hover:text-primary"
        >
          <span className="icon-[solar--close-linear] text-lg" />
        </button>
      </div>

      <div className="scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {releases === null && <p className="py-8 text-center text-sm text-primary-dark">Loading releases...</p>}

        {releases !== null && error && (
          <div className="py-6 text-center">
            <p className="text-sm text-primary-dark">Couldn&apos;t load the release notes.</p>
            <p className="mt-1 text-sm text-red-500">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 cursor-pointer rounded-full border border-white/20 px-3.5 py-1.5 text-sm transition-colors hover:bg-white/10"
            >
              Try again
            </button>
          </div>
        )}

        {releases !== null && !error && releases.length === 0 && (
          <p className="py-8 text-center text-sm text-primary-dark">No releases published yet.</p>
        )}

        {releases !== null &&
          !error &&
          releases.map((release) => {
            const open = expanded.includes(release.version);
            const panelId = `release-${release.version}`;
            const main = release.changes.filter((change) => !change.minor);
            const minor = release.changes.filter((change) => change.minor);
            return (
              <div key={release.version} className="border-t border-white/5 first:border-t-0">
                <button
                  type="button"
                  onClick={() => toggle(release.version)}
                  aria-expanded={open}
                  aria-controls={panelId}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg py-2.5 text-left transition-colors hover:text-white"
                >
                  <span className="text-sm font-semibold tabular-nums">{release.version}</span>
                  {release.version === current && (
                    <span className="rounded-full bg-white/10 px-1.5 py-px text-[10px] font-medium tracking-wide text-primary-dark uppercase">
                      installed
                    </span>
                  )}
                  <span className="ml-auto text-xs tabular-nums text-primary-dark">{releaseDate(release.date)}</span>
                  <span
                    className={cn(
                      "icon-[solar--alt-arrow-down-linear] text-base text-primary-dark transition-transform duration-200",
                      open && "rotate-180",
                    )}
                  />
                </button>
                {open && (
                  <div id={panelId} className="mb-4 space-y-3">
                    {release.summary && <p className="text-sm leading-snug text-primary-dark">{release.summary}</p>}

                    {main.length > 0 && (
                      <ul className="space-y-2.5">
                        {main.map((change, index) => (
                          <li key={`${release.version}-change-${index}`} className="flex gap-2.5">
                            <span className="mt-[0.55em] size-1 shrink-0 rounded-full bg-white/25" />
                            <div className="min-w-0">
                              <p className="text-sm leading-snug font-medium text-primary">{change.title}</p>
                              {change.detail && (
                                <p className="mt-0.5 text-sm leading-snug text-primary-dark">{change.detail}</p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}

                    {minor.length > 0 && (
                      <div>
                        <p className="mb-1 text-[11px] font-medium tracking-wide text-primary-dark uppercase">
                          Also included
                        </p>
                        <ul className="space-y-1">
                          {minor.map((change, index) => (
                            <li
                              key={`${release.version}-minor-${index}`}
                              className="text-sm leading-snug text-primary-dark"
                            >
                              {change.title}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {release.changes.length === 0 && !release.summary && (
                      <p className="text-sm text-primary-dark/70">No notes published for this release.</p>
                    )}

                    {release.url && (
                      <a
                        href={release.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex cursor-pointer items-center gap-1 text-sm text-primary-dark transition-colors hover:text-white"
                      >
                        <span className="icon-[solar--link-minimalistic-2-linear] text-base" />
                        View on GitHub
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </Modal>,
    document.body,
  );
};
