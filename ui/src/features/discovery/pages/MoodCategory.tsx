import { Link, useParams } from "wouter";
import { Empty, LoadError, Loading } from "../components/States";
import { PlaylistGrid } from "../components/PlaylistGrid";
import { useMoodCategories } from "../hooks/useMoodCategories";
import { useMoodPlaylists } from "../hooks/useMoodPlaylists";

/**
 * `decodeURIComponent` for the tile's percent-encoded token. wouter's own
 * `decodeURI` leaves reserved escapes (a `+`, `=`, or `/` in a params token)
 * encoded, so without this the token reaches Python wrong. A hand-edited hash
 * with a malformed escape falls back to the raw value instead of throwing.
 */
const decodeParam = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * One mood or genre: the playlists YouTube Music fills it with.
 *
 * A category is addressed by the `params` token its tile carries, which is what
 * `/moods/:params` holds. The title is looked up in the (cached) categories
 * payload, so a reload on this route keeps its heading without a second read.
 */
export const MoodCategory = () => {
  const { params = "" } = useParams<{ params: string }>();
  const token = decodeParam(params);
  const { sections, reload: reloadCategories } = useMoodCategories();
  const { playlists, error, load } = useMoodPlaylists(token);

  const category = (sections ?? [])
    .flatMap((section) => section.categories)
    .find((entry) => entry.params === token);

  const retry = () => {
    load(true);
    reloadCategories();
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6">
          <Link
            href="/moods"
            className="inline-flex cursor-pointer items-center gap-1 text-sm text-primary-dark hover:text-primary"
          >
            <span className="icon-[solar--alt-arrow-left-linear]" />
            Moods &amp; genres
          </Link>
          <h1 className="mt-2 text-2xl font-bold">{category?.title ?? "Moods & genres"}</h1>

          {/* Rows outrank an error: a stale one must never cover playlists that
              did land. With nothing fetched, the error still speaks first. */}
          {playlists !== null && playlists.length > 0 ? (
            <div className="mt-4">
              <PlaylistGrid playlists={playlists} />
            </div>
          ) : error ? (
            <LoadError message={error} onRetry={retry} />
          ) : playlists === null ? (
            <Loading label="Loading playlists" />
          ) : (
            <Empty message="YouTube Music has no playlists in this category." onRetry={retry} />
          )}
        </div>
      </div>
    </div>
  );
};
